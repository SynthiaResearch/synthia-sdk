"""Results report + summary — port of cli/results.ts.

The dict `build_report` returns serializes to the EXACT RunReport JSON the JS
CLI writes, field-for-field — the GitHub Action reads either language's
synthia-results.json through the same renderComment. By construction it never
contains transcripts, tool events, judge payloads, or credentials."""

import json
from datetime import datetime, timezone

from .config import SynthiaConfig


def _round(x: float) -> float:
    return round(x * 10000) / 10000


def _iso(dt: datetime) -> str:
    # match JS Date.toISOString(): UTC, milliseconds, trailing Z.
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") \
        + f"{dt.microsecond // 1000:03d}Z"


def effective_config(c: SynthiaConfig) -> dict:
    """The drift-comparable slice of the merged config (also uploaded as
    ci.effective_config on the handshake)."""
    return {
        "run": {"dataset": c.run.dataset, "max_turns": c.run.max_turns,
                "concurrency": c.run.concurrency, "repeats": c.run.repeats},
        "thresholds": {"pass_rate": c.thresholds.pass_rate,
                       "min_scenarios": c.thresholds.min_scenarios},
        "baseline": {"branch": c.baseline.branch,
                     "max_regression": c.baseline.max_regression},
    }


def build_report(*, session, qc_id, dataset_id, results, evaluations,
                 scenario_meta, config: SynthiaConfig, warnings, baseline,
                 ci, report_url, started_at: datetime) -> dict:
    by_rollout = {e["rollout_id"]: e["passed"] for e in evaluations}
    rows: dict[str, dict] = {}
    for r in results:
        verdict = by_rollout.get(r.rollout_id)
        row = rows.get(r.scenario_id)
        if row is None:
            meta = scenario_meta.get(r.scenario_id, {})
            row = {"scenario_id": r.scenario_id, "repeats": 0, "passed": 0,
                   "pass_rate": 0}
            if meta.get("task_family"):
                row["task_family"] = meta["task_family"]
            if meta.get("title"):
                row["title"] = meta["title"]
            if meta.get("top_issue"):
                row["top_issue"] = meta["top_issue"]
        if verdict is not None:
            row["repeats"] += 1
            if verdict:
                row["passed"] += 1
        rows[r.scenario_id] = row
    for row in rows.values():
        row["pass_rate"] = row["passed"] / row["repeats"] if row["repeats"] else 0

    evaluated = len(evaluations)
    passed = sum(1 for e in evaluations if e["passed"])
    pass_rate = passed / evaluated if evaluated else 0
    threshold = config.thresholds.pass_rate

    min_ok = evaluated >= config.thresholds.min_scenarios
    threshold_ok = min_ok and pass_rate >= threshold

    baseline_block = None
    baseline_ok = True
    if baseline is not None:
        delta = pass_rate - baseline.pass_rate
        max_regression = config.baseline.max_regression
        baseline_ok = max_regression is None or -delta <= max_regression
        baseline_block = {
            "quality_check_id": baseline.quality_check_id,
            "branch": baseline.branch,
            "pass_rate": _round(baseline.pass_rate),
            "delta": _round(delta),
            "max_regression": max_regression,
            "gate_passed": baseline_ok,
        }
        if baseline.effective_config:
            baseline_block["effective_config"] = baseline.effective_config

    scenarios = sorted(
        rows.values(),
        key=lambda s: (s["pass_rate"], s["scenario_id"]))

    completed = sum(1 for r in results if r.status == "completed")
    ci_public = {k: v for k, v in {
        "provider": ci.provider, "repo": ci.repo, "branch": ci.branch,
        "commit_sha": ci.commit_sha, "run_id": ci.run_id, "run_url": ci.run_url,
        "pr": ci.pr,
    }.items() if v is not None}

    return {
        "version": 1,
        "status": "passed" if threshold_ok and baseline_ok else "failed",
        "session": session,
        "quality_check_id": qc_id,
        "dataset_id": dataset_id,
        "ci": ci_public,
        "totals": {
            "scenarios": len(rows),
            "rollouts": len(results),
            "completed": completed,
            "evaluated": evaluated,
            "passed": passed,
            "pass_rate": _round(pass_rate),
        },
        "thresholds": {
            "pass_rate": threshold,
            "min_scenarios": config.thresholds.min_scenarios,
            "passed": threshold_ok,
        },
        "baseline": baseline_block,
        "scenarios": scenarios,
        "config": {"effective": effective_config(config), "warnings": warnings},
        "report_url": report_url,
        "started_at": _iso(started_at),
        "finished_at": _iso(datetime.now(timezone.utc)),
    }


def write_report(path: str, report: dict) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(json.dumps(report, indent=2) + "\n")


def _pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def render_summary(report: dict) -> str:
    lines: list[str] = []
    t = report["totals"]
    b = report["baseline"]
    if b:
        sign = "+" if b["delta"] >= 0 else ""
        delta_text = (f" (baseline {b['branch']}: {_pct(b['pass_rate'])}, "
                      f"Δ {sign}{b['delta'] * 100:.1f}pp)")
    else:
        delta_text = " (no baseline found — first run on this branch?)"
    lines.append("")
    lines.append(f"  pass rate {_pct(t['pass_rate'])} — {t['passed']}/"
                 f"{t['evaluated']} rollouts across {t['scenarios']} "
                 f"scenarios{delta_text}")
    lines.append(f"  threshold {_pct(report['thresholds']['pass_rate'])}: "
                 + ("met" if report["thresholds"]["passed"] else "NOT MET"))
    if b and b["max_regression"] is not None:
        lines.append(f"  regression gate (max {_pct(b['max_regression'])}): "
                     + ("met" if b["gate_passed"] else "NOT MET"))
    for w in report["config"]["warnings"]:
        lines.append(f"  warning: {w}")
    failing = [s for s in report["scenarios"] if s["pass_rate"] < 1]
    if failing:
        lines.append("")
        lines.append("  weakest scenarios:")
        for s in failing[:8]:
            name = s.get("title") or s["scenario_id"]
            family = f" [{s['task_family']}]" if s.get("task_family") else ""
            lines.append(f"    {s['passed']}/{s['repeats']}  {name}{family}")
            if s.get("top_issue"):
                lines.append(f"         ↳ {s['top_issue']}")
    lines.append("")
    lines.append(f"  full report: {report['report_url']}")
    lines.append("")
    return "\n".join(lines)
