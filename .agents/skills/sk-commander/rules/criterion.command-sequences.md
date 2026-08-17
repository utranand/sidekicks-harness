# A command-sequence exists to be executed

> Framework criterion `criterion.command-sequences`, owned by `sk-commander`.
> Extracted from `CLAUDE.md` (AAP-93). Inspect with
> `sidekicks framework show criterion.command-sequences`; turn it off with
> `sidekicks framework disable criterion.command-sequences`.

A command-sequence — a file with a top-level `steps:` key and the
`▶ RUN THIS … sk-commander ◀` banner, authored by `sk-sequence-planner` — exists to
be **executed**.

When handed one — even as a bare path, or with nothing more than "go" — invoke
**`sk-commander`**. Never run the steps by hand, and never review it as if it were a
document.

To author or validate one, that is `sk-sequence-planner`, not commander.
