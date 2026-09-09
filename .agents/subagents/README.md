# CLI-neutral subagents

This is the canonical Sidekicks subagent surface. Each Markdown file uses
YAML-style frontmatter with provider-neutral fields:

- `name`: stable agent identifier.
- `description`: host-independent routing description.
- `capabilities`: comma-separated logical capabilities (`read`, `search`,
  `glob`, `shell`, `edit`, `write`, `skills`, `web_search`, `web_fetch`).
- `model_tier`: `top`, `high`, `mid`, `low`, or `inherit`.

Run `node scripts/generate-subagent-ports.mjs` after changing a definition.
The generator writes the Claude Code, Codex CLI, and Antigravity projections;
`--check` verifies that committed projections have not drifted. Claude model
aliases and Codex reasoning effort are adapter details and never belong here.

Gemini is the next intended projection. It remains absent until Gemini exposes
a stable custom-agent schema; when that happens, extend the same generator
instead of creating a Gemini-owned canonical tree.
