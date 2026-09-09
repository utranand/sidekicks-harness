#!/usr/bin/env python3
"""sk-jira-connector dispatcher.

Single entry point for every mode: it resolves the alias config, builds an authenticated
JiraClient, runs the requested command, renders Markdown, and sets the process exit code.
Always invoke by absolute path with the repo-root venv Python so it works from anywhere:

    "$PYTHON" "$SKILL_DIR/scripts/cli.py" <command> --env <alias> [options]

Read commands print Markdown to stdout. Write commands (comment/transition/edit/create/
delete) perform outward-facing mutations — the agent gates them per the SKILL.md safety
contract; the only guard enforced *in code* is that delete refuses to run without --yes,
because it is irreversible.

Exit codes: 0 success · 1 config/operation error · 2 write blocked by a safety guard.
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime

import config_loader
import render
from adf import adf_to_markdown, text_to_adf
from config_loader import ConfigError
from jira_client import JiraClient, JiraError

EXIT_OK = 0
EXIT_ERR = 1
EXIT_BLOCKED = 2


# -- client construction ---------------------------------------------------------

def _build_client(args):
    """Resolve the alias config and return (JiraClient, effective_config)."""
    flags = {}
    if getattr(args, "project", None):
        flags["default_project"] = args.project
    cfg = config_loader.load(args.env, flags=flags, config_path=getattr(args, "config", None))
    client = JiraClient(cfg["jira_url"], cfg["jira_email"], cfg["api_token"])
    return client, cfg


def _resolve_assignee(args, cfg):
    """accountId/JQL term for the assignee filter.

    --assignee wins; else config default_assignee; else the API user (currentUser()).
    A literal 'me'/'currentUser' maps to the JQL currentUser() function.
    """
    val = getattr(args, "assignee", None) or cfg.get("default_assignee")
    if not val or val in ("me", "currentUser", "currentUser()"):
        return "currentUser()"
    # An accountId must be quoted in JQL.
    return f'"{val}"'


def _resolve_assignee_id(value, cfg, client, default_to_me=False):
    """Resolve an --assignee value to a real accountId for issue fields (create/edit).

    'me'/'currentUser' resolves via client.myself(); 'unassigned'/'none' clears it
    (returns None). An empty value falls back to config default_assignee, then —
    only when default_to_me is set (create's default) — to the API user, so a new
    issue lands assigned to the operator instead of unassigned by omission.
    """
    if value in ("unassigned", "none"):
        return None
    if not value:
        value = cfg.get("default_assignee")
    if not value:
        return client.myself()["accountId"] if default_to_me else None
    if value in ("me", "currentUser", "currentUser()"):
        return client.myself()["accountId"]
    return value


def _project_clause(args, cfg):
    proj = getattr(args, "project", None) or cfg.get("default_project")
    return f'project = "{proj}"' if proj else None


# -- read commands ---------------------------------------------------------------

def cmd_search(args):
    client, cfg = _build_client(args)
    if args.jql:
        jql = args.jql
    else:
        clauses = []
        pc = _project_clause(args, cfg)
        if pc:
            clauses.append(pc)
        if args.status:
            clauses.append(f'status = "{args.status}"')
        if args.assignee:
            clauses.append(f"assignee = {_resolve_assignee(args, cfg)}")
        if not clauses:
            print("ERROR: provide --jql, or --project/--status/--assignee filters.", file=sys.stderr)
            return EXIT_ERR
        jql = " AND ".join(clauses) + " ORDER BY updated DESC"
    issues = client.search(jql, max_results=50, max_total=args.max)
    if getattr(args, "json", False):
        # Machine-readable result set — for tools that need to act on each hit
        # (e.g. the ready-gate fanning out over `parent = KEY` subtasks). A flat
        # list of {key, summary, status, issuetype} keeps callers off the
        # markdown table without forcing a per-issue refetch.
        out = [{
            "key": it.get("key"),
            "summary": (it.get("fields") or {}).get("summary"),
            "status": ((it.get("fields") or {}).get("status") or {}).get("name"),
            "issuetype": ((it.get("fields") or {}).get("issuetype") or {}).get("name"),
        } for it in issues]
        print(json.dumps(out, ensure_ascii=False))
        return EXIT_OK
    print(render.render_list(issues, title=f"JQL: {jql}"))
    return EXIT_OK


def cmd_my_tasks(args):
    client, cfg = _build_client(args)
    assignee = _resolve_assignee(args, cfg)
    clauses = [f"assignee = {assignee}"]
    pc = _project_clause(args, cfg)
    if pc:
        clauses.append(pc)
    if not args.include_done:
        clauses.append("statusCategory != Done")
    jql = " AND ".join(clauses) + " ORDER BY updated DESC"
    issues = client.search(jql, max_results=50, max_total=args.max)
    who = args.assignee or cfg.get("default_assignee") or "you"
    print(render.render_my_tasks(issues, who=who))
    return EXIT_OK


def cmd_issue(args):
    client, _ = _build_client(args)
    issue = client.get_issue(args.key)
    if getattr(args, "raw", False):
        # Raw issue JSON — for tools that need the unrendered field tree (e.g. the
        # ready-gate needs `fields.description` as ADF to append to it without
        # flattening the reporter's original formatting). Comments aren't needed here.
        print(json.dumps(issue, ensure_ascii=False))
        return EXIT_OK
    comments = None if args.no_comments else client.get_comments(args.key)
    print(render.render_issue(issue, comments=comments))
    return EXIT_OK


def cmd_timeline(args):
    client, cfg = _build_client(args)
    pc = _project_clause(args, cfg)
    if not pc:
        print("ERROR: timeline needs a project (--project or default_project).", file=sys.stderr)
        return EXIT_ERR
    epics = client.search(
        f"{pc} AND issuetype = Epic ORDER BY created ASC",
        fields=["summary", "status", "created", "updated", "duedate"],
        max_total=args.max,
    )
    children_by_epic = None
    if args.with_children and epics:
        children_by_epic = {}
        for e in epics:
            kids = client.search(
                f'parent = {e["key"]}',
                fields=["status"],
                max_total=200,
            )
            children_by_epic[e["key"]] = kids
    print(render.render_timeline(epics, children_by_epic=children_by_epic))
    return EXIT_OK


def cmd_projects(args):
    client, _ = _build_client(args)
    projects = client.list_projects(query=args.query)
    if not projects:
        print("_No projects visible._")
        return EXIT_OK
    print("| Key | Name | Type |")
    print("|---|---|---|")
    for p in projects:
        print(f"| {p.get('key', '?')} | {p.get('name', '?')} | {p.get('projectTypeKey', '?')} |")
    return EXIT_OK


def cmd_whoami(args):
    client, _ = _build_client(args)
    me = client.myself()
    print(f"accountId:   {me.get('accountId', '?')}")
    print(f"displayName: {me.get('displayName', '?')}")
    print(f"email:       {me.get('emailAddress', '(hidden)')}")
    return EXIT_OK


def cmd_test_connection(args):
    try:
        client, cfg = _build_client(args)
        me = client.myself()
    except (ConfigError, JiraError) as e:
        print(f"FAIL: {e}", file=sys.stderr)
        return EXIT_ERR
    print(f"OK: authenticated to {cfg['jira_url']} as {me.get('displayName')} "
          f"({me.get('accountId')})")
    return EXIT_OK


# -- write commands (outward-facing) ---------------------------------------------

def _comment_body(args):
    """Resolve the ADF body for an add/edit from --body or --body-adf.

    Returns (adf, None) on success and (None, exit_code) when the flags are unusable —
    the caller returns that code straight out. --body-adf is the passthrough twin of
    `edit --description-adf`: the document is written exactly as given, which is what
    lets a caller read a body, transform its text nodes, and write it back without
    flattening the author's formatting.
    """
    if args.body is not None and args.body_adf is not None:
        print("ERROR: --body and --body-adf are mutually exclusive.", file=sys.stderr)
        return None, EXIT_ERR
    if args.body is not None:
        return text_to_adf(args.body), None
    if args.body_adf is not None:
        try:
            with open(args.body_adf, "r", encoding="utf-8") as fh:
                return json.load(fh), None
        except (OSError, json.JSONDecodeError) as e:
            print(f"ERROR: --body-adf is not a readable ADF JSON file: {e}", file=sys.stderr)
            return None, EXIT_ERR
    print("ERROR: nothing to write (pass --body or --body-adf).", file=sys.stderr)
    return None, EXIT_ERR


def cmd_comment(args):
    if args.list and args.id:
        print("ERROR: --list lists comments and --id edits one; pass only one.", file=sys.stderr)
        return EXIT_ERR

    client, _ = _build_client(args)

    # -- list ------------------------------------------------------------------
    # The issue drill-down renders comments without their ids, so this is the only way
    # to learn the id an edit needs. --json carries the RAW ADF body through, because
    # the point of editing is usually to transform an existing body, not retype it.
    if args.list:
        comments = client.get_comments(args.key, max_results=args.max)
        if args.json:
            print(json.dumps([{
                "id": c.get("id"),
                "author": (c.get("author") or {}).get("displayName"),
                "created": c.get("created"),
                "updated": c.get("updated"),
                "body": c.get("body"),
            } for c in comments], indent=2, ensure_ascii=False))
            return EXIT_OK
        if not comments:
            print(f"No comments on {args.key}.")
            return EXIT_OK
        print(f"# Comments on {args.key} ({len(comments)})\n")
        for c in comments:
            author = (c.get("author") or {}).get("displayName", "?")
            created = (c.get("created") or "")[:16].replace("T", " ")
            first = (adf_to_markdown(c.get("body")).strip().splitlines() or [""])[0]
            print(f"- `{c.get('id')}`  {created}  {author}  —  {first[:100]}")
        if len(comments) >= args.max:
            print(f"\n_Showing {args.max} (the --max ceiling) — raise --max if one is missing._")
        return EXIT_OK

    # -- edit an existing comment ----------------------------------------------
    if args.id:
        adf, err = _comment_body(args)
        if err is not None:
            return err
        current = next((c for c in client.get_comments(args.key, max_results=args.max)
                        if str(c.get("id")) == str(args.id)), None)
        if current is None:
            print(f"ERROR: comment {args.id} is not among the {args.max} most recent on "
                  f"{args.key}. Run `comment {args.key} --list` (raise --max) to find it.",
                  file=sys.stderr)
            return EXIT_ERR
        if not args.yes:
            author = (current.get("author") or {}).get("displayName", "?")
            created = (current.get("created") or "")[:16].replace("T", " ")
            body = adf_to_markdown(current.get("body")).strip()
            print(f"Current body of comment {args.id} on {args.key} "
                  f"(author: {author}, created: {created}):", file=sys.stderr)
            for line in body.splitlines() or [""]:
                print(f"  {line}", file=sys.stderr)
            print("BLOCKED: editing overwrites this text and there is no undo. "
                  "Re-run with --yes once confirmed.", file=sys.stderr)
            return EXIT_BLOCKED
        client.update_comment(args.key, args.id, adf)
        print(f"OK: updated comment {args.id} on {args.key}")
        return EXIT_OK

    # -- add (unchanged behaviour) ---------------------------------------------
    adf, err = _comment_body(args)
    if err is not None:
        return err
    created = client.add_comment(args.key, adf)
    print(f"OK: added comment {created.get('id', '?')} to {args.key}")
    return EXIT_OK


def cmd_attach(args):
    client, _ = _build_client(args)
    created = client.add_attachment(args.key, args.file)
    names = ", ".join(a.get("filename", "?") for a in created) or "(none)"
    print(f"OK: attached {len(created)} file(s) to {args.key}: {names}")
    return EXIT_OK


def cmd_attachments(args):
    """List, or pull down, an issue's attachments.

    The card is where a spec, spreadsheet or screenshot arrives; the feature workspace is where the
    work has to happen. Pulling is a copy, never a move — Jira keeps the original. Each file is
    written under --dest and a manifest.json records provenance (id, size, author, created, url) so
    a later run can tell an unchanged file from a replaced one without re-downloading it.
    """
    client, _ = _build_client(args)
    items = client.list_attachments(args.key)
    if args.download is None:
        if getattr(args, "json", False):
            print(json.dumps(items, ensure_ascii=False))
        elif not items:
            print(f"{args.key}: no attachments")
        else:
            print(f"{args.key}: {len(items)} attachment(s)")
            for a in items:
                kb = (a["size"] or 0) / 1024.0
                print(f"  {a['filename']}  ({kb:.0f} KB, {a['mime_type']}, "
                      f"{(a['created'] or '')[:10]}, {a['author']})")
        return EXIT_OK

    dest = args.download
    os.makedirs(dest, exist_ok=True)
    manifest_path = os.path.join(dest, "manifest.json")
    known = {}
    if os.path.isfile(manifest_path):
        try:
            with open(manifest_path, "r", encoding="utf-8") as fh:
                known = {e["id"]: e for e in json.load(fh).get("attachments", [])}
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            known = {}

    written, skipped, records = 0, 0, []
    # Jira allows several attachments with the SAME filename on one issue (a re-upload keeps the
    # old one). Writing them all to one path silently keeps only the last — so a repeat name is
    # disambiguated with the attachment id, which is stable across runs.
    seen_names = {}
    for a in items:
        seen_names[a["filename"]] = seen_names.get(a["filename"], 0) + 1
    dupes = {n for n, c in seen_names.items() if c > 1}
    for a in items:
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", a["filename"] or a["id"] or "attachment")
        if a["filename"] in dupes:
            stem, ext = os.path.splitext(safe)
            safe = f"{stem}__{a['id']}{ext}"
        target = os.path.join(dest, safe)
        prev = known.get(a["id"])
        if prev and os.path.isfile(target) and os.path.getsize(target) == (a["size"] or -1):
            skipped += 1
            records.append({**a, "file": safe, "pulled_at": prev.get("pulled_at")})
            continue
        size = client.download_attachment(a["content_url"], target)
        written += 1
        records.append({**a, "file": safe, "bytes": size,
                        "pulled_at": datetime.now().astimezone().isoformat(timespec="seconds")})
        print(f"  pulled {safe} ({size} bytes)")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump({"issue": args.key, "attachments": records}, fh, ensure_ascii=False, indent=2)
    print(f"{args.key}: {written} pulled, {skipped} already current -> {dest}")
    return EXIT_OK


def cmd_transition(args):
    client, _ = _build_client(args)
    transitions = client.get_transitions(args.key)
    if args.list or not args.to:
        print(f"Transitions available for {args.key}:")
        for t in transitions:
            print(f"  {t['id']}  →  {t.get('to', {}).get('name', t['name'])}")
        if not args.to:
            return EXIT_OK
    match = next(
        (t for t in transitions
         if args.to.lower() in (t.get("to", {}).get("name", "").lower(), t["name"].lower())),
        None,
    )
    if not match:
        avail = ", ".join(t.get("to", {}).get("name", t["name"]) for t in transitions)
        print(f"ERROR: no transition to '{args.to}' from current status. Available: {avail}",
              file=sys.stderr)
        return EXIT_ERR
    client.transition_issue(args.key, match["id"])
    print(f"OK: {args.key} transitioned to {match.get('to', {}).get('name', args.to)}")
    return EXIT_OK


def cmd_edit(args):
    client, cfg = _build_client(args)
    fields = {}
    if args.summary:
        fields["summary"] = args.summary
    if args.priority:
        fields["priority"] = {"name": args.priority}
    if args.assignee:
        aid = _resolve_assignee_id(args.assignee, cfg, client)
        fields["assignee"] = {"accountId": aid}
    if getattr(args, "description", None) is not None:
        # Plain text -> ADF, same path as `create`. For rich/pre-built ADF
        # (e.g. an append that must preserve the reporter's formatting) use
        # --description-adf instead, which passes the document through verbatim.
        fields["description"] = text_to_adf(args.description)
    if getattr(args, "description_adf", None) is not None:
        # Raw ADF document passthrough. The v3 API requires `description` to be an
        # ADF object, not a string — so a caller that has already built the merged
        # document (preserving the original nodes) hands it in here untouched.
        try:
            with open(args.description_adf, "r", encoding="utf-8") as fh:
                fields["description"] = json.load(fh)
        except (OSError, json.JSONDecodeError) as e:
            print(f"ERROR: --description-adf is not a readable ADF JSON file: {e}",
                  file=sys.stderr)
            return EXIT_ERR
    for kv in args.set or []:
        if "=" not in kv:
            print(f"ERROR: --set expects field=value, got '{kv}'", file=sys.stderr)
            return EXIT_ERR
        k, v = kv.split("=", 1)
        fields[k] = v
    if not fields:
        print("ERROR: nothing to edit (use --summary/--description/--description-adf/"
              "--priority/--assignee/--set).", file=sys.stderr)
        return EXIT_ERR
    client.edit_issue(args.key, fields)
    print(f"OK: updated {args.key} ({', '.join(fields)})")
    return EXIT_OK


def cmd_create(args):
    client, cfg = _build_client(args)
    project = args.project or cfg.get("default_project")
    if not project:
        print("ERROR: create needs a project (--project or default_project).", file=sys.stderr)
        return EXIT_ERR
    fields = {
        "project": {"key": project},
        "issuetype": {"name": args.type},
        "summary": args.summary,
    }
    if args.description:
        fields["description"] = text_to_adf(args.description)
    if args.priority:
        fields["priority"] = {"name": args.priority}
    aid = _resolve_assignee_id(args.assignee, cfg, client, default_to_me=True)
    if aid:
        fields["assignee"] = {"accountId": aid}
    if args.parent:
        fields["parent"] = {"key": args.parent}
    created = client.create_issue(fields)
    print(f"OK: created {created.get('key', '?')} in {project}")
    return EXIT_OK


def cmd_link(args):
    client, _ = _build_client(args)
    if args.list_types:
        types = client.list_issue_link_types()
        print("Issue link types available:")
        for t in types:
            print(f"  {t['name']}  (outward: '{t.get('outward','')}', inward: '{t.get('inward','')}')")
        return EXIT_OK
    # Resolve the directional pair from the convenience flags. The Jira model: for a
    # Blocks link, the OUTWARD issue 'blocks' and the INWARD issue 'is blocked by'.
    #   key --blocks OTHER       -> key blocks OTHER          (outward=key, inward=OTHER)
    #   key --blocked-by OTHER   -> key is blocked by OTHER   (outward=OTHER, inward=key)
    #   key --relates-to OTHER   -> Relates link (symmetric)
    #   key --type T --to OTHER [--inward] -> generic (key is outward unless --inward)
    if args.blocks:
        link_type, outward, inward = "Blocks", args.key, args.blocks
    elif args.blocked_by:
        link_type, outward, inward = "Blocks", args.blocked_by, args.key
    elif args.relates_to:
        link_type, outward, inward = "Relates", args.key, args.relates_to
    elif args.type and args.to:
        if args.inward:
            link_type, outward, inward = args.type, args.to, args.key
        else:
            link_type, outward, inward = args.type, args.key, args.to
    else:
        print("ERROR: link needs one of --blocks/--blocked-by/--relates-to <KEY>, or "
              "--type <name> --to <KEY> (use --list-types to see the type names).", file=sys.stderr)
        return EXIT_ERR
    client.create_issue_link(link_type, inward_key=inward, outward_key=outward)
    print(f"OK: linked {outward} '{link_type}' → {inward}")
    return EXIT_OK


def cmd_delete(args):
    if not args.yes:
        print("BLOCKED: delete is irreversible. Re-run with --yes once confirmed.",
              file=sys.stderr)
        return EXIT_BLOCKED
    client, _ = _build_client(args)
    client.delete_issue(args.key, delete_subtasks=args.delete_subtasks)
    print(f"OK: deleted {args.key}")
    return EXIT_OK


# -- arg parsing -----------------------------------------------------------------

def build_parser():
    # --config lives on a shared parent parser so it is accepted both before AND after
    # the subcommand (e.g. `... issue SDHPT-1 --env shp --config path`). With argparse
    # subparsers a top-level-only option must precede the subcommand, which trips users
    # who put it at the end — inheriting it on every subparser removes that ordering trap.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--config", help="override the scope-resolved config.yaml path")

    p = argparse.ArgumentParser(prog="jira-connector", description="Sidekicks Jira Cloud connector",
                                parents=[common])
    sub = p.add_subparsers(dest="command", required=True)

    def addp(name, **kw):
        return sub.add_parser(name, parents=[common], **kw)

    def add_env(sp):
        sp.add_argument("--env", required=True, help="jira alias from config.yaml")

    sp = addp("search", help="run a JQL search or filtered browse")
    add_env(sp)
    sp.add_argument("--jql", help="raw JQL (overrides the filter flags)")
    sp.add_argument("--project", help="project key (defaults to config default_project)")
    sp.add_argument("--status", help="filter by status name")
    sp.add_argument("--assignee", help="filter by accountId, or 'me'")
    sp.add_argument("--max", type=int, default=100, help="max issues to fetch (default 100)")
    sp.add_argument("--json", action="store_true",
                    help="emit a JSON array of {key,summary,status,issuetype} instead of a table")
    sp.set_defaults(func=cmd_search)

    sp = addp("my-tasks", help="issues assigned to the configured/user account, grouped by type+priority")
    add_env(sp)
    sp.add_argument("--assignee", help="accountId or 'me' (default: config default_assignee, else API user)")
    sp.add_argument("--project", help="restrict to a project key")
    sp.add_argument("--include-done", action="store_true", help="include Done-category issues")
    sp.add_argument("--max", type=int, default=200)
    sp.set_defaults(func=cmd_my_tasks)

    sp = addp("issue", help="full drill-down for one issue")
    add_env(sp)
    sp.add_argument("key", help="issue key, e.g. SDHPT-2")
    sp.add_argument("--no-comments", action="store_true")
    sp.add_argument("--raw", action="store_true",
                    help="print the raw issue JSON (unrendered field tree, incl. description ADF)")
    sp.set_defaults(func=cmd_issue)

    sp = addp("timeline", help="epic timeline by created date (optional children rollup)")
    add_env(sp)
    sp.add_argument("--project", help="project key (defaults to config default_project)")
    sp.add_argument("--with-children", action="store_true", help="include per-epic child status rollup")
    sp.add_argument("--max", type=int, default=100)
    sp.set_defaults(func=cmd_timeline)

    sp = addp("projects", help="list visible projects")
    add_env(sp)
    sp.add_argument("--query", help="filter by name/key substring")
    sp.set_defaults(func=cmd_projects)

    sp = addp("whoami", help="show the authenticated account")
    add_env(sp)
    sp.set_defaults(func=cmd_whoami)

    sp = addp("test-connection", help="verify reachability + auth")
    add_env(sp)
    sp.set_defaults(func=cmd_test_connection)

    sp = addp("list-envs", help="list configured jira aliases (no secrets)")
    sp.set_defaults(func=None)  # handled specially in main

    sp = addp("comment", help="add, list, or edit an issue's comments")
    add_env(sp)
    sp.add_argument("key")
    sp.add_argument("--body", help="comment text (plain text, wrapped to ADF)")
    sp.add_argument("--body-adf", dest="body_adf",
                    help="comment body from a pre-built ADF JSON file (passed through verbatim)")
    sp.add_argument("--list", action="store_true",
                    help="list the issue's comments with their ids (the id an edit needs)")
    sp.add_argument("--json", action="store_true",
                    help="with --list: emit JSON incl. each comment's raw ADF body")
    sp.add_argument("--id", help="edit THIS existing comment instead of adding a new one")
    sp.add_argument("--yes", action="store_true",
                    help="confirm an --id edit (it overwrites the existing text; no undo)")
    sp.add_argument("--max", type=int, default=50,
                    help="how many comments to fetch for --list / --id lookup (default 50)")
    sp.set_defaults(func=cmd_comment)

    sp = addp("attachments", help="list or download an issue's attachments")
    add_env(sp)
    sp.add_argument("key")
    sp.add_argument("--download", metavar="DIR",
                    help="pull the files into DIR (omit to list only); re-runs skip unchanged files")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_attachments)

    sp = addp("attach", help="upload evidence/result file(s) to an issue as attachments")
    add_env(sp)
    sp.add_argument("key")
    sp.add_argument("--file", action="append", required=True,
                    help="path to a file to attach (repeatable for several files)")
    sp.set_defaults(func=cmd_attach)

    sp = addp("transition", help="move an issue to another status")
    add_env(sp)
    sp.add_argument("key")
    sp.add_argument("--to", help="target status name (omit to list available transitions)")
    sp.add_argument("--list", action="store_true", help="list available transitions")
    sp.set_defaults(func=cmd_transition)

    sp = addp("edit", help="update issue fields")
    add_env(sp)
    sp.add_argument("key")
    sp.add_argument("--summary")
    sp.add_argument("--description", help="set description from plain text (wrapped to ADF)")
    sp.add_argument("--description-adf",
                    help="set description from a pre-built ADF JSON file (passed through verbatim)")
    sp.add_argument("--priority")
    sp.add_argument("--assignee", help="accountId, 'me', or 'unassigned'")
    sp.add_argument("--set", action="append", help="raw field=value (repeatable)")
    sp.set_defaults(func=cmd_edit)

    sp = addp("create", help="create a new issue")
    add_env(sp)
    sp.add_argument("--project", help="project key (defaults to config default_project)")
    sp.add_argument("--type", required=True, help="issue type name, e.g. Task")
    sp.add_argument("--summary", required=True)
    sp.add_argument("--description")
    sp.add_argument("--priority")
    sp.add_argument("--assignee",
                    help="accountId, 'me', or 'unassigned' (default: config default_assignee, else 'me')")
    sp.add_argument("--parent", help="parent issue key (for subtasks / epic children)")
    sp.set_defaults(func=cmd_create)

    sp = addp("link", help="link two issues (Blocks/Relates/…) or list link types")
    add_env(sp)
    sp.add_argument("key", nargs="?", help="the issue key (omit only with --list-types)")
    sp.add_argument("--blocks", metavar="KEY", help="this issue BLOCKS KEY")
    sp.add_argument("--blocked-by", dest="blocked_by", metavar="KEY", help="this issue IS BLOCKED BY KEY")
    sp.add_argument("--relates-to", dest="relates_to", metavar="KEY", help="relate this issue to KEY")
    sp.add_argument("--type", help="generic link type name (see --list-types)")
    sp.add_argument("--to", metavar="KEY", help="the other issue for a generic --type link")
    sp.add_argument("--inward", action="store_true",
                    help="for a generic --type link, treat KEY as the inward side (default: outward)")
    sp.add_argument("--list-types", dest="list_types", action="store_true",
                    help="list the link types this Jira defines, then exit")
    sp.set_defaults(func=cmd_link)

    sp = addp("delete", help="delete an issue (irreversible; needs --yes)")
    add_env(sp)
    sp.add_argument("key")
    sp.add_argument("--yes", action="store_true", help="confirm the irreversible delete")
    sp.add_argument("--delete-subtasks", action="store_true")
    sp.set_defaults(func=cmd_delete)

    return p


def main(argv=None):
    args = build_parser().parse_args(argv)

    if args.command == "list-envs":
        return config_loader.cmd_list_envs(config_path=args.config)

    try:
        return args.func(args)
    except ConfigError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return EXIT_ERR
    except JiraError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return EXIT_ERR


if __name__ == "__main__":
    sys.exit(main())
