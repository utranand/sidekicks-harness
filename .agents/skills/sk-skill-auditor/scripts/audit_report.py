#!/usr/bin/env python3
"""Render an audit run's RESULT from its ledger — the run's readable exit-status.

The ledger is live resumable state: a flat YAML the loop mutates every round. It is the wrong
artifact to hand a human at the end (nested ids, no narrative, no cross-check) and the wrong artifact
for another run to trend (comments, hand-written scalars, optional keys). So Finalize renders BOTH
from that one source of truth:

  audit-report.md    prose, for the human deciding whether the branch merges
  audit-record.json  normalized schema, for the next run / trend tooling

Deriving both from the ledger keeps them consistent by construction and re-runnable: this script is
pure read + write-two-files, idempotent, and never touches a skill or the ledger.

It also CROSS-CHECKS the ledger's own `summary:` rollup against counts recomputed from `targets:`.
The rollup is hand-written by the agent at Finalize, so it can drift from what the targets actually
say; a silent drift would make the report lie about the run. Mismatches are reported, not smoothed
over (`summary_mismatch` in the record, a warning block in the report) — the recomputed numbers are
the ones both artifacts lead with.

Usage:
  python audit_report.py --ledger <path/to/ledger.yaml> [--out-dir <dir>] [--md-only|--json-only]
                         [--branch <name>] [--quiet]

Writes into the ledger's own directory unless --out-dir is given. Prints each written path.
Exit codes: 0 ok · 2 bad usage/missing ledger · 3 PyYAML unavailable · 4 unparseable ledger.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# Fixed +07:00 rather than a tz database lookup: the repo standard is Asia/Bangkok (no DST), and
# zoneinfo has no tzdata on a bare Windows install — a portable stamp beats a correct-looking crash.
BANGKOK = timezone(timedelta(hours=7), "+07:00")

APPLIED, PARKED, MIXED, CLEAN, FILED = "applied", "parked", "mixed", "clean", "filed"
SCHEMA_VERSION = 1


def now_stamp() -> str:
    return datetime.now(BANGKOK).strftime("%Y-%m-%dT%H:%M:%S%z").replace("+0700", "+07:00")


def load_ledger(path: Path) -> dict:
    try:
        import yaml
    except ImportError:
        sys.stderr.write(
            "audit_report: PyYAML unavailable — run with the repo-root .venv python "
            "(pip install pyyaml into .venv, never a per-skill venv)\n"
        )
        raise SystemExit(3)
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:  # malformed YAML mid-run is a real failure mode, not a crash
        sys.stderr.write(f"audit_report: cannot parse {path}: {exc}\n")
        raise SystemExit(4)
    if not isinstance(data, dict):
        sys.stderr.write(f"audit_report: {path} is not a ledger mapping\n")
        raise SystemExit(4)
    return data


def as_list(value) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def scalar(value):
    """Ledger value → a display/JSON-safe scalar.

    PyYAML resolves `2026-07-30T09:00:00+07:00` into a datetime and `true` into a bool, so a naive
    str() would print `2026-07-30 09:00:00+07:00` and `True` — neither matches the ISO-8601 +07:00 and
    lowercase-YAML forms the rest of the run's artifacts use. Normalize back to the source spelling so
    a stamp copied out of the report or the record still round-trips.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(k): scalar(v) for k, v in value.items()}
    if isinstance(value, list):
        return [scalar(v) for v in value]
    return value


def flatten(value) -> str:
    """A structured ledger entry (issues, runtime_errors) → one readable line, never a Python repr."""
    norm = scalar(value)
    if isinstance(norm, dict):
        return " · ".join(f"**{k}**: {v}" for k, v in norm.items() if v not in (None, "", []))
    if isinstance(norm, list):
        return "; ".join(flatten(v) for v in norm)
    return str(norm)


def id_of(entry) -> str:
    """parked_ids/applied_ids carry either a bare id or {id, reason} — accept both."""
    if isinstance(entry, dict):
        return str(entry.get("id") or entry.get("finding") or "?")
    return str(entry)


def reason_of(entry) -> str:
    if isinstance(entry, dict):
        return str(entry.get("reason") or entry.get("why") or "")
    return ""


def normalize_target(raw) -> dict:
    """One target's ledger entry → the record schema (missing keys tolerated, never invented)."""
    t = raw if isinstance(raw, dict) else {}
    trig = t.get("trigger_eval") if isinstance(t.get("trigger_eval"), dict) else {}
    filed = [id_of(x) for x in as_list(t.get("filed_ids"))]
    applied = [id_of(x) for x in as_list(t.get("applied_ids"))]
    parked = [{"id": id_of(x), "reason": reason_of(x) or "unspecified"} for x in as_list(t.get("parked_ids"))]
    dropped = [
        {
            "finding": str(x.get("finding", x)) if isinstance(x, dict) else str(x),
            "reason": reason_of(x) or "unspecified",
        }
        for x in as_list(t.get("no_file"))
    ]
    rounds = [r for r in as_list(t.get("rounds")) if isinstance(r, dict)]
    return {
        "skill": str(t.get("skill", "?")),
        "status": str(t.get("status", "?")),
        "outcome": t.get("outcome"),
        "started_at": scalar(t.get("started_at")),
        "finished_at": scalar(t.get("finished_at")),
        "log": t.get("log"),
        "attempts": t.get("attempts", 0),
        "rounds_run": t.get("rounds_run", len(rounds)),
        "dry_streak": t.get("dry_streak", 0),
        "converged": t.get("converged"),
        "filed_ids": filed,
        "verified_ids": [id_of(x) for x in as_list(t.get("verified_ids"))],
        "applied_ids": applied,
        "parked": parked,
        "dropped": dropped,
        "rounds": [scalar(r) for r in rounds],
        "issues": scalar(as_list(t.get("issues"))),
        "trigger_eval": {
            "eval_set_size": trig.get("eval_set_size"),
            "eval_set_id": trig.get("eval_set_id"),
            "baseline_score": scalar(trig.get("baseline_score")),
            "baseline_score_replicated": scalar(trig.get("baseline_score_replicated")),
            "best_score": scalar(trig.get("best_score")),
            "best_score_replicated": scalar(trig.get("best_score_replicated")),
            "candidates_tried": trig.get("candidates_tried", 0),
            "winning_desc_id": trig.get("winning_desc_id"),
            "converged": trig.get("converged"),
        },
    }


def recount(targets: list[dict]) -> dict:
    """Counts derived from the targets themselves — the numbers the artifacts lead with."""
    done = [t for t in targets if t["status"] == "done"]
    failed = [t for t in targets if t["status"] == "failed"]
    return {
        "targets_total": len(targets),
        # "skills the loop actually PROCESSED" — a target that died at max_attempts was audited (badly),
        # so it counts here and again under `failed`. Excluding it would undercount the sweep and
        # manufacture a phantom disagreement with the ledger's own rollup on every run that lost a skill.
        "audited": len(done) + len(failed),
        "filed": sum(len(t["filed_ids"]) for t in targets),
        "applied": sum(len(t["applied_ids"]) for t in targets),
        "parked": sum(len(t["parked"]) for t in targets),
        "dropped": sum(len(t["dropped"]) for t in targets),
        "clean": len([t for t in done if t["outcome"] == CLEAN]),
        "failed": len(failed),
        "pending": len([t for t in targets if t["status"] in ("pending", "in_progress")]),
        "rounds_total": sum(int(t["rounds_run"] or 0) for t in targets),
        "not_converged": [t["skill"] for t in targets if t["converged"] is False],
    }


def summary_mismatch(declared, derived: dict) -> dict:
    """Ledger `summary:` vs recomputed — only the keys that actually disagree."""
    if not isinstance(declared, dict):
        return {}
    out = {}
    for key, got in derived.items():
        if key in declared and declared[key] != got:
            out[key] = {"ledger_summary": declared[key], "recomputed": got}
    return out


def branch_from_notes(notes: list, override: str | None) -> str | None:
    """START records the run's feature branch in `notes`; recover it for the review instructions.

    Two-tier recovery, because the recovered name carries the report's "nothing landed on `main`"
    paragraph: prefer the canonical `branch: <name>` note line START mandates, then fall back to
    scanning prose for a `chore/audit-…` token (older ledgers wrote it inline). Punctuation is
    stripped from both ends — a note like `scope: core (branch chore/audit-x)` otherwise yields a
    trailing `)`, i.e. a ref git will reject, and a `branch=…` form used to return None, which
    silently dropped the whole paragraph from the mid-run refresh (which passes no --branch).
    """
    if override:
        return override
    edges = "`.,;:()[]<>'\""
    for note in notes:
        text = str(note).strip()
        low = text.lower()
        if low.startswith("branch:") or low.startswith("branch="):
            candidate = text.split(":", 1)[-1] if low.startswith("branch:") else text.split("=", 1)[-1]
            candidate = candidate.strip().split()[0].strip(edges) if candidate.strip() else ""
            if candidate:
                return candidate
    for note in notes:
        for token in str(note).replace(",", " ").replace("`", " ").split():
            token = token.strip(edges)
            for prefix in ("chore/audit-", "chore/skill-audit"):
                # `in`, not `startswith`: an inline `branch=chore/audit-x` token would otherwise miss,
                # and that form returning None is what dropped the paragraph entirely.
                if prefix in token:
                    return token[token.index(prefix):].strip(edges)
    return None


def build_record(ledger: dict, targets: list[dict], derived: dict, branch: str | None) -> dict:
    return {
        "schema": SCHEMA_VERSION,
        "kind": "skill-audit-record",
        "generated_at": now_stamp(),
        "run": ledger.get("run"),
        "mode": ledger.get("mode"),
        "status": ledger.get("status"),
        "control_stage": (ledger.get("control") or {}).get("stage") if isinstance(ledger.get("control"), dict) else None,
        "started_at": scalar(ledger.get("started_at")),
        "finished_at": scalar(ledger.get("finished_at")),
        "branch": branch,
        "notes": [str(n) for n in as_list(ledger.get("notes"))],
        "runtime_errors": scalar(as_list(ledger.get("runtime_errors"))),
        "summary": derived,
        "summary_mismatch": summary_mismatch(ledger.get("summary"), derived),
        "needs_human": [
            {"skill": t["skill"], "id": p["id"], "reason": p["reason"]}
            for t in targets
            for p in t["parked"]
        ],
        "targets": targets,
    }


def md_escape(text) -> str:
    return str(text).replace("|", "\\|").replace("\n", " ").strip()


def fmt(value, dash: str = "—") -> str:
    if value is None or value == "" or value == []:
        return dash
    return str(scalar(value))


def build_report(record: dict, targets: list[dict], ledger_rel: str) -> str:
    s = record["summary"]
    L: list[str] = []
    add = L.append

    add(f"# Skill audit result — `{fmt(record['run'])}`")
    add("")
    add(f"_Generated {record['generated_at']} from `{ledger_rel}` (Asia/Bangkok). "
        "Regenerate any time — this file is derived, never hand-edited._")
    add("")
    add(f"**{s['audited']}/{s['targets_total']} skills audited** · "
        f"**{s['applied']} applied** · **{s['parked']} parked for a human** · "
        f"**{s['clean']} clean** · **{s['failed']} failed** · "
        f"{s['filed']} findings filed, {s['dropped']} dropped · {s['rounds_total']} rounds total")
    add("")
    add(f"Mode `{fmt(record['mode'])}` · run status `{fmt(record['status'])}` · "
        f"started {fmt(record['started_at'])} · finished {fmt(record['finished_at'])}")
    if record["branch"]:
        add("")
        # Say what the branch ACTUALLY carries. Gating on the branch alone asserted "auto-applied edits"
        # for two reachable states where none exist: any classic run (which applies nothing by
        # construction) and a clean autonomous sweep (which files nothing — and since artifacts/runs/ is
        # git-ignored, commits nothing at all, so the operator was sent to review an empty diff). A clean
        # sweep is the outcome this skill calls first-class, so the report must not misdescribe it.
        # Every value below is already in scope: s["applied"], s["filed"], record["mode"].
        if s["applied"]:
            what = (f"Auto-applied edits are committed on branch **`{record['branch']}`**")
        elif s["filed"]:
            what = (f"**{s['filed']} finding(s) awaiting a human** are committed on branch "
                    f"**`{record['branch']}`** — this run applied nothing")
        else:
            what = (f"Branch **`{record['branch']}`** carries no changes: nothing was filed, which is a "
                    "first-class outcome — the evidence justified no improvement")
        add(f"{what} — **nothing landed on `main`.** The git diff on that branch is the review; "
            "merging is the operator's call.")
    add("")

    if s["pending"]:
        add(f"> **Run is not finished** — {s['pending']} target(s) still `pending`/`in_progress`. "
            "These counts describe the run so far.")
        add("")
    if record["summary_mismatch"]:
        add("> **Ledger rollup disagrees with its own targets** — the numbers above are recomputed from "
            "`targets:`; the hand-written `summary:` block is stale for: "
            + ", ".join(f"`{k}` ({v['ledger_summary']} → {v['recomputed']})"
                        for k, v in record["summary_mismatch"].items()))
        add("")

    # Parked first: this is the only part of an autonomous run that genuinely needs a human.
    add("## Needs a human — parked findings")
    add("")
    if record["needs_human"]:
        add("The safety floor / failed verification refused these; they stay `proposed` until a human "
            "decides. Review each with `sk-self-improve`.")
        add("")
        add("| Skill | Finding id | Why parked |")
        add("|---|---|---|")
        for p in record["needs_human"]:
            add(f"| `{md_escape(p['skill'])}` | `{md_escape(p['id'])}` | {md_escape(p['reason'])} |")
    else:
        add("Nothing parked — no finding hit the safety floor or failed verification.")
    add("")

    add("## Per-skill result")
    add("")
    add("| Skill | Outcome | Rounds | Converged | Applied | Parked | Dropped | Trigger eval |")
    add("|---|---|---|---|---|---|---|---|")
    for t in targets:
        trig = t["trigger_eval"]
        base, best = fmt(trig["baseline_score"]), fmt(trig["best_score"])
        trig_cell = base if base == best else f"{base} → {best}"
        if trig["winning_desc_id"]:
            trig_cell += f" (rewrote: `{md_escape(trig['winning_desc_id'])}`)"
        outcome = t["outcome"] or t["status"]
        add(f"| `{md_escape(t['skill'])}` | {md_escape(outcome)} | {fmt(t['rounds_run'], '0')} | "
            f"{fmt(t['converged'])} | {len(t['applied_ids'])} | {len(t['parked'])} | "
            f"{len(t['dropped'])} | {trig_cell} |")
    add("")

    for t in targets:
        add(f"### `{t['skill']}` — {fmt(t['outcome'] or t['status'])}")
        add("")
        add(f"- status `{t['status']}` · attempts {fmt(t['attempts'], '0')} · "
            f"rounds {fmt(t['rounds_run'], '0')} (dry streak {fmt(t['dry_streak'], '0')}, "
            f"converged {fmt(t['converged'])})")
        if t["log"]:
            add(f"- trail: `{t['log']}`")
        trig = t["trigger_eval"]
        if trig["baseline_score"] or trig["best_score"]:
            add(f"- triggering benchmark: baseline {fmt(trig['baseline_score'])} → best "
                f"{fmt(trig['best_score'])} over {fmt(trig['candidates_tried'], '0')} candidate(s) "
                f"on {fmt(trig['eval_set_size'])} queries (converged {fmt(trig['converged'])})")
        if t["applied_ids"]:
            add(f"- **applied** (already on the branch): {', '.join('`' + md_escape(i) + '`' for i in t['applied_ids'])}")
        if t["parked"]:
            for p in t["parked"]:
                add(f"- **parked** `{md_escape(p['id'])}` — {md_escape(p['reason'])}")
        filed_only = [i for i in t["filed_ids"]
                      if i not in t["applied_ids"] and i not in [p["id"] for p in t["parked"]]]
        if filed_only:
            add(f"- filed, awaiting a human: {', '.join('`' + md_escape(i) + '`' for i in filed_only)}")
        if t["dropped"]:
            add("- dropped by the gates (recorded so a clean sweep is distinguishable from a sweep that "
                "never looked):")
            for d in t["dropped"]:
                add(f"  - {md_escape(d['finding'])} — _{md_escape(d['reason'])}_")
        if t["issues"]:
            for issue in t["issues"]:
                add(f"- **issue**: {md_escape(flatten(issue))}")
        if not (t["applied_ids"] or t["parked"] or filed_only or t["dropped"]):
            if t["status"] in ("pending", "in_progress"):
                # Never report an unaudited skill as "clean" — that would launder a half-finished sweep
                # into a healthy-registry claim.
                add(f"- **not audited** — still `{t['status']}` when this report was generated.")
            else:
                add("- nothing filed — the evidence justified no change (a healthy result).")
        if t["rounds"]:
            add("")
            add("| Round | At | Tier | Focus | Candidates | Filed | Applied | Parked |")
            add("|---|---|---|---|---|---|---|---|")
            for idx, r in enumerate(t["rounds"]):
                add(f"| {r.get('round', idx)} | {md_escape(fmt(r.get('at')))} | "
                    f"{md_escape(fmt(r.get('tier')))} | {md_escape(fmt(r.get('focus')))} | "
                    f"{md_escape(fmt(r.get('candidates'), '0'))} | {md_escape(fmt(r.get('filed'), '0'))} | "
                    f"{md_escape(fmt(r.get('applied'), '0'))} | {md_escape(fmt(r.get('parked'), '0'))} |")
        add("")

    if record["runtime_errors"]:
        add("## Runtime errors")
        add("")
        for err in record["runtime_errors"]:
            add(f"- {md_escape(flatten(err))}")
        add("")

    if record["notes"]:
        add("## Run notes")
        add("")
        for note in record["notes"]:
            add(f"- {md_escape(note)}")
        add("")

    if s["not_converged"]:
        add(f"**Did not converge** (stopped on `max_rounds_per_skill`): "
            + ", ".join(f"`{x}`" for x in s["not_converged"])
            + " — the well was not dry; a follow-up run may still find something.")
        add("")

    add("---")
    add("")
    add(f"Ledger (resumable state): `{ledger_rel}` · machine record: `audit-record.json`")
    return "\n".join(L) + "\n"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Render audit-report.md + audit-record.json from a ledger")
    ap.add_argument("--ledger", required=True, help="path to the run's ledger.yaml")
    ap.add_argument("--out-dir", help="output directory (default: the ledger's directory)")
    ap.add_argument("--branch", help="feature branch the run's edits are committed on")
    ap.add_argument("--md-only", action="store_true", help="write only audit-report.md")
    ap.add_argument("--json-only", action="store_true", help="write only audit-record.json")
    ap.add_argument("--quiet", action="store_true", help="suppress the written-path lines")
    args = ap.parse_args(argv)

    if args.md_only and args.json_only:
        sys.stderr.write("audit_report: --md-only and --json-only are mutually exclusive\n")
        return 2

    ledger_path = Path(args.ledger).expanduser()
    if not ledger_path.is_file():
        sys.stderr.write(f"audit_report: no ledger at {ledger_path}\n")
        return 2

    ledger = load_ledger(ledger_path)
    targets = [normalize_target(t) for t in as_list(ledger.get("targets"))]
    derived = recount(targets)
    branch = branch_from_notes([str(n) for n in as_list(ledger.get("notes"))], args.branch)
    record = build_record(ledger, targets, derived, branch)

    out_dir = Path(args.out_dir).expanduser() if args.out_dir else ledger_path.parent
    out_dir.mkdir(parents=True, exist_ok=True)

    # Portable paths only: reference the ledger relatively when it sits beside the outputs, so nothing
    # machine-absolute is persisted into either artifact.
    try:
        ledger_rel = str(ledger_path.resolve().relative_to(out_dir.resolve()))
    except ValueError:
        ledger_rel = ledger_path.name

    written = []
    if not args.json_only:
        md_path = out_dir / "audit-report.md"
        md_path.write_text(build_report(record, targets, ledger_rel), encoding="utf-8")
        written.append(md_path)
    if not args.md_only:
        json_path = out_dir / "audit-record.json"
        json_path.write_text(json.dumps(record, indent=2, ensure_ascii=False, default=str) + "\n",
                             encoding="utf-8")
        written.append(json_path)

    if not args.quiet:
        for path in written:
            print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
