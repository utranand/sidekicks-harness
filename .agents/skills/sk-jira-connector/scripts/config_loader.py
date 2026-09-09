#!/usr/bin/env python3
"""Config loading and alias resolution for sk-jira-connector.

Consumes scope.py for scope-aware, BMAD-isolated config resolution. Implements:
  - Alias resolution under the jira: block (a map of env aliases)
  - Non-secret precedence: CLI flag > scope config.yaml > config.example.yaml defaults
  - api_token from scope config ONLY — never from env vars, never a flag
  - Guided error on missing token
  - Defers to example schema when the whole jira: block is absent
  - Malformed YAML handled gracefully (via scope._load_block)

Secret hygiene: api_token is returned in-process ONLY. It is never printed, logged,
or stored on disk by this module.
"""

import sys

import scope
from scope import ConfigError  # re-export so callers can `from config_loader import ConfigError`

# Non-secret keys that can be overridden by CLI flags (never api_token).
_NON_SECRET_KEYS = (
    "jira_url",
    "jira_email",
    "default_project",
    "default_assignee",
    "cloud_id",
)


def list_aliases(config_path=None):
    """Return sorted list of configured alias names from the scope config.

    Returns an empty list if no config or no jira: block is present.
    ``config_path`` overrides scope resolution (the dispatcher's ``--config`` flag).
    """
    try:
        alias_map = scope.load_alias_map(config_path)
    except ConfigError:
        return []
    return sorted(alias_map.keys())


def _merge_with_example(alias_config):
    """Merge alias_config over the example defaults for non-secret keys.

    The example schema provides fallback values for any key not present in the
    scope config alias block. api_token is stripped from the example (it is always
    blank there) and resolved from the scope config only.
    """
    example_map = scope.load_example_alias_map()
    example_defaults = next(iter(example_map.values()), {}) if example_map else {}

    merged = {}
    for key in _NON_SECRET_KEYS:
        if key in example_defaults and example_defaults[key] is not None:
            merged[key] = example_defaults[key]
        if key in alias_config and alias_config[key] is not None:
            merged[key] = alias_config[key]

    return merged


def load(alias, flags=None, config_path=None):
    """Resolve the effective config dict for `alias`.

    Precedence (highest first):
      1. CLI flags dict (keys matching _NON_SECRET_KEYS, None = not provided)
      2. scope config.yaml jira:<alias> block
      3. config.example.yaml defaults (non-secret keys only)

    api_token is resolved from the scope config ONLY:
      - Missing token (None or blank) -> raises ConfigError with a guided message
      - Present -> returned in-process in the 'api_token' key of the returned dict

    Raises:
        ConfigError if alias not found, YAML malformed, or api_token missing
    """
    if flags is None:
        flags = {}

    alias_map = scope.load_alias_map(config_path)

    if not alias_map:
        effective = _merge_with_example({})
        _apply_flags(effective, flags)
        _require_token(effective, alias, _config_path_for_msg(config_path))
        return effective  # unreachable (above raises), kept for clarity

    if alias not in alias_map:
        available = ", ".join(sorted(alias_map.keys())) or "(none)"
        raise ConfigError(
            f"unknown jira alias '{alias}'. Available aliases: {available}."
        )

    alias_config = alias_map[alias]
    if not isinstance(alias_config, dict):
        raise ConfigError(
            f"jira alias '{alias}' must be a mapping, "
            f"got {type(alias_config).__name__}."
        )

    effective = _merge_with_example(alias_config)
    _apply_flags(effective, flags)

    token = alias_config.get("api_token")
    if token:
        effective["api_token"] = token

    _require_token(effective, alias, _config_path_for_msg(config_path))
    return effective


def _config_path_for_msg(config_path):
    """Resolve the config path for guided error messages."""
    return (scope.resolve_config_path(config_path) if config_path
            else scope.resolve_config_path())


def _apply_flags(effective, flags):
    """Apply CLI flag overrides for non-secret keys (None means not provided)."""
    for key in _NON_SECRET_KEYS:
        value = flags.get(key)
        if value is not None:
            effective[key] = value


def _require_token(effective, alias, config_path):
    """Raise a guided ConfigError if api_token is missing or blank."""
    token = effective.get("api_token")
    if not token:
        raise ConfigError(
            f"jira.{alias}.api_token is not set in the scope config "
            f"({config_path}).\n"
            f"  1. Copy config.example.yaml to that path (if it does not exist).\n"
            f"  2. Add your Atlassian API token as:\n"
            f"       jira:\n"
            f"         {alias}:\n"
            f"           api_token: <your-token>\n"
            f"  Create a token at https://id.atlassian.com/manage-profile/security/api-tokens\n"
            f"  The token is read from config only — never from environment variables."
        )


def cmd_list_envs(config_path=None):
    """Print configured aliases and their non-secret connection details. Exit 0 or 1.

    NEVER prints api_token.
    """
    try:
        alias_map = scope.load_alias_map(config_path)
        config_path = _config_path_for_msg(config_path)
    except ConfigError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1

    if not alias_map:
        print(
            "No Jira environments configured. Copy config.example.yaml to the "
            f"active scope's config.yaml ({config_path}) and define at least "
            "one alias under 'jira:'.",
            file=sys.stderr,
        )
        return 1

    print(f"Configured Jira environments (from {config_path}):")
    for alias in sorted(alias_map.keys()):
        env = alias_map[alias] if isinstance(alias_map[alias], dict) else {}
        url = env.get("jira_url", "?")
        project = env.get("default_project", "?")
        email = env.get("jira_email", "?")
        # api_token is deliberately omitted.
        print(f"  {alias}: {email} @ {url}  default_project={project}")
    return 0
