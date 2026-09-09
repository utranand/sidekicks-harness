# Fable-mind — load the checkpoint layer on a non-Fable-class model

> Framework criterion `criterion.fable-mind`, owned by the `fable-mind` skill.
> Extracted from `AGENTS.md` (AAP-93). Inspect with
> `sidekicks framework show criterion.fable-mind`; turn it off with
> `sidekicks framework disable criterion.fable-mind`.

**Conditional, on the driving model:** if the driving model is NOT Fable/Mythos-class, load
`.agents/skills/fable-mind/SKILL.md` at session start. It turns AGENTS.md's ten standing
session practices (`criterion.session-practices`) into explicit checkpoints that a
fixed-thinking model actually runs.

On a Fable/Mythos-class model, skip it — those practices are native there, and the extra layer
only adds noise.

Analysis and per-CLI notes:
[docs/guide/fable-era-session-practices.md](docs/guide/fable-era-session-practices.md).
