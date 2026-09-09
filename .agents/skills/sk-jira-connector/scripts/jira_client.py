#!/usr/bin/env python3
"""Jira Cloud REST API v3 client — Basic auth, lean fields, pagination, 429 backoff.

Why a direct REST client (and not the Atlassian MCP): a bundled client travels with the
skill, runs in subagents and headless/cron contexts, needs no per-session interactive
OAuth, and is identical across clones and CLIs. It mirrors confluence_client.py in the
sibling skill so both Atlassian skills behave the same way.

The single most important design choice here is that every list query sends an explicit
`fields` allow-list. Jira's default response embeds the full project object, every
rendered field, and ADF bodies on *each* issue — a 50-issue board dump balloons past
100k characters. By naming only the fields a view needs, list payloads stay small and
predictable, which is exactly the failure we are engineering around.
"""

import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class JiraError(Exception):
    """An API or transport error talking to Jira."""


# Compact default field set for list/search views. Drill-down adds description/comment.
LIST_FIELDS = [
    "summary",
    "status",
    "issuetype",
    "priority",
    "assignee",
    "updated",
    "parent",
]


class JiraClient:
    def __init__(self, jira_url, email, api_token, timeout=30):
        if not jira_url:
            raise JiraError("jira_url is required")
        self.base = jira_url.rstrip("/")
        if ".atlassian.net" not in self.base:
            # Cloud-only: Server/DC uses different auth and API shapes.
            raise JiraError(
                f"jira_url '{self.base}' is not a Jira Cloud URL (*.atlassian.net). "
                "This skill supports Jira Cloud only."
            )
        self.api = f"{self.base}/rest/api/3"
        self.timeout = timeout
        token = f"{email}:{api_token}".encode("utf-8")
        self._auth = "Basic " + base64.b64encode(token).decode("ascii")

    # -- transport ---------------------------------------------------------------

    def _request(self, method, url, body=None, _retries=4):
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", self._auth)
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")

        for attempt in range(_retries + 1):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read().decode("utf-8")
                    return json.loads(raw) if raw else {}
            except urllib.error.HTTPError as e:
                detail = self._error_detail(e)
                if e.code == 429 and attempt < _retries:
                    # Honour Retry-After, else exponential backoff.
                    wait = self._retry_after(e, attempt)
                    time.sleep(wait)
                    continue
                if e.code == 401:
                    raise JiraError(
                        "Authentication failed (HTTP 401): check jira_email and api_token."
                    )
                if e.code == 403:
                    raise JiraError(
                        f"Authorization failed (HTTP 403): the API user lacks permission. {detail}"
                    )
                if e.code == 404:
                    raise JiraError(f"Not found (HTTP 404): {detail}")
                raise JiraError(f"HTTP {e.code} from Jira: {detail}")
            except urllib.error.URLError as e:
                if attempt < _retries:
                    time.sleep(2 ** attempt)
                    continue
                raise JiraError(f"network error talking to Jira: {e.reason}")
        raise JiraError("exhausted retries talking to Jira")

    @staticmethod
    def _retry_after(e, attempt):
        ra = e.headers.get("Retry-After") if e.headers else None
        if ra:
            try:
                return min(float(ra), 30.0)
            except ValueError:
                pass
        return min(2 ** attempt, 30.0)

    @staticmethod
    def _error_detail(e):
        try:
            payload = json.loads(e.read().decode("utf-8"))
        except Exception:
            return e.reason or "unknown error"
        msgs = payload.get("errorMessages") or []
        errs = payload.get("errors") or {}
        parts = list(msgs) + [f"{k}: {v}" for k, v in errs.items()]
        return "; ".join(parts) if parts else (e.reason or "unknown error")

    # -- reads -------------------------------------------------------------------

    def myself(self):
        """Return the API user's account (accountId, displayName, emailAddress)."""
        return self._request("GET", f"{self.api}/myself")

    def search(self, jql, fields=None, max_results=50, max_total=200):
        """Run a JQL search, auto-paginating up to ``max_total`` issues.

        Uses the enhanced /search/jql endpoint (token-paginated). Sends an explicit
        ``fields`` allow-list so payloads stay compact. Returns a list of raw issue
        dicts (each with the requested fields only).
        """
        fields = fields or LIST_FIELDS
        url = f"{self.api}/search/jql"
        collected = []
        next_token = None
        while len(collected) < max_total:
            body = {
                "jql": jql,
                "maxResults": min(max_results, max_total - len(collected)),
                "fields": fields,
            }
            if next_token:
                body["nextPageToken"] = next_token
            page = self._request("POST", url, body)
            issues = page.get("issues", []) or []
            collected.extend(issues)
            if page.get("isLast", True) or not page.get("nextPageToken"):
                break
            next_token = page.get("nextPageToken")
        return collected

    def get_issue(self, key, fields=None, expand=None):
        """Fetch one issue. Defaults to a rich field set incl. description."""
        params = {}
        if fields:
            params["fields"] = ",".join(fields)
        else:
            params["fields"] = "*all"
        if expand:
            params["expand"] = expand
        qs = urllib.parse.urlencode(params)
        return self._request("GET", f"{self.api}/issue/{key}?{qs}")

    def list_attachments(self, key):
        """Attachment metadata for an issue: id, filename, size, mimeType, author, created, url.

        Read from the issue's own `attachment` field — one request, no extra endpoint — so listing
        every attachment across a feature's cards costs one call per card, not one per file.
        """
        issue = self._request("GET", f"{self.api}/issue/{key}?fields=attachment")
        out = []
        for a in ((issue.get("fields") or {}).get("attachment") or []):
            out.append({
                "id": a.get("id"),
                "filename": a.get("filename"),
                "size": a.get("size"),
                "mime_type": a.get("mimeType"),
                "created": a.get("created"),
                "author": ((a.get("author") or {}).get("displayName")),
                "content_url": a.get("content"),
            })
        return out

    def download_attachment(self, content_url, dest_path):
        """Stream one attachment to disk. Returns the byte count written.

        The content URL is an authenticated redirect to blob storage; urllib follows it while
        keeping our Authorization header, which is what the API expects. Written to a .part file
        and renamed on success so an interrupted pull never leaves a truncated file looking whole.
        """
        req = urllib.request.Request(content_url, method="GET")
        req.add_header("Authorization", self._auth)
        req.add_header("Accept", "*/*")
        tmp = dest_path + ".part"
        os.makedirs(os.path.dirname(os.path.abspath(dest_path)) or ".", exist_ok=True)
        try:
            with urllib.request.urlopen(req, timeout=max(self.timeout, 120)) as resp, \
                    open(tmp, "wb") as fh:
                written = 0
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    fh.write(chunk)
                    written += len(chunk)
        except urllib.error.HTTPError as e:
            raise JiraError(f"HTTP {e.code} downloading attachment: {self._error_detail(e)}")
        except urllib.error.URLError as e:
            raise JiraError(f"network error downloading attachment: {e.reason}")
        os.replace(tmp, dest_path)
        return written

    def get_comments(self, key, max_results=50):
        """Fetch comments for an issue (newest-ordered)."""
        url = f"{self.api}/issue/{key}/comment?maxResults={max_results}&orderBy=-created"
        return self._request("GET", url).get("comments", []) or []

    def get_transitions(self, key):
        """Available workflow transitions for an issue (id + target status name)."""
        url = f"{self.api}/issue/{key}/transitions"
        return self._request("GET", url).get("transitions", []) or []

    def list_projects(self, query=None, max_results=50):
        params = {"maxResults": max_results}
        if query:
            params["query"] = query
        qs = urllib.parse.urlencode(params)
        return self._request("GET", f"{self.api}/project/search?{qs}").get("values", []) or []

    # -- writes (outward-facing — callers gate per the safety contract) ----------

    def add_comment(self, key, adf_body):
        """Add a comment (ADF body) to an issue. Returns the created comment."""
        return self._request("POST", f"{self.api}/issue/{key}/comment", {"body": adf_body})

    def update_comment(self, key, comment_id, adf_body):
        """Replace an existing comment's body (ADF). Returns the updated comment.

        This OVERWRITES text somebody wrote — there is no undo and no version history
        surfaced by the API. The CLI gates it behind --yes for that reason; the client
        itself stays a thin transport, like every other method here.
        """
        return self._request(
            "PUT", f"{self.api}/issue/{key}/comment/{comment_id}", {"body": adf_body}
        )

    def add_attachment(self, key, filepaths):
        """Upload one or more files as attachments to an issue.

        The attachment endpoint is the one place this API is NOT JSON: it wants a
        ``multipart/form-data`` POST with each file in a form part named ``file``, and it
        rejects the request unless the XSRF opt-out header ``X-Atlassian-Token: no-check``
        is present. We build the multipart body by hand (zero-dependency — no ``requests``)
        and send it through a dedicated path rather than ``_request`` (which is JSON-only).

        ``filepaths`` is a path or a list of paths. Returns the list of created attachment
        objects (each ``{id, filename, size, ...}``).
        """
        if isinstance(filepaths, (str, bytes, os.PathLike)):
            filepaths = [filepaths]
        filepaths = [str(p) for p in (filepaths or [])]
        if not filepaths:
            raise JiraError("no attachment file provided")

        boundary = "----sidekicks" + uuid.uuid4().hex
        crlf = b"\r\n"
        body = bytearray()
        for path in filepaths:
            if not os.path.isfile(path):
                raise JiraError(f"attachment not found (not a file): {path}")
            with open(path, "rb") as fh:
                content = fh.read()
            # Guard the header against a filename that contains a quote/newline.
            filename = os.path.basename(path).replace('"', "").replace("\r", "").replace("\n", "")
            body += b"--" + boundary.encode("ascii") + crlf
            body += (
                f'Content-Disposition: form-data; name="file"; filename="{filename}"'
            ).encode("utf-8") + crlf
            body += b"Content-Type: application/octet-stream" + crlf + crlf
            body += content + crlf
        body += b"--" + boundary.encode("ascii") + b"--" + crlf

        url = f"{self.api}/issue/{key}/attachments"
        req = urllib.request.Request(url, data=bytes(body), method="POST")
        req.add_header("Authorization", self._auth)
        req.add_header("Accept", "application/json")
        req.add_header("X-Atlassian-Token", "no-check")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        # Attachments can be large — give the upload a longer floor than the JSON default.
        try:
            with urllib.request.urlopen(req, timeout=max(self.timeout, 120)) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            detail = self._error_detail(e)
            if e.code == 413:
                raise JiraError(
                    f"attachment too large for {key} (HTTP 413): exceeds the Jira upload limit. {detail}"
                )
            raise JiraError(f"HTTP {e.code} uploading attachment to {key}: {detail}")
        except urllib.error.URLError as e:
            raise JiraError(f"network error uploading attachment to {key}: {e.reason}")

    def transition_issue(self, key, transition_id):
        """Move an issue through a workflow transition. Returns {} on success (204)."""
        body = {"transition": {"id": str(transition_id)}}
        return self._request("POST", f"{self.api}/issue/{key}/transitions", body)

    def edit_issue(self, key, fields):
        """Update issue fields (PUT). ``fields`` is a Jira field map. Returns {} (204)."""
        return self._request("PUT", f"{self.api}/issue/{key}", {"fields": fields})

    def create_issue(self, fields):
        """Create an issue. ``fields`` must include project, issuetype, summary.

        Returns the created issue stub ({id, key, self}).
        """
        return self._request("POST", f"{self.api}/issue", {"fields": fields})

    def delete_issue(self, key, delete_subtasks=False):
        """Delete an issue (irreversible). Returns {} on success (204)."""
        sub = "true" if delete_subtasks else "false"
        return self._request("DELETE", f"{self.api}/issue/{key}?deleteSubtasks={sub}")

    def list_issue_link_types(self):
        """The link types this Jira defines (Blocks, Relates, etc.). Each entry is
        ``{id, name, inward, outward}`` — the inward/outward strings are how the type
        reads in each direction (e.g. Blocks → inward 'is blocked by', outward 'blocks')."""
        return self._request("GET", f"{self.api}/issueLinkType").get("issueLinkTypes", []) or []

    def create_issue_link(self, link_type, inward_key, outward_key):
        """Link two issues. The Jira model is directional: the ``outward`` issue holds the
        outward side of the type and the ``inward`` issue the inward side. For a Blocks link,
        ``outward_key`` blocks ``inward_key`` (i.e. inward 'is blocked by' outward). Returns
        {} on success (201)."""
        body = {"type": {"name": link_type},
                "inwardIssue": {"key": inward_key},
                "outwardIssue": {"key": outward_key}}
        return self._request("POST", f"{self.api}/issueLink", body)
