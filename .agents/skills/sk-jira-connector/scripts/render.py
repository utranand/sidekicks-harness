#!/usr/bin/env python3
"""Presentation helpers — turn raw Jira issue JSON into the Markdown views agents show.

Kept separate from the client so formatting can be tested without a network and so the
CLI stays a thin dispatcher. Each renderer takes already-fetched issue dicts (compact,
from JiraClient.search) and returns a Markdown string ready to print.

The grouping/ordering logic for "my tasks" lives here on purpose: the user asked for
their assigned work ordered by type then priority, and encoding that once means every
caller gets the same, predictable ordering rather than re-deriving it ad hoc.
"""

from adf import adf_to_markdown

# Canonical priority order (high → low). Anything unknown sorts last.
_PRIORITY_ORDER = {
    "Highest": 0, "High": 1, "Medium": 2, "Low": 3, "Lowest": 4,
}
# Issue-type grouping order (containers first, then work items, subtasks last).
_TYPE_ORDER = {
    "Epic": 0, "Story": 1, "Task": 2, "Bug": 3, "Subtask": 4, "Sub-task": 4,
}


def field(issue, *path, default=None):
    """Safely walk issue['fields'][...] returning default on any missing link."""
    cur = issue.get("fields", {}) or {}
    for i, key in enumerate(path):
        if not isinstance(cur, dict):
            return default
        cur = cur.get(key)
        if cur is None:
            return default
    return cur


def compact(issue):
    """Flatten a raw issue into the primitives the views need."""
    return {
        "key": issue.get("key", "?"),
        "summary": field(issue, "summary", default="") or "",
        "status": field(issue, "status", "name", default="?"),
        "status_category": field(issue, "status", "statusCategory", "name", default=""),
        "type": field(issue, "issuetype", "name", default="?"),
        "priority": field(issue, "priority", "name", default=""),
        "assignee": field(issue, "assignee", "displayName", default="Unassigned"),
        "updated": (field(issue, "updated", default="") or "")[:10],
        "created": (field(issue, "created", default="") or "")[:10],
        "parent": field(issue, "parent", "key", default=""),
    }


def _esc(text):
    """Escape pipe so summaries don't break Markdown tables."""
    return (text or "").replace("|", "\\|").replace("\n", " ").strip()


def render_list(issues, title=None, web_url=None):
    """A compact status-grouped Markdown table for a JQL/browse result."""
    rows = [compact(i) for i in issues]
    out = []
    if title:
        out.append(f"## {title}  ({len(rows)} issues)\n")
    if not rows:
        out.append("_No issues matched._")
        return "\n".join(out)
    out.append("| Key | Type | Status | Priority | Summary |")
    out.append("|---|---|---|---|---|")
    for r in rows:
        out.append(
            f"| {r['key']} | {r['type']} | {r['status']} | {r['priority'] or '—'} | {_esc(r['summary'])} |"
        )
    if web_url:
        out.append(f"\n[Open in Jira]({web_url})")
    return "\n".join(out)


def render_my_tasks(issues, who="you"):
    """Assigned tasks grouped by issue type, then ordered by priority within type.

    This is the explicit shape the user wanted: scan-friendly, work-items clustered by
    kind so it reads like a personal worklist rather than a flat dump.
    """
    rows = [compact(i) for i in issues]
    if not rows:
        return f"_No open issues assigned to {who}._"

    rows.sort(key=lambda r: (
        _TYPE_ORDER.get(r["type"], 99),
        _PRIORITY_ORDER.get(r["priority"], 99),
        r["status"],
    ))

    out = [f"## Assigned to {who}  ({len(rows)} issues)\n"]
    current_type = None
    for r in rows:
        if r["type"] != current_type:
            current_type = r["type"]
            out.append(f"\n### {current_type}")
            out.append("| Key | Priority | Status | Summary |")
            out.append("|---|---|---|---|")
        out.append(
            f"| {r['key']} | {r['priority'] or '—'} | {r['status']} | {_esc(r['summary'])} |"
        )
    return "\n".join(out)


def render_timeline(epics, children_by_epic=None):
    """Chronological epic timeline (by created date) with status + last activity.

    Jira's native Timeline needs start/due dates; when those aren't set this creation-
    ordered view is the honest substitute. If ``children_by_epic`` is supplied, each
    epic lists a one-line rollup of its children's statuses.
    """
    rows = [compact(e) for e in epics]
    rows.sort(key=lambda r: r["created"] or "9999")
    out = ["## Epic Timeline (by created date)\n"]
    out.append("| Created | Epic | Status | Last activity |")
    out.append("|---|---|---|---|")
    for r in rows:
        out.append(
            f"| {r['created'] or '—'} | {r['key']} · {_esc(r['summary'])} | {r['status']} | {r['updated'] or '—'} |"
        )
    if children_by_epic:
        out.append("\n### Children rollup")
        for key, kids in children_by_epic.items():
            counts = {}
            for k in kids:
                cat = compact(k)["status"]
                counts[cat] = counts.get(cat, 0) + 1
            summary = ", ".join(f"{n} {s}" for s, n in sorted(counts.items()))
            out.append(f"- **{key}**: {summary or 'no children'}")
    return "\n".join(out)


def render_issue(issue, comments=None):
    """Full single-issue drill-down: header, fields, description, comments."""
    c = compact(issue)
    out = [f"# {c['key']} — {c['summary']}\n"]
    out.append(f"- **Type:** {c['type']}  ")
    out.append(f"- **Status:** {c['status']}  ")
    out.append(f"- **Priority:** {c['priority'] or '—'}  ")
    out.append(f"- **Assignee:** {c['assignee']}  ")
    if c["parent"]:
        out.append(f"- **Parent:** {c['parent']}  ")
    out.append(f"- **Updated:** {c['updated']}  ")

    desc = adf_to_markdown(field(issue, "description"))
    out.append("\n## Description\n")
    out.append(desc if desc else "_No description._")

    # `comments is None` means they were not requested (issue --no-comments); an empty
    # list means they were fetched and there genuinely are none. Surface that difference
    # explicitly — a reader must be able to tell "checked, none" from "not fetched",
    # otherwise a silent section reads as if comments were never looked at.
    if comments is not None:
        out.append(f"\n## Comments ({len(comments)})\n")
        if not comments:
            out.append("_No comments._")
        for cm in comments:
            author = (cm.get("author") or {}).get("displayName", "?")
            created = (cm.get("created") or "")[:16].replace("T", " ")
            body = adf_to_markdown(cm.get("body"))
            out.append(f"**{author}** · {created}\n\n{body}\n")
    return "\n".join(out)
