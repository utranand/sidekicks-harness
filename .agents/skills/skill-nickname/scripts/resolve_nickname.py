#!/usr/bin/env python3
"""Resolve a Sidekicks skill nickname to its full skill name.

Merges the bundled default alias map (../assets/nicknames.yaml, relative to this
script) with the active project's Sidekicks config overrides, then looks up the
requested alias. Project overrides win over bundled defaults.

Usage:
    resolve_nickname.py <alias>     # -> prints resolved skill name, exit 0
                                    #    unknown alias -> suggestions to stderr, exit 1
    resolve_nickname.py --list      # -> prints the full merged alias table, exit 0

Run it with the repository-root virtualenv interpreter (absolute path), e.g.
    "$ROOT/.venv/bin/python" resolve_nickname.py gtd
so PyYAML is available regardless of which shell invoked the skill.
"""
import subprocess
import sys
import json
import difflib
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: PyYAML missing — run with the repo-root .venv interpreter "
          "($ROOT/.venv/bin/python)", file=sys.stderr)
    sys.exit(2)

SCRIPT_DIR = Path(__file__).resolve().parent
BUNDLED = SCRIPT_DIR.parent / "assets" / "nicknames.yaml"


def repo_root(start: Path) -> Path:
    """Walk up until we find the repo root (the dir holding .sidekicks/)."""
    for parent in [start, *start.parents]:
        if (parent / ".sidekicks").is_dir():
            return parent
    # Fallback: the skill lives at .agents/skills/skill-nickname/scripts/,
    # so the root is four levels up from this script.
    return SCRIPT_DIR.parents[3]


def load_yaml(path: Path) -> dict:
    try:
        with open(path) as f:
            return yaml.safe_load(f) or {}
    except FileNotFoundError:
        return {}
    except Exception as e:  # malformed file is never fatal — defer to what loads
        print(f"warn: could not parse {path}: {e}", file=sys.stderr)
        return {}


def load_json(path: Path) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return {}


def aliases_from(cfg: dict) -> dict:
    """Pull the alias map out of a config/asset doc, tolerating three shapes:
    a nested `skill_nickname: {aliases: {...}}` (preferred for a project's
    Sidekicks config, namespaced like the other skill configs), a bare
    top-level `aliases: {...}` (the bundled defaults file), or a bare top-level
    `nicknames: {...}`. Later sources override earlier ones.
    """
    out = {}
    out.update(cfg.get("aliases") or {})
    out.update((cfg.get("skill_nickname") or {}).get("aliases") or {})
    out.update(cfg.get("nicknames") or {})
    return out


def scope_config(root: Path) -> dict:
    """The scope's nickname configuration, shaped so aliases_from() reads it unchanged.

    THE CLI IS THE RESOLVER: the block now lives in the committed `config/skills.yaml` of the active
    scope, above the retired monolith, and `skill_nickname` records `nicknames` as a legacy alias so a
    scope configured the old way still resolves. Asking `sidekicks config get` is what keeps this
    script's answer identical to the engine's; the direct read below is the fallback for a copy lifted
    into a repo without the CLI.
    """
    try:
        out = subprocess.run(
            ["node", str(root / "bin" / "sidekicks"), "config", "get", "skill_nickname", "--json"],
            capture_output=True, text=True, check=True,
        ).stdout
        payload = json.loads(out)
        cfg = payload.get("config")
        if isinstance(cfg, dict):
            # `config get` returns the BLOCK body, so re-nest it under the block name that
            # aliases_from() looks for.
            return {"skill_nickname": cfg}
    except (subprocess.CalledProcessError, FileNotFoundError, OSError, ValueError):
        pass

    settings = load_json(root / ".sidekicks" / "settings.json")
    active = (settings or {}).get("active_project") or "sidekicks"
    base = root / ".sidekicks" if active == "sidekicks" else root / "projects" / active
    for candidate in (base / "config" / "skills.yaml", base / "config.yaml"):
        cfg = load_yaml(candidate)
        if cfg:
            return cfg
    return {}


def norm(alias: str) -> str:
    return alias.strip().lstrip("/").lower()


def build_table() -> dict:
    """Merged alias -> skill-name map; project overrides shadow bundled defaults."""
    root = repo_root(SCRIPT_DIR)
    bundled = aliases_from(load_yaml(BUNDLED))

    overrides = aliases_from(scope_config(root))

    table = {}
    for src in (bundled, overrides):
        for k, v in src.items():
            if v:
                table[norm(k)] = str(v).strip()
    return table


def known_skills(root: Path) -> set:
    """Best-effort live skill list from the git-ignored root index cache.
    Empty set when the index is absent/stale — callers treat that as 'unknown',
    never as 'invalid', so a missing cache never blocks a resolve.
    """
    idx = load_json(root / ".sidekicks" / "index.json")
    return set(idx.get("skills") or [])


def main() -> int:
    args = sys.argv[1:]
    table = build_table()

    if args and args[0] == "--list":
        if not table:
            print("(no aliases defined)")
            return 0
        width = max(len(a) for a in table)
        for alias in sorted(table):
            print(f"{alias.ljust(width)}  ->  {table[alias]}")
        return 0

    if not args:
        print("usage: resolve_nickname.py <alias> | --list", file=sys.stderr)
        return 64

    alias = norm(args[0])
    skill = table.get(alias)
    if skill:
        # Soft cross-check against the live skill list, when we have one.
        skills = known_skills(repo_root(SCRIPT_DIR))
        if skills and skill not in skills:
            print(f"warn: '{skill}' not found in the current skills index — "
                  f"alias may be stale", file=sys.stderr)
        print(skill)
        return 0

    # Unknown alias: offer the closest known aliases so the agent can suggest.
    close = difflib.get_close_matches(alias, table.keys(), n=5, cutoff=0.4)
    print(f"error: no alias '{alias}'", file=sys.stderr)
    if close:
        print("did you mean: " + ", ".join(close), file=sys.stderr)
    else:
        print("run with --list to see all aliases", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
