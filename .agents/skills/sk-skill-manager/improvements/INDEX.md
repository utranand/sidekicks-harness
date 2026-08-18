# Improvements — sk-skill-manager

One line per artifact: id — status — hook.

- 001-export-destination-registry — applied 2026-08-14 — no source-side record of what was exported where; multi-destination `skill_repo`, a derived `skill destinations` verb, and per-skill destination intent in `skill.yaml`
- 002-export-picklist-selection — applied 2026-08-14 — REVIEW asked "which to export" with no mechanism; `scripts/export-picklist.mjs` (`plan` writes a tickable pick list, `resolve` turns the ticks into export commands) and a rewritten REVIEW
- 003-discover-by-intent — applied 2026-08-14 — every path to an uninstalled skill required knowing its NAME; `scripts/skill-search.mjs` (`index` + `find "<intent>"`), a DISCOVER mode, and a description trimmed 1161 -> 1013 chars to fit the triggers under the 1024 cap
