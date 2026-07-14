import { writeFileSync } from "node:fs";

import type { RolloutResult } from "../client.js";
import type { Baseline } from "./baseline.js";
import type { CiContext } from "./ci-context.js";
import type { SynthiaConfig } from "./config.js";

export interface ScenarioRow {
  scenario_id: string;
  task_family?: string;
  title?: string;
  repeats: number;
  passed: number;
  pass_rate: number;
  /** The judge's top finding for a failed rollout of this scenario — one
   * behavioral sentence ("Refund loop after tool timeout"), never
   * transcript content. This is the named-regression line the PR comment
   * leads with. */
  top_issue?: string;
}

/** The results JSON contract (version 1). By construction this NEVER
 * contains transcripts, tool events, judge payloads, or credentials —
 * customers upload CI artifacts to third-party aggregators. */
export interface RunReport {
  version: 1;
  status: "passed" | "failed";
  session: string;
  quality_check_id: string;
  dataset_id: string | null;
  ci: Partial<CiContext>;
  totals: {
    scenarios: number;
    rollouts: number;
    completed: number;
    evaluated: number;
    passed: number;
    pass_rate: number;
  };
  thresholds: { pass_rate: number; min_scenarios: number; passed: boolean };
  baseline: {
    quality_check_id: string;
    branch: string;
    pass_rate: number;
    delta: number;
    max_regression: number | null;
    gate_passed: boolean;
    /** The baseline run's pre-cap merged config, when it recorded one —
     * lets the PR comment show config drift vs the branch under test. */
    effective_config?: Record<string, unknown>;
  } | null;
  scenarios: ScenarioRow[];
  config: { effective: Record<string, unknown>; warnings: string[] };
  report_url: string;
  started_at: string;
  finished_at: string;
}

export interface GateInputs {
  session: string;
  qcId: string;
  datasetId: string | null;
  results: RolloutResult[];
  evaluations: { rollout_id: string; passed: boolean }[];
  scenarioMeta: Map<
    string,
    { task_family?: string; title?: string; top_issue?: string }
  >;
  config: SynthiaConfig;
  warnings: string[];
  baseline: Baseline | null;
  ci: CiContext;
  reportUrl: string;
  startedAt: Date;
}

export function buildReport(g: GateInputs): RunReport {
  const byRollout = new Map(g.evaluations.map((e) => [e.rollout_id, e.passed]));
  const rows = new Map<string, ScenarioRow>();
  for (const r of g.results) {
    const verdict = byRollout.get(r.rollout_id);
    const row = rows.get(r.scenario_id) ?? {
      scenario_id: r.scenario_id,
      ...g.scenarioMeta.get(r.scenario_id),
      repeats: 0,
      passed: 0,
      pass_rate: 0,
    };
    if (verdict !== undefined) {
      row.repeats += 1;
      if (verdict) row.passed += 1;
    }
    rows.set(r.scenario_id, row);
  }
  for (const row of rows.values()) {
    row.pass_rate = row.repeats ? row.passed / row.repeats : 0;
  }

  const evaluated = g.evaluations.length;
  const passed = g.evaluations.filter((e) => e.passed).length;
  const passRate = evaluated ? passed / evaluated : 0;
  const threshold = g.config.thresholds.pass_rate!;

  const minOk = evaluated >= g.config.thresholds.min_scenarios;
  const thresholdOk = minOk && passRate >= threshold;

  let baseline: RunReport["baseline"] = null;
  let baselineOk = true;
  if (g.baseline) {
    const delta = passRate - g.baseline.pass_rate;
    const maxRegression = g.config.baseline.max_regression;
    baselineOk = maxRegression === null || -delta <= maxRegression;
    baseline = {
      quality_check_id: g.baseline.quality_check_id,
      branch: g.baseline.branch,
      pass_rate: round(g.baseline.pass_rate),
      delta: round(delta),
      max_regression: maxRegression,
      gate_passed: baselineOk,
      ...(g.baseline.effective_config
        ? { effective_config: g.baseline.effective_config }
        : {}),
    };
  }

  return {
    version: 1,
    status: thresholdOk && baselineOk ? "passed" : "failed",
    session: g.session,
    quality_check_id: g.qcId,
    dataset_id: g.datasetId,
    ci: publicCi(g.ci),
    totals: {
      scenarios: rows.size,
      rollouts: g.results.length,
      completed: g.results.filter((r) => r.status === "completed").length,
      evaluated,
      passed,
      pass_rate: round(passRate),
    },
    thresholds: {
      pass_rate: threshold,
      min_scenarios: g.config.thresholds.min_scenarios,
      passed: thresholdOk,
    },
    baseline,
    scenarios: [...rows.values()].sort((a, b) =>
      a.pass_rate - b.pass_rate || a.scenario_id.localeCompare(b.scenario_id)),
    config: { effective: effectiveConfig(g.config), warnings: g.warnings },
    report_url: g.reportUrl,
    started_at: g.startedAt.toISOString(),
    finished_at: new Date().toISOString(),
  };
}

/** The drift-comparable slice of the merged config (pre-server-caps yaml
 * intent; also what the handshake uploads as ci.effective_config). */
export function effectiveConfig(c: SynthiaConfig): Record<string, unknown> {
  return {
    run: { dataset: c.run.dataset ?? null, max_turns: c.run.max_turns,
           concurrency: c.run.concurrency, repeats: c.run.repeats },
    thresholds: { pass_rate: c.thresholds.pass_rate ?? null,
                  min_scenarios: c.thresholds.min_scenarios },
    baseline: { branch: c.baseline.branch,
                max_regression: c.baseline.max_regression },
  };
}

export function writeReport(path: string, report: RunReport): void {
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const round = (x: number) => Math.round(x * 10000) / 10000;

/** CI context minus the internal isCi marker (the report's ci block). */
function publicCi(ci: CiContext): Partial<CiContext> {
  const { isCi: _isCi, ...rest } = ci;
  return Object.fromEntries(
    Object.entries(rest).filter(([, v]) => v !== undefined),
  );
}

export function renderSummary(report: RunReport): string {
  const lines: string[] = [];
  const t = report.totals;
  const deltaText = report.baseline
    ? ` (baseline ${report.baseline.branch}: ${pct(report.baseline.pass_rate)}, ` +
      `Δ ${report.baseline.delta >= 0 ? "+" : ""}${(report.baseline.delta * 100).toFixed(1)}pp)`
    : " (no baseline found — first run on this branch?)";
  lines.push("");
  lines.push(`  pass rate ${pct(t.pass_rate)} — ${t.passed}/${t.evaluated} ` +
    `rollouts across ${t.scenarios} scenarios${deltaText}`);
  lines.push(`  threshold ${pct(report.thresholds.pass_rate)}: ` +
    (report.thresholds.passed ? "met" : "NOT MET"));
  if (report.baseline && report.baseline.max_regression !== null) {
    lines.push(`  regression gate (max ${pct(report.baseline.max_regression)}): ` +
      (report.baseline.gate_passed ? "met" : "NOT MET"));
  }
  for (const w of report.config.warnings) lines.push(`  warning: ${w}`);
  const failing = report.scenarios.filter((s) => s.pass_rate < 1);
  if (failing.length) {
    lines.push("");
    lines.push("  weakest scenarios:");
    for (const s of failing.slice(0, 8)) {
      const name = s.title ?? s.scenario_id;
      const family = s.task_family ? ` [${s.task_family}]` : "";
      lines.push(`    ${s.passed}/${s.repeats}  ${name}${family}`);
      if (s.top_issue) lines.push(`         ↳ ${s.top_issue}`);
    }
  }
  lines.push("");
  lines.push(`  full report: ${report.report_url}`);
  lines.push("");
  return lines.join("\n");
}
