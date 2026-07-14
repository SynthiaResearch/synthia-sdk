import type { AccountApi } from "./http.js";

export interface Baseline {
  quality_check_id: string;
  branch: string;
  pass_rate: number;
  passed: number;
  evaluated: number;
  /** The baseline run's pre-cap merged config, when it recorded one —
   * the PR comment diffs the current run's against it. */
  effective_config?: Record<string, unknown>;
}

/**
 * Newest succeeded CI quality check on `branch` in this repo's CI session.
 * Fetched BEFORE any rollout: it validates auth early and can never pick
 * up the current run. Every failure degrades to null — first runs, old
 * servers (422 on the new params), and network blips all mean "no
 * baseline", never a dead pipeline.
 */
export async function fetchBaseline(
  api: AccountApi,
  session: string,
  branch: string,
): Promise<Baseline | null> {
  let status: number, body: any;
  try {
    ({ status, body } = await api.get("/v1/account/runs", {
      type: "quality_check",
      branch,
      session,
      limit: 1,
    }));
  } catch {
    return null;
  }
  if (status !== 200 || !body?.runs?.length) return null;
  const run = body.runs[0];
  const { passed, evaluated } = run.summary ?? {};
  if (typeof passed !== "number" || !evaluated) return null;
  return {
    quality_check_id: run.id,
    branch,
    pass_rate: passed / evaluated,
    passed,
    evaluated,
    effective_config: run.summary?.ci?.effective_config,
  };
}
