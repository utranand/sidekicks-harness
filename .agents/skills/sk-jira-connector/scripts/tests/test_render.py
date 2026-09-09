"""Rendering views: list, my-tasks grouping/ordering, timeline, issue."""
import render


def _issue(key, summary="s", status="To Do", itype="Task", priority="Medium",
           updated="2026-06-01T00:00:00.000+0700", created="2026-01-01T00:00:00.000+0700",
           parent=None):
    fields = {
        "summary": summary,
        "status": {"name": status, "statusCategory": {"name": status}},
        "issuetype": {"name": itype},
        "priority": {"name": priority},
        "updated": updated,
        "created": created,
    }
    if parent:
        fields["parent"] = {"key": parent}
    return {"key": key, "fields": fields}


def test_compact_extracts_primitives():
    c = render.compact(_issue("A-1", summary="hi", status="Done"))
    assert c["key"] == "A-1"
    assert c["summary"] == "hi"
    assert c["status"] == "Done"
    assert c["updated"] == "2026-06-01"


def test_render_list_table_and_count():
    md = render.render_list([_issue("A-1"), _issue("A-2")], title="X")
    assert "(2 issues)" in md
    assert "| A-1 |" in md
    assert "| A-2 |" in md


def test_render_list_empty():
    assert "No issues matched" in render.render_list([], title="X")


def test_render_list_escapes_pipe_in_summary():
    md = render.render_list([_issue("A-1", summary="a | b")])
    assert "a \\| b" in md


def test_my_tasks_groups_by_type_then_priority():
    issues = [
        _issue("T-1", itype="Task", priority="Low"),
        _issue("T-2", itype="Task", priority="High"),
        _issue("E-1", itype="Epic", priority="Medium"),
        _issue("B-1", itype="Bug", priority="Highest"),
    ]
    md = render.render_my_tasks(issues, who="me")
    # Epic section comes before Task section before Bug
    assert md.index("### Epic") < md.index("### Task") < md.index("### Bug")
    # Within Task, High (T-2) sorts above Low (T-1)
    assert md.index("| T-2 |") < md.index("| T-1 |")


def test_my_tasks_empty():
    assert "No open issues" in render.render_my_tasks([], who="me")


def test_timeline_orders_by_created_ascending():
    issues = [
        _issue("E-2", itype="Epic", created="2026-03-01T00:00:00.000+0700"),
        _issue("E-1", itype="Epic", created="2026-01-01T00:00:00.000+0700"),
    ]
    md = render.render_timeline(issues)
    assert md.index("E-1") < md.index("E-2")


def test_timeline_children_rollup():
    epics = [_issue("E-1", itype="Epic")]
    kids = {"E-1": [_issue("C-1", status="Done"), _issue("C-2", status="Done"),
                    _issue("C-3", status="To Do")]}
    md = render.render_timeline(epics, children_by_epic=kids)
    assert "Children rollup" in md
    assert "2 Done" in md
    assert "1 To Do" in md


def test_render_issue_includes_description_and_comments():
    issue = _issue("A-1", summary="title")
    issue["fields"]["description"] = {
        "type": "doc", "version": 1,
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "the body"}]}],
    }
    comments = [{
        "author": {"displayName": "Alice"},
        "created": "2026-06-01T10:00:00.000+0700",
        "body": {"type": "doc", "version": 1,
                 "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a note"}]}]},
    }]
    md = render.render_issue(issue, comments=comments)
    assert "# A-1 — title" in md
    assert "the body" in md
    assert "Alice" in md
    assert "a note" in md


def test_render_issue_no_description():
    md = render.render_issue(_issue("A-1"), comments=None)
    assert "_No description._" in md


def test_render_issue_empty_comments_states_none():
    # comments=[] means "fetched, genuinely none" — must say so, not stay silent.
    md = render.render_issue(_issue("A-1"), comments=[])
    assert "Comments (0)" in md
    assert "_No comments._" in md


def test_render_issue_comments_not_requested_is_silent():
    # comments=None means --no-comments; no Comments section at all.
    md = render.render_issue(_issue("A-1"), comments=None)
    assert "## Comments" not in md
