"""The `synthia run` orchestration — port of cli/run.ts."""

import os
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone

from ..client import DEFAULT_BASE_URL, Synthia
from .account_api import AccountApi
from .agent_loader import load_agent
from .baseline import fetch_baseline
from .ci_context import ci_meta, ci_session_name, detect_ci
from .config import (ConfigError, SynthiaConfig, apply_server_policy,
                     compile_extra_patterns, load_config)
from .redact import Redactor, redacting_agent
from .results import (build_report, effective_config, render_summary,
                      write_report)

# Dedicated deploys resolve this via the handshake later.
_APP_URL = "https://try-synthia.vercel.app"


class InfraError(Exception):
    """Environment/server trouble (network, timeout, agent crash): exit 3."""


@dataclass
class RunFlags:
    config: str | None = None
    dataset: str | None = None
    output: str | None = None
    max_turns: int | None = None
    concurrency: int | None = None
    repeats: int | None = None
    timeout_minutes: float | None = None
    fail_on_threshold: float | None = None
    warn_only: bool = False
    session_suffix: str | None = None
    verbose: bool = False


def _apply_flags(config: SynthiaConfig, flags: RunFlags) -> None:
    if flags.dataset is not None:
        config.run.dataset = flags.dataset
    if flags.output is not None:
        config.output = flags.output
    if flags.max_turns is not None:
        config.run.max_turns = flags.max_turns
    if flags.concurrency is not None:
        config.run.concurrency = flags.concurrency
    if flags.repeats is not None:
        config.run.repeats = flags.repeats
    if flags.timeout_minutes is not None:
        config.run.timeout_minutes = flags.timeout_minutes
    if flags.fail_on_threshold is not None:
        config.thresholds.pass_rate = flags.fail_on_threshold


def run_command(flags: RunFlags) -> int:
    """The whole `synthia run` flow. Returns the process exit code
    (0 pass / 1 gate failed). Raises ConfigError (→2) or InfraError (→3)."""
    config_path = os.path.abspath(flags.config or "synthia.yaml")
    config = load_config(config_path)
    _apply_flags(config, flags)
    extra_patterns = compile_extra_patterns(config.redact.patterns)
    redactor = Redactor(extra_patterns)

    # ENV POLICY: SYNTHIA_API_KEY and SYNTHIA_BASE_URL are the only reads beyond
    # the named CI-context vars in ci_context.py.
    api_key = os.environ.get("SYNTHIA_API_KEY")
    if not api_key:
        raise ConfigError(
            "SYNTHIA_API_KEY is not set — add it to your CI secrets and export "
            "it to this step's env")
    base_url = os.environ.get("SYNTHIA_BASE_URL", DEFAULT_BASE_URL)

    ci = detect_ci()
    session = ci_session_name(ci)
    if flags.session_suffix:
        session += f"/{flags.session_suffix}"
    started_at = datetime.now(timezone.utc)
    deadline = time.monotonic() + config.run.timeout_minutes * 60

    handshake_ci = {**ci_meta(ci), "effective_config": effective_config(config)}
    try:
        client = Synthia(api_key=api_key, base_url=base_url, session=session,
                         ci=handshake_ci)
    except Exception as e:  # bad key surfaces synchronously in Python __init__
        message = str(e)
        if "api key" in message.lower():
            raise ConfigError(message)
        raise InfraError(message)

    warnings = apply_server_policy(config, client.ci_settings)
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)

    # Baseline before any rollout: validates the account routes early and can
    # never catch the run we're about to create.
    api = AccountApi(base_url, api_key)
    baseline = fetch_baseline(api, session, config.baseline.branch)
    if baseline is None:
        print(f"no baseline found for {config.baseline.branch} — deltas will "
              "appear once a run on that branch exists")

    raw_agent = load_agent(config.entrypoint, os.path.dirname(config_path))
    agent = (redacting_agent(raw_agent, redactor)
             if config.redact.enabled else raw_agent)
    if not config.redact.enabled:
        print("warning: telemetry.redact is disabled — agent replies and tool "
              "events upload unscrubbed", file=sys.stderr)
    if not config.run.dataset:
        print("warning: run.dataset not pinned — using the account's latest "
              "dataset; pin a ds_… id for reproducible CI runs", file=sys.stderr)

    agent_meta = dict(config.agent_meta)
    if ci.repo:
        agent_meta["ci"] = {"repo": ci.repo, "branch": ci.branch,
                            "commit_sha": ci.commit_sha}

    sha7 = (ci.commit_sha or "local")[:7]
    label = f"ci {ci.branch or '?'}@{sha7}"
    print(f"session {session} — {label} — {config.run.repeats}× dataset "
          f"{config.run.dataset or '(latest)'}")

    results = []
    try:
        for _ in range(config.run.repeats):
            if time.monotonic() > deadline:
                raise InfraError("run.timeout_minutes exceeded before rollouts")
            results.extend(client.rollouts.run(
                agent, config.run.dataset,
                max_turns=config.run.max_turns,
                concurrency=config.run.concurrency,
                agent_meta=agent_meta))
    except (ConfigError, InfraError):
        raise
    except Exception as e:
        raise InfraError(redactor.scrub(str(e)))

    dataset_id = config.run.dataset
    print(f"{len(results)} rollouts done — judging…")
    try:
        qc = client.rollouts.quality_check(results, label)
        remaining = max(30, int(deadline - time.monotonic()))
        qc.wait(timeout=remaining, verbose=flags.verbose)
        evaluations = qc.rollouts()
    except (ConfigError, InfraError):
        raise
    except Exception as e:
        raise InfraError(redactor.scrub(str(e)))

    # Best-effort scenario titles + the judge's top finding per failed scenario
    # (the "named regression" line); ids alone still work.
    scenario_meta: dict[str, dict] = {}
    try:
        status, body = api.get(f"/v1/account/runs/{qc.id}")
        detail = (body or {}).get("detail") if isinstance(body, dict) else None
        rows = (detail or body or {}).get("evaluations", []) \
            if status == 200 and isinstance(body, dict) else []
        for row in rows:
            known = scenario_meta.get(row["scenario_id"], {})
            issues = (row.get("judge") or {}).get("issues")
            top_issue = None
            if not row.get("passed") and isinstance(issues, list) and issues \
                    and isinstance(issues[0], str):
                top_issue = redactor.scrub(issues[0])[:160]
            scenario_meta[row["scenario_id"]] = {
                "task_family": row.get("task_family") or known.get("task_family"),
                "title": row.get("title") or known.get("title"),
                "top_issue": known.get("top_issue") or top_issue,
            }
    except Exception:
        pass  # enrichment only

    report = build_report(
        session=session, qc_id=qc.id, dataset_id=dataset_id, results=results,
        evaluations=evaluations, scenario_meta=scenario_meta, config=config,
        warnings=warnings, baseline=baseline, ci=ci,
        report_url=f"{_APP_URL}/live/runs/{qc.id}", started_at=started_at)
    write_report(os.path.abspath(config.output), report)
    print(render_summary(report))
    if report["status"] != "passed" and flags.warn_only:
        print("advisory (warn-only): gate failed but not blocking")
    print(f"results written to {config.output}")
    return 0 if report["status"] == "passed" or flags.warn_only else 1
