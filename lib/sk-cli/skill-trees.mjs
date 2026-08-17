// lib/sk-cli/skill-trees.mjs
// WHERE SKILLS LIVE — the single source of truth for the canonical skill tree, the parked-skill
// tree, the per-CLI exposure links, and the first-party skill-id prefix.
//
// Before this module the answer was spelled out 557 times across ~120 files, in four different
// shapes (a `.sidekicks/skills` literal, a `['.sidekicks','skills']` segment array, a join() call,
// and a /\.sidekicks\/skills\// regex), with at least four straight duplicates between modules that
// did not import each other. Relocating the tree meant finding every one of them; the point of this
// file is that the next relocation is one edit here.
//
// DELIBERATELY A DATA-ONLY LEAF. lib/sk-cli/ imports nothing outside itself and is loaded on
// EVERY CLI invocation, which is exactly why the constants live here rather than in
// lib/framework-settings/ (which already imports from here) — putting them anywhere else would
// either add a back-edge or force a second copy. No node:* imports either: consumers own their own
// join()/existsSync(), so this module costs nothing to load.
//
// The two trees have DIFFERENT PARENTS, and that is not an oversight. Skills are canonical under
// .agents/ — the CLI-neutral standard location every AGENTS.md-era agent CLI reads directly. The
// PARKED tree stays under .sidekicks/ precisely because an offloaded skill must be invisible to
// skill discovery: parking it beside the canonical tree is what a host CLI would pick up anyway.

/** Canonical skills tree, as path segments. Join against the repo root. */
export const SKILLS_ROOT_SEGMENTS = Object.freeze([".agents", "skills"]);

/** Canonical skills tree, repo-relative, POSIX-spelled (for .gitignore lines, globs, messages). */
export const SKILLS_ROOT_REL = ".agents/skills";

/** Parked ("offloaded") skills tree — present on disk, deliberately outside discovery. */
export const OFFLOAD_ROOT_SEGMENTS = Object.freeze([".sidekicks", "skill-offloaded"]);

/** Parked skills tree, repo-relative, POSIX-spelled. */
export const OFFLOAD_ROOT_REL = ".sidekicks/skill-offloaded";

/**
 * Both trees a skill may legitimately occupy, in LOOKUP ORDER — active first, parked second.
 * Order is load-bearing: `skill import` and `skill heal` resolve a bare name against this list and
 * must find an active skill before a parked one of the same name.
 */
export const SKILL_TREES = Object.freeze([SKILLS_ROOT_REL, OFFLOAD_ROOT_REL]);

/**
 * The basenames `skill import --into` accepts, mapped to their tree. The flag's vocabulary is the
 * basename, not the path, so it survives a relocation of either parent unchanged.
 */
export const SKILL_TREE_BY_BASENAME = Object.freeze({
  skills: SKILLS_ROOT_REL,
  "skill-offloaded": OFFLOAD_ROOT_REL,
});

/**
 * Host-level exposure directories — one per supported agent CLI — that are LINKS to the canonical
 * tree. Adding support for a new CLI means adding one entry here.
 *
 * `.agents/skills` is deliberately ABSENT: it IS the canonical tree. An entry pointing at its own
 * target would resolve true in linkResolvesTo() and then be replaced by a symlink to itself on the
 * first repair pass — a self-referential loop where the skills used to be.
 */
export const EXPOSURE_LINKS = Object.freeze([
  Object.freeze([".claude", "skills"]), // Claude Code
  Object.freeze([".agent", "skills"]), // Antigravity
  Object.freeze([".gemini", "skills"]), // Gemini CLI
]);

/** The exposure links as repo-relative POSIX paths — for .gitignore lines and messages. */
export const EXPOSURE_LINK_RELS = Object.freeze(
  EXPOSURE_LINKS.map((segs) => segs.join("/"))
);

/**
 * The first-party skill-id prefix. A run's artifact FACET is the skill id minus this prefix, so
 * changing it changes where every future run writes — see deriveFacet in lib/active-scope/run-base.mjs.
 *
 * The facet VALUES are unchanged by the sidekicks- → sk- rename (`sk-jira-connector` still strips to
 * `jira-connector`), which is the whole reason existing run trees keep resolving.
 */
export const SKILL_PREFIX = "sk-";

/**
 * The prefix first-party skills carried before the sk- rename.
 *
 * Kept because run records, ledgers and artifact banners already written to disk carry it forever —
 * anything READING that history has to understand both spellings. Nothing new is ever written with
 * it, and it is deliberately not part of SKILL_PREFIX's job: resolution uses the current prefix,
 * history-reading accepts either.
 */
export const LEGACY_SKILL_PREFIX = "sidekicks-";

/**
 * The bmad family shares ONE facet. Kept beside the prefix because the two are read together
 * everywhere the facet is derived, and they drifted apart once already.
 */
export const BMAD_FAMILY_ID = "sk-bmad";

/**
 * Strip the first-party prefix from a skill id. Third-party skills (`caveman`, `skill-creator`, …)
 * carry no prefix and pass through unchanged, which is the whole reason this is a guard and not a
 * slice.
 * @param {string} skillId
 * @returns {string}
 */
export function stripSkillPrefix(skillId) {
  return skillId.startsWith(SKILL_PREFIX)
    ? skillId.slice(SKILL_PREFIX.length)
    : skillId;
}
