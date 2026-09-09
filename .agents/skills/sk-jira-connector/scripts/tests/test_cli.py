"""CLI dispatch with a mocked JiraClient — exercises arg wiring and safety guards."""
import cli


class FakeClient:
    def __init__(self):
        self.calls = []
        self.transitions = [
            {"id": "11", "name": "Start", "to": {"name": "In Progress"}},
            {"id": "31", "name": "Finish", "to": {"name": "Done"}},
        ]

    def search(self, jql, fields=None, max_results=50, max_total=200):
        self.calls.append(("search", jql))
        return [{"key": "A-1", "fields": {"summary": "x",
                "status": {"name": "To Do", "statusCategory": {"name": "To Do"}},
                "issuetype": {"name": "Task"}, "priority": {"name": "High"}}}]

    def get_issue(self, key, fields=None, expand=None):
        return {"key": key, "fields": {"summary": "x",
                "status": {"name": "To Do", "statusCategory": {"name": "To Do"}},
                "issuetype": {"name": "Task"}, "priority": {"name": "Low"}}}

    def get_comments(self, key, max_results=50):
        self.calls.append(("get_comments", key, max_results))
        return [
            {"id": "111572", "author": {"displayName": "Tester"},
             "created": "2026-09-01T10:00:00.000+0700", "updated": "2026-09-01T10:00:00.000+0700",
             "body": {"type": "doc", "version": 1, "content": [
                 {"type": "paragraph", "content": [{"type": "text", "text": "old body"}]}]}},
            {"id": "111573", "author": {"displayName": "Other"},
             "created": "2026-09-01T11:00:00.000+0700", "updated": None,
             "body": {"type": "doc", "version": 1, "content": [
                 {"type": "paragraph", "content": [{"type": "text", "text": "second"}]}]}},
        ]

    def get_transitions(self, key):
        return self.transitions

    def transition_issue(self, key, transition_id):
        self.calls.append(("transition", key, transition_id))
        return {}

    def add_comment(self, key, body):
        self.calls.append(("comment", key, body))
        return {"id": "999"}

    def update_comment(self, key, comment_id, body):
        self.calls.append(("update_comment", key, comment_id, body))
        return {"id": comment_id}

    def add_attachment(self, key, filepaths):
        self.calls.append(("attach", key, filepaths))
        paths = [filepaths] if isinstance(filepaths, str) else list(filepaths)
        return [{"id": str(i), "filename": p.split("/")[-1]} for i, p in enumerate(paths)]

    def edit_issue(self, key, fields):
        self.calls.append(("edit", key, fields))
        return {}

    def create_issue(self, fields):
        self.calls.append(("create", fields))
        return {"key": "A-99"}

    def delete_issue(self, key, delete_subtasks=False):
        self.calls.append(("delete", key))
        return {}

    def myself(self):
        return {"accountId": "abc", "displayName": "Tester", "emailAddress": "t@t.io"}


def _patch(monkeypatch, fake, cfg=None):
    cfg = cfg or {"jira_url": "https://x.atlassian.net", "jira_email": "e", "api_token": "t",
                  "default_project": "ABC"}
    monkeypatch.setattr(cli, "_build_client", lambda args: (fake, cfg))


def test_search_with_jql(monkeypatch, capsys):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["search", "--env", "x", "--jql", "project = ABC"])
    assert rc == 0
    assert fake.calls[0] == ("search", "project = ABC")
    assert "A-1" in capsys.readouterr().out


def test_search_builds_jql_from_filters(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    cli.main(["search", "--env", "x", "--status", "In Progress"])
    jql = fake.calls[0][1]
    assert 'project = "ABC"' in jql
    assert 'status = "In Progress"' in jql


def test_my_tasks_excludes_done_by_default(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    cli.main(["my-tasks", "--env", "x"])
    jql = fake.calls[0][1]
    assert "statusCategory != Done" in jql
    assert "currentUser()" in jql


def test_my_tasks_include_done(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    cli.main(["my-tasks", "--env", "x", "--include-done"])
    assert "statusCategory != Done" not in fake.calls[0][1]


def test_transition_matches_target_status(monkeypatch, capsys):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["transition", "A-1", "--env", "x", "--to", "Done"])
    assert rc == 0
    assert ("transition", "A-1", "31") in fake.calls
    assert "Done" in capsys.readouterr().out


def test_transition_unknown_target_errors(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["transition", "A-1", "--env", "x", "--to", "Nonexistent"])
    assert rc == 1


def test_delete_blocked_without_yes(monkeypatch, capsys):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["delete", "A-1", "--env", "x"])
    assert rc == 2
    assert ("delete", "A-1") not in fake.calls
    assert "BLOCKED" in capsys.readouterr().err


def test_delete_runs_with_yes(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["delete", "A-1", "--env", "x", "--yes"])
    assert rc == 0
    assert ("delete", "A-1") in fake.calls


def test_comment_wraps_body_in_adf(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    cli.main(["comment", "A-1", "--env", "x", "--body", "hello"])
    _, key, body = next(c for c in fake.calls if c[0] == "comment")
    assert key == "A-1"
    assert body["type"] == "doc"  # text_to_adf produced a doc


def test_comment_list_shows_ids(monkeypatch, capsys):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["comment", "A-1", "--env", "x", "--list"])
    assert rc == 0
    out = capsys.readouterr().out
    # the id is the whole point: the drill-down renders comments without it.
    assert "111572" in out and "old body" in out


def test_comment_list_json_carries_raw_adf(monkeypatch, capsys):
    import json as _json
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["comment", "A-1", "--env", "x", "--list", "--json"])
    assert rc == 0
    payload = _json.loads(capsys.readouterr().out)
    assert [c["id"] for c in payload] == ["111572", "111573"]
    # raw ADF, not markdown — that is what makes transform-and-push-back possible.
    assert payload[0]["body"]["type"] == "doc"


def test_comment_edit_blocked_without_yes(monkeypatch, capsys):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["comment", "A-1", "--env", "x", "--id", "111572", "--body", "new"])
    assert rc == 2
    assert not [c for c in fake.calls if c[0] == "update_comment"]
    err = capsys.readouterr().err
    assert "old body" in err          # the text about to be destroyed is shown first
    assert "BLOCKED" in err


def test_comment_edit_runs_with_yes(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["comment", "A-1", "--env", "x", "--id", "111572", "--body", "new", "--yes"])
    assert rc == 0
    _, key, cid, body = next(c for c in fake.calls if c[0] == "update_comment")
    assert (key, cid) == ("A-1", "111572")
    assert body["type"] == "doc"


def test_comment_edit_body_adf_passes_through(monkeypatch, tmp_path):
    doc = {"type": "doc", "version": 1,
           "content": [{"type": "paragraph",
                        "content": [{"type": "text", "text": "kept",
                                     "marks": [{"type": "strong"}]}]}]}
    f = tmp_path / "body.json"
    f.write_text(__import__("json").dumps(doc))
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["comment", "A-1", "--env", "x", "--id", "111572",
                   "--body-adf", str(f), "--yes"])
    assert rc == 0
    _, _, _, body = next(c for c in fake.calls if c[0] == "update_comment")
    assert body == doc            # verbatim — marks survive, nothing re-wrapped


def test_comment_edit_unknown_id_errors(monkeypatch, capsys):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["comment", "A-1", "--env", "x", "--id", "999999", "--body", "x", "--yes"])
    assert rc == 1
    assert not [c for c in fake.calls if c[0] == "update_comment"]
    assert "not among" in capsys.readouterr().err


def test_comment_rejects_body_and_body_adf(monkeypatch, capsys, tmp_path):
    f = tmp_path / "b.json"
    f.write_text('{"type": "doc", "version": 1, "content": []}')
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["comment", "A-1", "--env", "x", "--body", "a", "--body-adf", str(f)])
    assert rc == 1
    assert "mutually exclusive" in capsys.readouterr().err


def test_comment_add_without_any_body_errors(monkeypatch, capsys):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["comment", "A-1", "--env", "x"])
    assert rc == 1
    assert not [c for c in fake.calls if c[0] == "comment"]
    assert "nothing to write" in capsys.readouterr().err


def test_attach_single_file(monkeypatch, capsys):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["attach", "A-1", "--env", "x", "--file", "docs/report.md"])
    assert rc == 0
    _, key, files = next(c for c in fake.calls if c[0] == "attach")
    assert key == "A-1"
    assert files == ["docs/report.md"]
    assert "attached 1 file" in capsys.readouterr().out


def test_attach_multiple_files(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["attach", "A-1", "--env", "x", "--file", "a.csv", "--file", "b.md"])
    assert rc == 0
    _, _, files = next(c for c in fake.calls if c[0] == "attach")
    assert files == ["a.csv", "b.md"]


def test_attach_requires_a_file(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    # argparse enforces --file required → SystemExit(2), not a normal return.
    import pytest
    with pytest.raises(SystemExit):
        cli.main(["attach", "A-1", "--env", "x"])


def test_create_uses_default_project(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    cli.main(["create", "--env", "x", "--type", "Task", "--summary", "new thing"])
    _, fields = next(c for c in fake.calls if c[0] == "create")
    assert fields["project"]["key"] == "ABC"
    assert fields["summary"] == "new thing"


def test_create_defaults_assignee_to_api_user(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    cli.main(["create", "--env", "x", "--type", "Task", "--summary", "new thing"])
    _, fields = next(c for c in fake.calls if c[0] == "create")
    assert fields["assignee"] == {"accountId": "abc"}


def test_create_assignee_me_resolves_to_api_user(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    cli.main(["create", "--env", "x", "--type", "Task", "--summary", "x", "--assignee", "me"])
    _, fields = next(c for c in fake.calls if c[0] == "create")
    assert fields["assignee"] == {"accountId": "abc"}


def test_create_assignee_explicit_account_id_wins(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    cli.main(["create", "--env", "x", "--type", "Task", "--summary", "x", "--assignee", "xyz"])
    _, fields = next(c for c in fake.calls if c[0] == "create")
    assert fields["assignee"] == {"accountId": "xyz"}


def test_create_assignee_unassigned_leaves_it_unset(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    cli.main(["create", "--env", "x", "--type", "Task", "--summary", "x", "--assignee", "unassigned"])
    _, fields = next(c for c in fake.calls if c[0] == "create")
    assert "assignee" not in fields


def test_create_uses_config_default_assignee(monkeypatch):
    fake = FakeClient()
    cfg = {"jira_url": "https://x.atlassian.net", "jira_email": "e", "api_token": "t",
           "default_project": "ABC", "default_assignee": "cfg-user"}
    _patch(monkeypatch, fake, cfg=cfg)
    cli.main(["create", "--env", "x", "--type", "Task", "--summary", "x"])
    _, fields = next(c for c in fake.calls if c[0] == "create")
    assert fields["assignee"] == {"accountId": "cfg-user"}


def test_edit_assignee_me_resolves_to_api_user(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    cli.main(["edit", "A-1", "--env", "x", "--assignee", "me"])
    _, _, fields = next(c for c in fake.calls if c[0] == "edit")
    assert fields["assignee"] == {"accountId": "abc"}


def test_edit_requires_a_field(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["edit", "A-1", "--env", "x"])
    assert rc == 1


def test_search_json_emits_flat_array(monkeypatch, capsys):
    import json
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["search", "--env", "x", "--jql", "parent = A-1", "--json"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out)
    assert out == [{"key": "A-1", "summary": "x", "status": "To Do", "issuetype": "Task"}]


def test_issue_raw_dumps_issue_json(monkeypatch, capsys):
    import json
    fake = FakeClient()
    _patch(monkeypatch, fake)
    rc = cli.main(["issue", "A-1", "--env", "x", "--raw"])
    assert rc == 0
    data = json.loads(capsys.readouterr().out)
    assert data["key"] == "A-1"
    assert "fields" in data  # raw tree, not the rendered markdown


def test_edit_description_adf_passthrough(monkeypatch, tmp_path):
    import json
    fake = FakeClient()
    _patch(monkeypatch, fake)
    doc = {"type": "doc", "version": 1,
           "content": [{"type": "paragraph", "content": [{"type": "text", "text": "hi"}]}]}
    f = tmp_path / "desc.json"
    f.write_text(json.dumps(doc), encoding="utf-8")
    rc = cli.main(["edit", "A-1", "--env", "x", "--description-adf", str(f)])
    assert rc == 0
    _, key, fields = next(c for c in fake.calls if c[0] == "edit")
    assert key == "A-1"
    # passed through verbatim — NOT re-wrapped, so the reporter's nodes survive
    assert fields["description"] == doc


def test_edit_description_text_wraps_to_adf(monkeypatch):
    fake = FakeClient()
    _patch(monkeypatch, fake)
    cli.main(["edit", "A-1", "--env", "x", "--description", "plain words"])
    _, _, fields = next(c for c in fake.calls if c[0] == "edit")
    assert fields["description"]["type"] == "doc"  # text_to_adf produced a doc
