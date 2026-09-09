#!/usr/bin/env python3
"""Trigger-eval SCORER for sk-skill-auditor — measures whether a skill's
description causes Claude to trigger (read the skill) for a set of queries.

This is the *scoring half only* of the triggering-optimization loop. It deliberately
ships NO proposal/rewrite path: there is no `anthropic` import, no API client, no
ANTHROPIC_API_KEY use anywhere. That omission is the point — per the repo AGENTS.md
("Skill optimization — manual loop only, never an API key"), the auditor agent itself
plays proposer (read the misses, hand-author a better description, re-score), and this
script only ever measures. It is a self-contained, zero-dependency adaptation of
skill-creator's run_eval.py (parse_skill_md inlined) so the auditor stays portable: it
does not depend on a plugin-cache path that varies per machine.

Two run-from gotchas this script makes easy to honor (learned from prior runs, see
AGENTS.md "Skill optimization"):
  • Score from a NEUTRAL root — pass --project-root to a fresh dir whose .claude/ has
    none of the real installed skills, so the live installed copy of the skill under
    test cannot compete for the trigger and poison the result.
  • Use --num-workers 1 — higher concurrency silently turns true-positives into
    false-negatives, so trigger rates can't be trusted above one worker. Default is 1.

Output (stdout): a JSON object
  {skill_name, description, results:[{query, should_trigger, trigger_rate, triggers,
   runs, pass}], summary:{total, passed, failed}}
Pass --description "<candidate>" to score a CANDIDATE description WITHOUT editing the
skill — that is how the optimize loop compares a proposed rewrite against the current
one before anything is filed.
"""

# PEP 563: the signatures below use PEP 604 `X | None` annotations, which are only evaluated
# lazily with this import. Without it this module raises TypeError at import time on Python 3.9
# — which is exactly what the repo-root .venv is on macOS CommandLineTools. audit_report.py in
# this same scripts/ dir already carries it; this file was missing it and blocked step 2b on two
# consecutive audit runs.
from __future__ import annotations

import argparse
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path


def parse_skill_md(skill_path: Path) -> tuple[str, str]:
    """Return (name, description) from a SKILL.md frontmatter.

    Inlined (and trimmed to the two fields this scorer needs) from skill-creator's
    scripts/utils.py so this script carries no cross-skill import. Tolerates the folded
    / block scalar forms (`>`, `|`, `>-`, `|-`) the auditor's own descriptions use.
    """
    content = (skill_path / "SKILL.md").read_text(encoding="utf-8")
    lines = content.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    if not lines or lines[0].strip() != "---":
        raise ValueError(f"SKILL.md missing frontmatter (no opening ---): {skill_path}")
    end_idx = None
    for i, line in enumerate(lines[1:], start=1):
        if line.strip() == "---":
            end_idx = i
            break
    if end_idx is None:
        raise ValueError(f"SKILL.md missing frontmatter (no closing ---): {skill_path}")

    name = ""
    description = ""
    fm = lines[1:end_idx]
    i = 0
    while i < len(fm):
        line = fm[i]
        if line.startswith("name:"):
            name = line[len("name:"):].strip().strip('"').strip("'")
        elif line.startswith("description:"):
            value = line[len("description:"):].strip()
            if value in (">", "|", ">-", "|-", ">+", "|+"):
                cont: list[str] = []
                i += 1
                while i < len(fm) and (fm[i].startswith("  ") or fm[i].startswith("\t") or fm[i].strip() == ""):
                    if fm[i].strip() != "":
                        cont.append(fm[i].strip())
                    i += 1
                description = " ".join(cont)
                continue
            else:
                description = value.strip('"').strip("'")
        i += 1
    return name, description


def run_single_query(
    query: str,
    skill_name: str,
    skill_description: str,
    timeout: int,
    project_root: str,
    model: str | None = None,
) -> bool:
    """Run one query under `claude -p` and return whether the skill triggered.

    Writes a command file into <project_root>/.claude/commands/ so the skill appears in
    Claude's available_skills list, then watches the stream for a Skill/Read tool call
    naming that command. Adapted verbatim in spirit from skill-creator's run_eval.py.
    """
    unique_id = uuid.uuid4().hex[:8]
    clean_name = f"{skill_name}-skill-{unique_id}"
    project_commands_dir = Path(project_root) / ".claude" / "commands"
    command_file = project_commands_dir / f"{clean_name}.md"

    try:
        project_commands_dir.mkdir(parents=True, exist_ok=True)
        indented_desc = "\n  ".join(skill_description.split("\n"))
        command_content = (
            f"---\n"
            f"description: |\n"
            f"  {indented_desc}\n"
            f"---\n\n"
            f"# {skill_name}\n\n"
            f"This skill handles: {skill_description}\n"
        )
        command_file.write_text(command_content, encoding="utf-8")

        cmd = [
            "claude",
            "-p", query,
            "--output-format", "stream-json",
            "--verbose",
            "--include-partial-messages",
        ]
        if model:
            cmd.extend(["--model", model])

        # Drop CLAUDECODE so a nested `claude -p` is permitted inside a Claude Code session.
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=project_root,
            env=env,
        )

        triggered = False
        start_time = time.time()
        buffer = ""
        pending_tool_name = None
        accumulated_json = ""

        # Cross-platform readiness. This used to be `select.select([process.stdout], ...)`, which
        # works on POSIX but raises OSError on the FIRST poll under Windows: CPython documents
        # select() there as sockets-only ("file objects on Windows are not acceptable"), and this is
        # a subprocess PIPE. Since the triggering benchmark always runs (there is no skip knob) and
        # auditor.sh resolves .venv/Scripts/python.exe for Windows, that made dimension-1 scoring
        # impossible from a Windows checkout. A reader thread draining the pipe into a queue is one
        # unified implementation for both OSes — never an OS fork (AGENTS.md).
        #
        # The timeout semantics are deliberately unchanged: the outer `while ... < timeout` guard,
        # the `return triggered` fallthrough below, and the finally-block kill are still what make a
        # timed-out query count as NOT triggered.
        chunks: "queue.Queue[bytes | None]" = queue.Queue()

        def _pump(fd: int, sink: "queue.Queue[bytes | None]") -> None:
            """Drain the child's stdout into `sink`; push None at EOF. os.read (not a buffered
            .read(n)) so a partial chunk is delivered as soon as it arrives, matching the streaming
            latency the old select loop had."""
            try:
                while True:
                    data = os.read(fd, 8192)
                    if not data:
                        break
                    sink.put(data)
            except OSError:
                pass                      # pipe closed under us (e.g. the finally-kill below)
            finally:
                sink.put(None)

        threading.Thread(
            target=_pump, args=(process.stdout.fileno(), chunks), daemon=True
        ).start()

        try:
            while time.time() - start_time < timeout:
                try:
                    chunk = chunks.get(timeout=1.0)
                except queue.Empty:
                    continue              # no output this second — re-check the timeout
                if chunk is None:
                    break                 # EOF: the child closed stdout
                buffer += chunk.decode("utf-8", errors="replace")

                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    if event.get("type") == "stream_event":
                        se = event.get("event", {})
                        se_type = se.get("type", "")
                        if se_type == "content_block_start":
                            cb = se.get("content_block", {})
                            if cb.get("type") == "tool_use":
                                tool_name = cb.get("name", "")
                                if tool_name in ("Skill", "Read"):
                                    pending_tool_name = tool_name
                                    accumulated_json = ""
                                else:
                                    return False
                        elif se_type == "content_block_delta" and pending_tool_name:
                            delta = se.get("delta", {})
                            if delta.get("type") == "input_json_delta":
                                accumulated_json += delta.get("partial_json", "")
                                if clean_name in accumulated_json:
                                    return True
                        elif se_type in ("content_block_stop", "message_stop"):
                            if pending_tool_name:
                                return clean_name in accumulated_json
                            if se_type == "message_stop":
                                return False

                    elif event.get("type") == "assistant":
                        message = event.get("message", {})
                        for content_item in message.get("content", []):
                            if content_item.get("type") != "tool_use":
                                continue
                            tool_name = content_item.get("name", "")
                            tool_input = content_item.get("input", {})
                            if tool_name == "Skill" and clean_name in tool_input.get("skill", ""):
                                triggered = True
                            elif tool_name == "Read" and clean_name in tool_input.get("file_path", ""):
                                triggered = True
                            return triggered

                    elif event.get("type") == "result":
                        return triggered
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()

        return triggered
    finally:
        if command_file.exists():
            command_file.unlink()


def run_eval(
    eval_set: list[dict],
    skill_name: str,
    description: str,
    num_workers: int,
    timeout: int,
    project_root: Path,
    runs_per_query: int = 3,
    trigger_threshold: float = 0.5,
    model: str | None = None,
) -> dict:
    results = []
    with ProcessPoolExecutor(max_workers=num_workers) as executor:
        future_to_info = {}
        for item in eval_set:
            for run_idx in range(runs_per_query):
                future = executor.submit(
                    run_single_query,
                    item["query"],
                    skill_name,
                    description,
                    timeout,
                    str(project_root),
                    model,
                )
                future_to_info[future] = (item, run_idx)

        query_triggers: dict[str, list[bool]] = {}
        query_items: dict[str, dict] = {}
        for future in as_completed(future_to_info):
            item, _ = future_to_info[future]
            query = item["query"]
            query_items[query] = item
            query_triggers.setdefault(query, [])
            try:
                query_triggers[query].append(future.result())
            except Exception as e:  # noqa: BLE001 — a crashed worker counts as no-trigger
                print(f"Warning: query failed: {e}", file=sys.stderr)
                query_triggers[query].append(False)

    for query, triggers in query_triggers.items():
        item = query_items[query]
        trigger_rate = sum(triggers) / len(triggers)
        should_trigger = item["should_trigger"]
        did_pass = (trigger_rate >= trigger_threshold) if should_trigger else (trigger_rate < trigger_threshold)
        results.append({
            "query": query,
            "should_trigger": should_trigger,
            "trigger_rate": trigger_rate,
            "triggers": sum(triggers),
            "runs": len(triggers),
            "pass": did_pass,
        })

    passed = sum(1 for r in results if r["pass"])
    total = len(results)
    return {
        "skill_name": skill_name,
        "description": description,
        "results": results,
        "summary": {"total": total, "passed": passed, "failed": total - passed},
    }


def find_project_root() -> Path:
    """Walk up from cwd for a .claude/ dir (how Claude Code finds its root).

    Used only when --project-root is not given. Prefer passing --project-root a NEUTRAL
    scratch dir so the live installed skill can't poison the score.
    """
    current = Path.cwd()
    for parent in [current, *current.parents]:
        if (parent / ".claude").is_dir():
            return parent
    return current


def main():
    parser = argparse.ArgumentParser(description="Trigger-eval SCORER (measures only; never proposes — no API key)")
    parser.add_argument("--eval-set", required=True, help="Path to eval set JSON: [{query, should_trigger}, ...]")
    parser.add_argument("--skill-path", required=True, help="Path to the skill directory (contains SKILL.md)")
    parser.add_argument("--description", default=None, help="Candidate description to score WITHOUT editing the skill")
    parser.add_argument("--project-root", default=None,
                        help="NEUTRAL root whose .claude/ has none of the real skills (avoids self-trigger poisoning). "
                             "Defaults to walking up from cwd for .claude/.")
    parser.add_argument("--num-workers", type=int, default=1,
                        help="Parallel workers. KEEP AT 1 — higher concurrency silently false-negatives positives.")
    parser.add_argument("--timeout", type=int, default=30, help="Timeout per query (seconds)")
    parser.add_argument("--runs-per-query", type=int, default=3, help="Runs per query (trigger rate denominator)")
    parser.add_argument("--trigger-threshold", type=float, default=0.5, help="Trigger-rate pass threshold")
    parser.add_argument("--model", default=None, help="Model id for claude -p (use the one powering this session)")
    parser.add_argument("--verbose", action="store_true", help="Print per-query progress to stderr")
    args = parser.parse_args()

    eval_set = json.loads(Path(args.eval_set).read_text(encoding="utf-8"))
    skill_path = Path(args.skill_path)
    if not (skill_path / "SKILL.md").exists():
        print(f"Error: no SKILL.md at {skill_path}", file=sys.stderr)
        sys.exit(1)

    name, original_description = parse_skill_md(skill_path)
    description = args.description or original_description
    project_root = Path(args.project_root).resolve() if args.project_root else find_project_root()

    if args.verbose:
        print(f"Scoring [{name}] from root {project_root} (workers={args.num_workers})", file=sys.stderr)
        print(f"Description: {description[:120]}...", file=sys.stderr)

    output = run_eval(
        eval_set=eval_set,
        skill_name=name,
        description=description,
        num_workers=args.num_workers,
        timeout=args.timeout,
        project_root=project_root,
        runs_per_query=args.runs_per_query,
        trigger_threshold=args.trigger_threshold,
        model=args.model,
    )

    if args.verbose:
        s = output["summary"]
        print(f"Results: {s['passed']}/{s['total']} passed", file=sys.stderr)
        for r in output["results"]:
            status = "PASS" if r["pass"] else "FAIL"
            print(f"  [{status}] rate={r['triggers']}/{r['runs']} expected={r['should_trigger']}: {r['query'][:70]}", file=sys.stderr)

    print(json.dumps(output, indent=2))


if __name__ == "__main__":
    main()
