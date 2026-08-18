
## Withheld: `.sidekicks/index.json` (declared by `sk-git-sweep`)

`sk-git-sweep` declares `.sidekicks/index.json` under
`requires.framework_files`, and that declaration is correct — the skill reads the
file at runtime. A reference copy is **deliberately not published here.**

That file is the **machine-local, git-ignored registry cache** of whichever
checkout the export ran from. It is not part of the recorded `source_commit`, so a
fresh clone at that commit could never reproduce its bytes, and its contents
describe the exporting machine's own inventory rather than anything about this
skill set.

The skill degrades gracefully without it — see the `degraded:` note on its
`requires.framework_files` entry: candidate enumeration falls back to a bounded
filesystem scan, and the missing-file read returns null rather than throwing.

**At the destination:** nothing to reconcile. The file is generated locally by
`sidekicks index rebuild` (and self-heals on CLI invocation) in whatever repo
installs this skill.
