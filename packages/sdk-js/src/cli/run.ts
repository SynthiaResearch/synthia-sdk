import { dirname, resolve } from "node:path";

import { DEFAULT_BASE_URL, Synthia } from "../client.js";
import type { RolloutResult } from "../client.js";
import { loadAgent } from "./agent-loader.js";
import { fetchBaseline } from "./baseline.js";
import { ciSessionName, detectCi } from "./ci-context.js";
import {
  applyServerPolicy,
  compileExtraPatterns,
  ConfigError,
  loadConfig,
  type SynthiaConfig,
} from "./config.js";
import { AccountApi } from "./http.js";
import { Redactor, redactingAgent } from "./redact.js";
import {
  buildReport,
  effectiveConfig,
  renderSummary,
  writeReport,
  type RunReport,
} from "./results.js";

/** Environment/server trouble (network, timeout, agent crash): exit 3.
 * Distinct from ConfigError (the user's yaml/setup: exit 2) and from a
 * failed gate (the run worked, the agent isn't good enough: exit 1). */
export class InfraError extends Error {}

// The programmatic surface (synthiaresearch/ci) the GitHub Action builds on.
export { ConfigError } from "./config.js";
export type { RunReport, ScenarioRow } from "./results.js";

const APP_URL = "https://try-synthia.vercel.app"; // dedicated deploys: later via handshake

export interface RunFlags {
  config?: string;
  dataset?: string;
  output?: string;
  maxTurns?: number;
  concurrency?: number;
  repeats?: number;
  timeoutMinutes?: number;
  failOnThreshold?: number;
  verbose?: boolean;
  /** Advisory mode: still run, write results, and print the summary, but exit
   * 0 even when the gate fails — so the eval reports without blocking merges.
   * Config/infra errors (exit 2/3) still fail. */
  warnOnly?: boolean;
  /** Suffix the CI session (`ci/<repo>/<suffix>`) so multiple agent suites in
   * one repo — e.g. a JS and a Python agent — keep separate baseline lineages
   * instead of clobbering each other's. */
  sessionSuffix?: string;
}

export interface RunOutcome {
  report: RunReport | null;
  exitCode: 0 | 1 | 2 | 3;
}

/**
 * The whole `synthia run` flow, exported programmatically so the GitHub
 * Action can call it in-process (no npx, no registry fetch) and reuse the
 * report object for its PR comment.
 */
export async function runCommand(flags: RunFlags = {}): Promise<RunOutcome> {
  const configPath = resolve(flags.config ?? "synthia.yaml");
  const config = loadConfig(configPath);
  applyFlags(config, flags);
  const extraPatterns = compileExtraPatterns(config.telemetry.redact.patterns);
  const redactor = new Redactor(extraPatterns);

  // ENV POLICY: SYNTHIA_API_KEY and SYNTHIA_BASE_URL are the only reads
  // beyond the named CI-context vars in ci-context.ts.
  const apiKey = process.env["SYNTHIA_API_KEY"];
  if (!apiKey) {
    throw new ConfigError(
      "SYNTHIA_API_KEY is not set — add it to your CI secrets and export " +
        "it to this step's env",
    );
  }
  const baseUrl = process.env["SYNTHIA_BASE_URL"] ?? DEFAULT_BASE_URL;

  const ci = detectCi();
  const session = ciSessionName(ci) +
    (flags.sessionSuffix ? `/${flags.sessionSuffix}` : "");
  const startedAt = new Date();
  const deadline = startedAt.getTime() + config.run.timeout_minutes * 60_000;

  const client = new Synthia({
    apiKey,
    baseUrl,
    session,
    ci: {
      ...(ci.provider && { provider: ci.provider }),
      ...(ci.repo && { repo: ci.repo }),
      ...(ci.branch && { branch: ci.branch }),
      ...(ci.commit_sha && { commit_sha: ci.commit_sha }),
      ...(ci.run_id && { run_id: ci.run_id }),
      ...(ci.run_url && { run_url: ci.run_url }),
      ...(ci.pr !== undefined && { pr: ci.pr }),
      effective_config: effectiveConfig(config),
    },
  });
  try {
    await client.ready(); // fail fast on a bad key; populate ciSettings
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/api key/i.test(message)) throw new ConfigError(message);
    throw new InfraError(message);
  }
  const warnings = applyServerPolicy(config, client.ciSettings);
  for (const w of warnings) console.warn(`warning: ${w}`);

  // Baseline before any rollout: validates the account routes early and
  // can never catch the run we're about to create.
  const api = new AccountApi(baseUrl, apiKey);
  const baseline = await fetchBaseline(api, session, config.baseline.branch);
  if (!baseline) {
    console.log(`no baseline found for ${config.baseline.branch} — deltas ` +
      "will appear once a run on that branch exists");
  }

  const rawAgent = await loadAgent(config.agent.entrypoint, dirname(configPath));
  const agent = config.telemetry.redact.enabled
    ? redactingAgent(rawAgent, redactor)
    : rawAgent;
  if (!config.telemetry.redact.enabled) {
    console.warn("warning: telemetry.redact is disabled — agent replies and " +
      "tool events upload unscrubbed");
  }
  if (!config.run.dataset) {
    console.warn("warning: run.dataset not pinned — using the account's " +
      "latest dataset; pin a ds_… id for reproducible CI runs");
  }

  const agentMeta = {
    ...config.agent.meta,
    ...(ci.repo && { ci: { repo: ci.repo, branch: ci.branch, commit_sha: ci.commit_sha } }),
  };

  const sha7 = ci.commit_sha?.slice(0, 7) ?? "local";
  const label = `ci ${ci.branch ?? "?"}@${sha7}`;
  console.log(`session ${session} — ${label} — ` +
    `${config.run.repeats}× dataset ${config.run.dataset ?? "(latest)"}`);

  const results: RolloutResult[] = [];
  try {
    for (let i = 0; i < config.run.repeats; i++) {
      results.push(...await withDeadline(
        client.rollouts.run(agent, config.run.dataset ?? null, {
          maxTurns: config.run.max_turns,
          concurrency: config.run.concurrency,
          agentMeta,
        }),
        deadline, "rollouts",
      ));
    }
  } catch (e) {
    throw asInfra(e, redactor);
  }

  const datasetId = config.run.dataset ?? null;
  console.log(`${results.length} rollouts done — judging…`);
  let qc, evaluations: { rollout_id: string; passed: boolean }[];
  try {
    qc = await client.rollouts.qualityCheck(results, label);
    await qc.wait({
      timeout: Math.max(30, Math.floor((deadline - Date.now()) / 1000)),
      verbose: flags.verbose ?? false,
    });
    evaluations = await qc.rollouts();
  } catch (e) {
    throw asInfra(e, redactor);
  }

  // Best-effort scenario titles + the judge's top finding per failed
  // scenario (the "named regression" line); ids alone still work.
  const scenarioMeta = new Map<
    string,
    { task_family?: string; title?: string; top_issue?: string }
  >();
  try {
    const { status, body } = await api.get(`/v1/account/runs/${qc.id}`);
    const rows = status === 200
      ? body?.detail?.evaluations ?? body?.evaluations ?? []
      : [];
    for (const row of rows) {
      const known = scenarioMeta.get(row.scenario_id) ?? {};
      const issues: unknown = row.judge?.issues;
      const topIssue =
        !row.passed && Array.isArray(issues) && typeof issues[0] === "string"
          ? redactor.scrub(issues[0]).slice(0, 160)
          : undefined;
      scenarioMeta.set(row.scenario_id, {
        task_family: row.task_family ?? known.task_family ?? undefined,
        title: row.title ?? known.title ?? undefined,
        // keep the first failed rollout's finding; don't overwrite with later ones
        top_issue: known.top_issue ?? topIssue,
      });
    }
  } catch {
    /* enrichment only */
  }

  const report = buildReport({
    session,
    qcId: qc.id,
    datasetId,
    results,
    evaluations,
    scenarioMeta,
    config,
    warnings,
    baseline,
    ci,
    reportUrl: `${APP_URL}/live/runs/${qc.id}`,
    startedAt,
  });
  writeReport(resolve(config.output), report);
  console.log(renderSummary(report));
  if (report.status !== "passed" && flags.warnOnly) {
    console.log("advisory (warn-only): gate failed but not blocking");
  }
  console.log(`results written to ${config.output}`);
  const gateExit = report.status === "passed" || flags.warnOnly ? 0 : 1;
  return { report, exitCode: gateExit };
}

function applyFlags(config: SynthiaConfig, flags: RunFlags): void {
  if (flags.dataset !== undefined) config.run.dataset = flags.dataset;
  if (flags.output !== undefined) config.output = flags.output;
  if (flags.maxTurns !== undefined) config.run.max_turns = flags.maxTurns;
  if (flags.concurrency !== undefined) config.run.concurrency = flags.concurrency;
  if (flags.repeats !== undefined) config.run.repeats = flags.repeats;
  if (flags.timeoutMinutes !== undefined) {
    config.run.timeout_minutes = flags.timeoutMinutes;
  }
  if (flags.failOnThreshold !== undefined) {
    config.thresholds.pass_rate = flags.failOnThreshold;
  }
}

function withDeadline<T>(p: Promise<T>, deadline: number, what: string): Promise<T> {
  const ms = deadline - Date.now();
  if (ms <= 0) return Promise.reject(new InfraError(`run.timeout_minutes exceeded before ${what}`));
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(
        () => reject(new InfraError(`run.timeout_minutes exceeded during ${what}`)),
        ms,
      );
      t.unref?.();
    }),
  ]);
}

/** Agent/server exceptions become InfraError with a scrubbed message —
 * an agent crash can embed env-derived strings in its message. Chases
 * `cause` so undici's bare "fetch failed" carries its network error. */
function asInfra(e: unknown, redactor: Redactor): InfraError {
  if (e instanceof InfraError || e instanceof ConfigError) return e as InfraError;
  let message = e instanceof Error ? e.message : String(e);
  let cause = e instanceof Error ? e.cause : undefined;
  for (let depth = 0; cause && depth < 3; depth++) {
    const detail =
      cause instanceof Error
        ? `${(cause as NodeJS.ErrnoException).code ?? cause.name}: ${cause.message}`
        : String(cause);
    message += ` (${detail})`;
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return new InfraError(redactor.scrub(message));
}
