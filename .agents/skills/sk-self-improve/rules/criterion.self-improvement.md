# Skill self-improvement — opt-in, externally triggered

> Framework criterion `criterion.self-improvement`, owned by `sk-self-improve`.
> Extracted from `CLAUDE.md` (AAP-93) so the policy travels with the skill that implements it.
> Inspect with `sidekicks framework show criterion.self-improvement`; turn it off with
> `sidekicks framework disable criterion.self-improvement`.
> **Lifted out of this repo, with no framework resolver present, this rule is simply in force.**

**Mission (alignment target):** improvements make skills more reliable, evidence-grounded, lean,
and safe — in priority order: safety never traded away; reliable over clever; evidence over
opinion; explain the why; leaner is more reliable; trigger accurately; stay portable; compose,
don't duplicate; converge, don't churn.

**Self-improvement is opt-in and externally triggered** — skills never self-trigger a harvest.
After a substantive run of a listed skill, invoke `sk-self-improve` (PROPOSE) at the
**high** tier with the run's artifacts as `source`. Attribution gate: file only failures
attributable to the *skill's own behavior* (input-caused failures only when the skill should have
guarded).

Protected set — funnel-gated for automation (humans may free-edit any skill via `skill-creator`):

```
self-improvement enabled for:
  - sk-get-things-done
  - sk-get-plan-done
  - sk-cli-orchestrator
  - sk-cli-executor
  - sk-fable-mission
```

**Skill optimization is a manual loop only** — drive `run_eval.py` (which uses `claude -p`)
yourself; never `run_loop.py`'s `anthropic.Anthropic()` proposer, which needs a billed API key.
Run evals from a neutral `/tmp` root with its own empty `.claude/`, and `--num-workers 1`.
