#!/usr/bin/env python3
"""Scope & secure-config resolver for sk-jira-connector.

Adapted from sk-confluence-connector/scripts/scope.py. The only behavioural
difference is CONFIG_BLOCK_KEY ("jira" instead of "confluence"); everything else —
the .sidekicks/ walk-up, the BMAD exclusion, the example-config fallback — is shared
on purpose so both Atlassian skills resolve scope identically.

resolve_repo_root() uses the .sidekicks/ walk-up instead of `git rev-parse` because a
service src/ is its own git repo; git rev-parse from inside it resolves the wrong root
(the service's git root, not the Sidekicks repo root). Walking up for .sidekicks/ is the
only reliable anchor regardless of git nesting depth.

Responsibilities:
  - Resolve the repo root (.sidekicks/ walk-up; NEVER git rev-parse), the repo-root
    .venv, and the active working folder (sidekicks scope working-folder).
  - Resolve the per-scope Sidekicks project config path from the active scope
    (sidekicks project current): user project -> projects/<active>/config.yaml;
    root project "sidekicks" -> .sidekicks/config.yaml.
  - NEVER read bmad/bmm/config.yaml (or any .../src/bmad/... config) as the Sidekicks
    config.

This module raises ConfigError (rather than calling sys.exit) so callers and tests can
decide how to react.
"""

import json
import os
import subprocess

import yaml

# Directory this script lives in: <skill>/scripts/. The skill root is its parent;
# config.example.yaml lives at the skill root.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_SKILL_DIR = os.path.dirname(_SCRIPT_DIR)
EXAMPLE_CONFIG_PATH = os.path.join(_SKILL_DIR, "config.example.yaml")

# The single config block this skill reads (a map of environment aliases).
CONFIG_BLOCK_KEY = "jira"


class ConfigError(Exception):
    """Raised for an unrecoverable configuration problem (e.g. malformed YAML,
    missing alias, missing token)."""


def _run(cmd):
    """Run a command, return stripped stdout, or None on failure."""
    try:
        out = subprocess.run(
            cmd, capture_output=True, text=True, check=True
        ).stdout.strip()
        return out or None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def resolve_repo_root():
    """Absolute repo root found by walking up the directory tree for .sidekicks/.

    git rev-parse --show-toplevel is NEVER used here, because a service src/ directory
    is frequently its own git repository (acquired via `sidekicks service add`). From
    inside such a directory, git rev-parse returns the service's repo root, not the
    Sidekicks repo root, silently sending every read/write to the wrong tree.

    Walking up for .sidekicks/ is reliable from any depth inside the repo, whether or
    not git is involved.
    """
    current = os.path.abspath(_SCRIPT_DIR)
    while True:
        if os.path.isdir(os.path.join(current, ".sidekicks")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            raise ConfigError(
                "could not resolve the repo root: .sidekicks/ not found in any "
                "parent directory of the script. Run from inside the Sidekicks repo."
            )
        current = parent


def resolve_venv():
    """Path to the single repo-root .venv (never a per-skill venv)."""
    return os.path.join(resolve_repo_root(), ".venv")


def _sidekicks_cli(repo_root):
    return ["node", os.path.join(repo_root, "bin", "sidekicks")]


def resolve_working_folder():
    """Active working folder via `sidekicks scope working-folder`.

    Falls back to the repo root if the CLI is unavailable.
    """
    repo_root = resolve_repo_root()
    wf = _run(_sidekicks_cli(repo_root) + ["scope", "working-folder"])
    return wf or repo_root


def resolve_active_project():
    """Active scope name via `sidekicks project current` (root default: 'sidekicks')."""
    repo_root = resolve_repo_root()
    proj = _run(_sidekicks_cli(repo_root) + ["project", "current"])
    return proj or "sidekicks"


def resolve_config_path(override=None):
    """Resolve the per-scope Sidekicks project config.yaml path.

    user project <active> -> projects/<active>/config.yaml
    root project sidekicks -> .sidekicks/config.yaml

    An explicit ``override`` (e.g. the dispatcher's ``--config <path>``) wins over scope
    resolution. The BMAD-exclusion guard still applies to the override, so ``--config``
    can never be pointed at a bmad/... file.

    NEVER returns a bmad/... path — the BMAD config is explicitly excluded.
    """
    if override:
        path = os.path.abspath(override)
    else:
        repo_root = resolve_repo_root()
        active = resolve_active_project()
        if active == "sidekicks":
            path = os.path.join(repo_root, ".sidekicks", "config.yaml")
        else:
            path = os.path.join(repo_root, "projects", active, "config.yaml")

    normalized = os.path.normpath(path)
    if "bmad" in normalized.split(os.sep):
        raise ConfigError(
            "refusing to read a bmad/... path as the Sidekicks project config"
        )
    return path


def _load_block(path):
    """Load the jira: block (a map of alias -> config) from a YAML file.

    Returns {} if the file is absent/empty or the block is missing. A missing config
    is not itself an error — callers decide how to handle an empty alias map.
    Raises ConfigError on malformed YAML.
    """
    if not path or not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    except yaml.YAMLError as e:
        raise ConfigError(f"malformed YAML in {path}: {e}")
    block = data.get(CONFIG_BLOCK_KEY, {}) if isinstance(data, dict) else {}
    return block if isinstance(block, dict) else {}



def _scope_block(block=None):
    """The block resolved by `sidekicks config get <block> --json`, or None when unavailable.

    THE CLI IS THE RESOLVER, NOT THIS FILE. A scope's configuration is no longer one file: it is a
    committed family file, its git-ignored '.secret.yaml' sibling, the legacy monolith below them,
    and the owning skill's defaults — with root inheritance for the blocks that declare it. Asking
    the CLI is what keeps this skill's answer identical to every other reader's. Reimplementing the
    chain here is how the Python side ended up silently NOT inheriting root for 'slack:'.

    Returns None (not {}) when the CLI cannot answer at all, so the caller can fall back to a direct
    file read — the case that matters when this skill has been lifted into a repo without the CLI.
    """
    out = _run(
        _sidekicks_cli(resolve_repo_root())
        + ["config", "get", block or CONFIG_BLOCK_KEY, "--json", "--reveal"]
    )
    if not out:
        return None
    try:
        payload = json.loads(out)
    except ValueError:
        return None
    cfg = payload.get("config") if isinstance(payload, dict) else None
    return cfg if isinstance(cfg, dict) else None

def load_alias_map(config_path=None):
    """Return the full map of jira aliases from the scope config (may be {}).

    ``config_path`` overrides scope resolution (the dispatcher's ``--config`` flag).
    """
    if config_path:
        return _load_block(resolve_config_path(config_path))
    via_cli = _scope_block()
    if via_cli is not None:
        return via_cli
    return _load_block(resolve_config_path())


def load_example_alias_map():
    """Return the alias map from config.example.yaml (non-secret defaults only)."""
    return _load_block(EXAMPLE_CONFIG_PATH)
