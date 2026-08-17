# Improvements — sk-commander

One line per artifact: id — status — hook.

- 001-ralph-arm-guard-when-plugin-absent — applied 2026-06-19 (VERSION.json 1.0.0→1.0.1, auto-verified 2/3) — ralph-arm exemplar now wraps the arm in an if/elif/else guarding plugin-absent (run normally) + already-armed (don't double-arm), matching the prose
- 002-service-pull-is-registry-mutating — applied 2026-06-26 (VERSION.json 1.0.1→1.1.0, batch AAP-1) — added `service pull` to the scope-race registry-mutating verb list (`service add/remove/use` → `service add/pull/remove/use`), so the Step-3 pre-flight catches two pulls in one wave; aligns with the paired planner + service.mjs [jira:AAP-22]
- 003-set-remote-is-registry-mutating — applied 2026-06-26 (VERSION.json 1.0.1→1.1.0, batch AAP-1) — added `project set-remote` to the same list (`project create/add/remove/use` → `…/set-remote`), so the pre-flight catches two set-remotes in one wave (race the root index + root-repo .gitmodules) [jira:AAP-23]
- 004-step3a-extract-embedded-anchor-before-helper — applied 2026-06-26 (VERSION.json 1.0.1→1.1.0, batch AAP-1) — rewrote Step 3a to split BARE vs EMBEDDED anchors: for `docs_dir=`/`artifacts_dir=` tokens the model must EXTRACT the value, pass only it to the helper, then splice the resolved path back (helper doesn't parse tokens). Prose-only; resolve-anchor.mjs untouched [jira:AAP-24]
- 005-leading-dot-definition-omits-bare-dotdot — applied 2026-06-26 (VERSION.json 1.0.1→1.1.0, batch AAP-1) — added bare `..` to the file-relative anchor definition (now "`.` or `..`, or begins with `./` or `../`"), aligning the prose with the bundled resolve-anchor.mjs isLeadingDot [jira:AAP-25]
