"""JiraClient.add_attachment — verify the hand-built multipart request.

The attachment path is the one place this client does NOT speak JSON: it builds a
multipart/form-data body by hand and must send the XSRF opt-out header. These tests
capture the urllib Request instead of hitting the network.
"""
import io
import json
import urllib.error

import pytest

from jira_client import JiraClient, JiraError


def _client():
    return JiraClient("https://x.atlassian.net", "e@x.io", "tok")


class _FakeResp:
    def __init__(self, payload):
        self._raw = json.dumps(payload).encode("utf-8")

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_add_attachment_builds_multipart(monkeypatch, tmp_path):
    f = tmp_path / "report.md"
    f.write_text("# root cause\nnull tenant on the AWS-TH path\n")

    captured = {}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        captured["headers"] = {k.lower(): v for k, v in req.header_items()}
        captured["body"] = req.data
        return _FakeResp([{"id": "10000", "filename": "report.md", "size": 42}])

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)

    out = _client().add_attachment("A-1", str(f))
    assert out[0]["filename"] == "report.md"
    assert captured["method"] == "POST"
    assert captured["url"].endswith("/issue/A-1/attachments")
    # The XSRF opt-out header is mandatory or Jira 403s the upload.
    assert captured["headers"]["x-atlassian-token"] == "no-check"
    assert captured["headers"]["content-type"].startswith("multipart/form-data; boundary=")
    body = captured["body"]
    assert b'name="file"; filename="report.md"' in body
    assert b"null tenant on the AWS-TH path" in body


def test_add_attachment_multiple_files_one_request(monkeypatch, tmp_path):
    a = tmp_path / "a.csv"; a.write_text("col\n1\n")
    b = tmp_path / "b.md"; b.write_text("notes\n")
    calls = {"n": 0}

    def fake_urlopen(req, timeout=None):
        calls["n"] += 1
        calls["body"] = req.data
        return _FakeResp([{"id": "1", "filename": "a.csv"}, {"id": "2", "filename": "b.md"}])

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    out = _client().add_attachment("A-1", [str(a), str(b)])
    assert calls["n"] == 1  # both files ride one multipart request
    assert len(out) == 2
    assert b'filename="a.csv"' in calls["body"]
    assert b'filename="b.md"' in calls["body"]


def test_add_attachment_missing_file_errors(tmp_path):
    with pytest.raises(JiraError):
        _client().add_attachment("A-1", str(tmp_path / "nope.md"))


def test_add_attachment_no_files_errors():
    with pytest.raises(JiraError):
        _client().add_attachment("A-1", [])


def test_add_attachment_413_is_friendly(monkeypatch, tmp_path):
    f = tmp_path / "big.bin"; f.write_bytes(b"x" * 10)

    def fake_urlopen(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 413, "Payload Too Large", {}, io.BytesIO(b"{}"))

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    with pytest.raises(JiraError) as ei:
        _client().add_attachment("A-1", str(f))
    assert "too large" in str(ei.value).lower()


def test_update_comment_puts_adf_body(monkeypatch):
    """The comment-edit transport: PUT the ADF document at the comment's own URL.

    First test in this file to go through the JSON `_request` path (the rest cover the
    hand-built multipart attachment upload), so it also pins that `_request` serializes
    the body and sets the JSON content type.
    """
    captured = {}
    doc = {"type": "doc", "version": 1,
           "content": [{"type": "paragraph", "content": [{"type": "text", "text": "fixed"}]}]}

    def fake_urlopen(req, timeout=None):
        captured["url"] = req.full_url
        captured["method"] = req.get_method()
        captured["headers"] = {k.lower(): v for k, v in req.header_items()}
        captured["body"] = req.data
        return _FakeResp({"id": "42", "body": doc})

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    out = _client().update_comment("A-1", "42", doc)

    assert captured["method"] == "PUT"
    assert captured["url"].endswith("/issue/A-1/comment/42")
    assert captured["headers"]["content-type"] == "application/json"
    assert json.loads(captured["body"].decode("utf-8")) == {"body": doc}
    assert out["id"] == "42"
