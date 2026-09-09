"""Scope-aware config resolution, BMAD exclusion, token requirement."""
import textwrap

import pytest

import config_loader
import scope
from config_loader import ConfigError


def _write_config(tmp_path, body):
    p = tmp_path / "config.yaml"
    p.write_text(textwrap.dedent(body), encoding="utf-8")
    return str(p)


def test_load_resolves_alias_and_token(tmp_path, monkeypatch):
    cfg = _write_config(tmp_path, """
        jira:
          board:
            jira_url: https://acme.atlassian.net
            jira_email: me@acme.io
            api_token: secret-123
            default_project: ABC
    """)
    monkeypatch.setattr(scope, "resolve_config_path", lambda *a, **k: cfg)
    eff = config_loader.load("board", config_path=cfg)
    assert eff["jira_url"] == "https://acme.atlassian.net"
    assert eff["api_token"] == "secret-123"
    assert eff["default_project"] == "ABC"


def test_missing_token_raises_guided_error(tmp_path, monkeypatch):
    cfg = _write_config(tmp_path, """
        jira:
          board:
            jira_url: https://acme.atlassian.net
            jira_email: me@acme.io
            api_token:
    """)
    monkeypatch.setattr(scope, "resolve_config_path", lambda *a, **k: cfg)
    with pytest.raises(ConfigError) as e:
        config_loader.load("board", config_path=cfg)
    assert "api_token is not set" in str(e.value)


def test_unknown_alias_lists_available(tmp_path, monkeypatch):
    cfg = _write_config(tmp_path, """
        jira:
          board:
            jira_url: https://acme.atlassian.net
            jira_email: me@acme.io
            api_token: t
    """)
    monkeypatch.setattr(scope, "resolve_config_path", lambda *a, **k: cfg)
    with pytest.raises(ConfigError) as e:
        config_loader.load("nope", config_path=cfg)
    assert "board" in str(e.value)


def test_flags_override_config(tmp_path, monkeypatch):
    cfg = _write_config(tmp_path, """
        jira:
          board:
            jira_url: https://acme.atlassian.net
            jira_email: me@acme.io
            api_token: t
            default_project: ABC
    """)
    monkeypatch.setattr(scope, "resolve_config_path", lambda *a, **k: cfg)
    eff = config_loader.load("board", flags={"default_project": "XYZ"}, config_path=cfg)
    assert eff["default_project"] == "XYZ"


def test_list_aliases(tmp_path, monkeypatch):
    cfg = _write_config(tmp_path, """
        jira:
          alpha: {jira_url: https://a.atlassian.net, jira_email: a@a.io, api_token: t}
          beta:  {jira_url: https://b.atlassian.net, jira_email: b@b.io, api_token: t}
    """)
    monkeypatch.setattr(scope, "resolve_config_path", lambda *a, **k: cfg)
    assert config_loader.list_aliases(config_path=cfg) == ["alpha", "beta"]


def test_bmad_path_is_refused(monkeypatch):
    # resolve_config_path must never hand back a bmad/... path.
    monkeypatch.setattr(scope, "resolve_repo_root", lambda: "/repo")
    monkeypatch.setattr(scope, "resolve_active_project", lambda: "sidekicks")
    with pytest.raises(ConfigError):
        scope.resolve_config_path("/repo/bmad/bmm/config.yaml")


def test_missing_config_file_is_empty_not_error(tmp_path, monkeypatch):
    missing = str(tmp_path / "nope.yaml")
    monkeypatch.setattr(scope, "resolve_config_path", lambda *a, **k: missing)
    assert config_loader.list_aliases(config_path=missing) == []
