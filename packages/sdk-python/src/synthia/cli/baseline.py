"""Baseline lookup — port of cli/baseline.ts.

Newest succeeded CI quality check on `branch` in this repo's CI session.
Fetched BEFORE any rollout: validates auth early and can never pick up the
current run. Every failure degrades to None — first runs, old servers (422 on
the new params), and network blips all mean "no baseline", never a dead
pipeline."""

from dataclasses import dataclass

from .account_api import AccountApi


@dataclass
class Baseline:
    quality_check_id: str
    branch: str
    pass_rate: float
    passed: int
    evaluated: int
    effective_config: dict | None = None


def fetch_baseline(api: AccountApi, session: str, branch: str) -> Baseline | None:
    status, body = api.get("/v1/account/runs", {
        "type": "quality_check", "branch": branch,
        "session": session, "limit": 1,
    })
    if status != 200 or not isinstance(body, dict):
        return None
    runs = body.get("runs") or []
    if not runs:
        return None
    run = runs[0]
    summary = run.get("summary") or {}
    passed, evaluated = summary.get("passed"), summary.get("evaluated")
    if not isinstance(passed, int) or not evaluated:
        return None
    ci = summary.get("ci") or {}
    return Baseline(
        quality_check_id=run["id"],
        branch=branch,
        pass_rate=passed / evaluated,
        passed=passed,
        evaluated=evaluated,
        effective_config=ci.get("effective_config"),
    )
