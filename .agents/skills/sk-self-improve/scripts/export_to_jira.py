#!/usr/bin/env python3
"""Export proposed skill-improvement artifacts as Jira subtasks.

The EXPORT mode of sk-self-improve. Two subcommands:

  scan    Walk every skill's improvements/ folder, collect the artifacts that are
          `status: proposed` (the ones awaiting a human decision), and print them as a
          pick-list (table) or JSON. Already-exported artifacts (those carrying a
          `jira_subtask:` key) are hidden unless --include-exported.

  export  Given an explicit list of artifact refs (repo-relative paths from `scan`), a
          parent Jira card, and a connector env alias, create one Jira subtask per ref
          under the parent — by shelling out to the sk-jira-connector CLI (no second
          Jira client) — and write the created issue key back into the artifact so a re-run
          never double-creates.

This script never decides what to export and never approves anything: it scans and, on an
explicit ref list the agent passes after the human picks + confirms, creates the subtasks.
Creating Jira issues is an outward-facing write — the SKILL.md flow gates it behind a human
confirm before this `export` is ever invoked.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

try:
    import yaml
except ImportError:
    sys.stderr.write("ERROR: PyYAML not found — run from the repo-root .venv "
                     "(.venv/bin/python).\n")
    sys.exit(2)

EXIT_OK = 0
EXIT_ERR = 1

try:
    from zoneinfo import ZoneInfo
    BKK = ZoneInfo("Asia/Bangkok")
except Exception:  # pragma: no cover - fallback when tzdata absent
    BKK = timezone(timedelta(hours=7))


def now_bkk() -> str:
    return datetime.now(BKK).strftime("%Y-%m-%dT%H:%M:%S%z")


def repo_root(start: str) -> str:
    """Walk up for the .sidekicks/ marker — NOT git (service src/ dirs are own repos)."""
    cur = os.path.abspath(start)
    while cur != os.path.dirname(cur):
        if os.path.isdir(os.path.join(cur, ".sidekicks")):
            return cur
        cur = os.path.dirname(cur)
    sys.stderr.write("ERROR: could not locate the repo root (no .sidekicks/ above cwd).\n")
    sys.exit(EXIT_ERR)


def iter_improvement_files(root: str):
    """Yield every improvements/*.yaml under .agents/skills/<skill>/ (one level — so the
    skill-offloaded/<name>/ archive, which sits two levels deep, is skipped by design)."""
    skills_dir = os.path.join(root, '.agents', 'skills')
    if not os.path.isdir(skills_dir):
        return
    for skill in sorted(os.listdir(skills_dir)):
        impdir = os.path.join(skills_dir, skill, "improvements")
        if not os.path.isdir(impdir):
            continue
        for fn in sorted(os.listdir(impdir)):
            if fn.endswith(".yaml") or fn.endswith(".yml"):
                yield os.path.join(impdir, fn)


def parse_loose(text: str) -> dict:
    """Best-effort top-level extraction for artifacts whose YAML is malformed (e.g. an
    unquoted `: ` inside a plain `source:` scalar — a recurring shape in auditor-generated
    artifacts). Captures column-0 keys, including `>-`/`|` block scalars, so a proposed item
    is never dropped from the backlog just because its YAML is sloppy."""
    data, lines, i = {}, text.splitlines(), 0
    key_re = re.compile(r"^([A-Za-z_][\w-]*):\s?(.*)$")
    while i < len(lines):
        m = key_re.match(lines[i])
        if not m:
            i += 1
            continue
        key, val = m.group(1), m.group(2).strip()
        if val in (">-", ">", "|", "|-", ""):
            block, i = [], i + 1
            while i < len(lines) and (lines[i].startswith((" ", "\t")) or not lines[i].strip()):
                block.append(lines[i].strip())
                i += 1
            data[key] = " ".join(b for b in block if b).strip()
        else:
            data[key] = val
            i += 1
    return data


def load_artifact(path: str):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except Exception as exc:
        sys.stderr.write(f"WARN: could not read {path}: {exc}\n")
        return None
    try:
        data = yaml.safe_load(text)
        if isinstance(data, dict):
            return data
    except Exception:
        pass  # fall through to the loose parser below
    loose = parse_loose(text)
    if loose:
        sys.stderr.write(f"WARN: {path} has malformed YAML — used loose parse "
                         "(fix the artifact; values with ': ' must be quoted).\n")
        return loose
    sys.stderr.write(f"WARN: could not parse {path} at all — skipped.\n")
    return None


def collect_proposed(root: str, include_exported: bool):
    out = []
    for path in iter_improvement_files(root):
        data = load_artifact(path)
        if not data:
            continue
        if str(data.get("status", "")).strip() != "proposed":
            continue
        exported = bool(data.get("jira_subtask"))
        if exported and not include_exported:
            continue
        out.append({
            "ref": os.path.relpath(path, root),
            "target_skill": data.get("target_skill", "?"),
            "id": data.get("id", os.path.splitext(os.path.basename(path))[0]),
            "kind": data.get("kind", "?"),
            "risk": data.get("risk", "?"),
            "proposal": " ".join(str(data.get("proposal", "")).split()),
            "jira_subtask": data.get("jira_subtask"),
        })
    return out


def cmd_scan(args):
    root = repo_root(os.getcwd())
    rows = collect_proposed(root, args.include_exported)
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return EXIT_OK
    if not rows:
        print("No proposed improvements awaiting export. "
              "(Use --include-exported to also show ones already on Jira.)")
        return EXIT_OK
    print(f"{len(rows)} proposed improvement(s) awaiting export:\n")
    for r in rows:
        mark = f"  [exported -> {r['jira_subtask']}]" if r["jira_subtask"] else ""
        prop = (r["proposal"][:140] + "…") if len(r["proposal"]) > 140 else r["proposal"]
        print(f"- {r['target_skill']} / {r['id']}  (risk={r['risk']}, kind={r['kind']}){mark}")
        print(f"    {prop}")
        print(f"    ref: {r['ref']}")
    print("\nPick refs to export, then: export_to_jira.py export "
          "--parent <CARD> --env <alias> --refs <ref1,ref2,...>")
    return EXIT_OK


def build_summary(data: dict) -> str:
    skill = data.get("target_skill", "?")
    proposal = " ".join(str(data.get("proposal", "")).split())
    head = proposal.split(". ")[0] if proposal else data.get("id", "improvement")
    summary = f"[skill-improve] {skill}: {head}"
    if len(summary) > 250:
        summary = summary[:249] + "…"
    return summary


def build_description(data: dict, ref: str) -> str:
    def field(label, key):
        val = data.get(key)
        return f"{label}: {val}\n" if val not in (None, "", []) else ""

    parts = [
        "Filed by sk-self-improve. Implement by approving + applying the artifact "
        "(self-improve APPLY -> skill-creator), not by hand-editing the skill.\n\n",
        field("Target skill", "target_skill"),
        field("Artifact id", "id"),
        field("Kind", "kind"),
        field("Risk", "risk"),
        field("Source", "source"),
        f"Artifact: {ref}\n\n",
        "Observation:\n" + " ".join(str(data.get("observation", "")).split()) + "\n\n",
        "Proposal:\n" + " ".join(str(data.get("proposal", "")).split()) + "\n\n",
        "Expected effect:\n" + " ".join(str(data.get("expected_effect", "")).split()) + "\n",
    ]
    return "".join(parts)


def writeback(path: str, key: str, ts: str):
    """Insert `jira_subtask` / `jira_exported_at` after the status: line, preserving the
    artifact's comments and block scalars (a text edit, not a yaml round-trip)."""
    with open(path, "r", encoding="utf-8") as fh:
        lines = fh.readlines()
    if any(re.match(r"\s*jira_subtask\s*:", ln) for ln in lines):
        # already recorded — refresh the key in place
        for i, ln in enumerate(lines):
            if re.match(r"\s*jira_subtask\s*:", ln):
                lines[i] = f"jira_subtask: {key}\n"
            elif re.match(r"\s*jira_exported_at\s*:", ln):
                lines[i] = f"jira_exported_at: {ts}\n"
        with open(path, "w", encoding="utf-8") as fh:
            fh.writelines(lines)
        return
    insert_at = len(lines)
    for i, ln in enumerate(lines):
        if re.match(r"\s*status\s*:", ln):
            insert_at = i + 1
            break
    block = [f"jira_subtask: {key}              # Jira subtask created by EXPORT\n",
             f"jira_exported_at: {ts}\n"]
    lines[insert_at:insert_at] = block
    with open(path, "w", encoding="utf-8") as fh:
        fh.writelines(lines)


def update_index(impdir: str, art_id: str, key: str):
    """Best-effort: append a [jira:KEY] marker to the artifact's INDEX.md line."""
    index = os.path.join(impdir, "INDEX.md")
    if not os.path.isfile(index):
        return
    try:
        with open(index, "r", encoding="utf-8") as fh:
            text = fh.read()
        marker = f"[jira:{key}]"
        lines = text.splitlines()
        for i, ln in enumerate(lines):
            if art_id in ln and marker not in ln:
                lines[i] = ln.rstrip() + f" {marker}"
                break
        with open(index, "w", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + ("\n" if text.endswith("\n") else ""))
    except Exception as exc:
        sys.stderr.write(f"WARN: could not update {index}: {exc}\n")


def create_subtask(root, env, parent, issuetype, summary, description):
    cli = os.path.join(root, '.agents', 'skills', "sk-jira-connector",
                       "scripts", "cli.py")
    if not os.path.isfile(cli):
        return None, "sk-jira-connector CLI not found at " + cli
    py = os.path.join(root, ".venv", "bin", "python")
    if not os.path.isfile(py):
        py = os.path.join(root, ".venv", "Scripts", "python.exe")  # Windows
    cmd = [py, cli, "create", "--env", env, "--type", issuetype,
           "--parent", parent, "--summary", summary, "--description", description]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True)
    except Exception as exc:
        return None, f"connector invocation failed: {exc}"
    if res.returncode != 0:
        return None, (res.stderr or res.stdout or "connector returned non-zero").strip()
    m = re.search(r"created\s+(\S+)", res.stdout)
    if not m:
        return None, f"could not parse issue key from connector output: {res.stdout.strip()}"
    return m.group(1).rstrip(".,"), None


def cmd_export(args):
    root = repo_root(os.getcwd())
    refs = [r.strip() for r in args.refs.split(",") if r.strip()]
    if not refs:
        sys.stderr.write("ERROR: --refs is empty (comma-separated repo-relative paths "
                         "from `scan`).\n")
        return EXIT_ERR
    if not args.dry_run and not args.env:
        sys.stderr.write("ERROR: --env <connector alias> is required (omit only with "
                         "--dry-run).\n")
        return EXIT_ERR

    created, skipped, failed = [], [], []
    for ref in refs:
        path = ref if os.path.isabs(ref) else os.path.join(root, ref)
        if not os.path.isfile(path):
            failed.append((ref, "no such artifact"))
            continue
        data = load_artifact(path)
        if not data:
            failed.append((ref, "unparseable artifact"))
            continue
        if str(data.get("status", "")).strip() != "proposed":
            skipped.append((ref, f"status is '{data.get('status')}', not proposed"))
            continue
        if data.get("jira_subtask") and not args.force:
            skipped.append((ref, f"already exported -> {data['jira_subtask']} "
                                 "(use --force to re-create)"))
            continue

        summary = build_summary(data)
        description = build_description(data, ref)
        if args.dry_run:
            created.append((ref, f"DRY-RUN would create under {args.parent}: {summary}"))
            continue

        key, err = create_subtask(root, args.env, args.parent, args.type, summary, description)
        if err:
            failed.append((ref, err))
            continue
        ts = now_bkk()
        writeback(path, key, ts)
        update_index(os.path.dirname(path), data.get("id", ""), key)
        created.append((ref, key))

    verb = "would create" if args.dry_run else "created"
    print(f"\nEXPORT summary{' (dry-run)' if args.dry_run else ''}: {len(created)} {verb}, "
          f"{len(skipped)} skipped, {len(failed)} failed.")
    for ref, info in created:
        print(f"  created  {ref} -> {info}")
    for ref, why in skipped:
        print(f"  skipped  {ref}: {why}")
    for ref, why in failed:
        print(f"  FAILED   {ref}: {why}")
    return EXIT_OK if not failed else EXIT_ERR


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("scan", help="list proposed improvements awaiting export")
    sp.add_argument("--json", action="store_true", help="emit JSON instead of a table")
    sp.add_argument("--include-exported", action="store_true",
                    help="also show artifacts already carrying a jira_subtask key")
    sp.set_defaults(func=cmd_scan)

    sp = sub.add_parser("export", help="create Jira subtasks for the given artifact refs")
    sp.add_argument("--refs", required=True,
                    help="comma-separated repo-relative artifact paths (from scan)")
    sp.add_argument("--parent", required=True, help="parent Jira card key (e.g. SDHPT-190)")
    sp.add_argument("--env", help="sk-jira-connector env alias (required unless --dry-run)")
    sp.add_argument("--type", default="Sub-task",
                    help="Jira issue type name for the children (default: Sub-task)")
    sp.add_argument("--dry-run", action="store_true",
                    help="show what would be created without touching Jira")
    sp.add_argument("--force", action="store_true",
                    help="re-create even if the artifact is already exported")
    sp.set_defaults(func=cmd_export)

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
