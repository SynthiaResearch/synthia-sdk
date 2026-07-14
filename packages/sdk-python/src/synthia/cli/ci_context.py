"""CI provenance detection — port of cli/ci-context.ts.

ENV POLICY — the CLI reads exactly these environment variables and never
iterates os.environ. SYNTHIA_API_KEY (the only secret) and SYNTHIA_BASE_URL are
read by the SDK client; everything here is non-secret CI context. Keep it that
way: what a CI tool reads from the environment is an audit surface (see the
Codecov 2021 incident).
"""

import os
import re
import subprocess
from dataclasses import dataclass


@dataclass
class CiContext:
    provider: str | None = None
    repo: str | None = None
    branch: str | None = None
    commit_sha: str | None = None
    run_id: str | None = None
    run_url: str | None = None
    pr: int | None = None
    is_ci: bool = False


def _git(*args: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", *args], capture_output=True, text=True, timeout=5)
        return out.stdout.strip() or None
    except Exception:
        return None


def _remote_slug(url: str | None) -> str | None:
    """owner/repo slug from a git remote URL (https or ssh), else None."""
    if not url:
        return None
    m = re.search(r"[/:]([^/:]+/[^/]+?)(?:\.git)?$", url)
    return m.group(1) if m else None


def detect_ci() -> CiContext:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        repo = os.environ.get("GITHUB_REPOSITORY")
        run_id = os.environ.get("GITHUB_RUN_ID")
        # On pull_request events GITHUB_REF_NAME is "<n>/merge"; the branch
        # under test is GITHUB_HEAD_REF. On push it's the pushed branch.
        head_ref = os.environ.get("GITHUB_HEAD_REF")
        ref_name = os.environ.get("GITHUB_REF_NAME")
        pr: int | None = None
        if head_ref and ref_name and ref_name.endswith("/merge"):
            try:
                pr = int(ref_name.split("/", 1)[0])
            except ValueError:
                pr = None
        server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
        return CiContext(
            provider="github",
            repo=repo,
            branch=head_ref or ref_name,
            commit_sha=os.environ.get("GITHUB_SHA"),
            run_id=run_id,
            run_url=(f"{server}/{repo}/actions/runs/{run_id}"
                     if repo and run_id else None),
            pr=pr,
            is_ci=True,
        )
    # Local run: best-effort provenance from git, so a laptop `synthia run` on
    # main can seed the baseline too.
    slug = _remote_slug(_git("config", "--get", "remote.origin.url"))
    return CiContext(
        repo=slug,
        branch=_git("rev-parse", "--abbrev-ref", "HEAD"),
        commit_sha=_git("rev-parse", "HEAD"),
        is_ci=False,
    )


def ci_session_name(ctx: CiContext) -> str:
    """Stable CI session identity: one session groups every CI run of a repo,
    across branches — which is what makes the baseline query work."""
    return f"ci/{ctx.repo or os.path.basename(os.getcwd())}"


def ci_meta(ctx: CiContext) -> dict:
    """The allowlisted provenance dict sent on the handshake (sans
    effective_config, added by run.py). Only set keys are included."""
    out: dict = {}
    for key in ("provider", "repo", "branch", "commit_sha", "run_id", "run_url"):
        val = getattr(ctx, key)
        if val:
            out[key] = val
    if ctx.pr is not None:
        out["pr"] = ctx.pr
    return out
