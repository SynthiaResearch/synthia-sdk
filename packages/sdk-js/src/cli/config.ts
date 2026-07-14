import { readFileSync } from "node:fs";
import { parse } from "yaml";

import type { CiSettings } from "../client.js";

/** A synthia.yaml problem the user must fix (exit code 2). */
export class ConfigError extends Error {}

export interface SynthiaConfig {
  version: 1;
  agent: { entrypoint: string; meta: Record<string, unknown> };
  run: {
    dataset?: string;
    max_turns: number;
    concurrency: number;
    repeats: number;
    timeout_minutes: number;
  };
  thresholds: {
    /** Required unless the server config supplies ci.default_pass_rate
     * (resolved after the handshake in applyServerPolicy). */
    pass_rate?: number;
    min_scenarios: number;
  };
  baseline: { branch: string; max_regression: number | null };
  telemetry: { redact: { enabled: boolean; patterns: string[] } };
  output: string;
}

const DEFAULTS = {
  run: { max_turns: 12, concurrency: 4, repeats: 1, timeout_minutes: 30 },
  thresholds: { min_scenarios: 1 },
  baseline: { branch: "main", max_regression: null as number | null },
  telemetry: { redact: { enabled: true, patterns: [] as string[] } },
  output: "synthia-results.json",
};

// ── Tiny hand-rolled validator (dotted-path errors, unknown keys fatal) ──────

type Issues = string[];

function expectObject(v: unknown, path: string, issues: Issues): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    issues.push(`${path}: expected a mapping`);
    return {};
  }
  return v as Record<string, unknown>;
}

function expectString(v: unknown, path: string, issues: Issues): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || !v.trim()) {
    issues.push(`${path}: expected a non-empty string`);
    return undefined;
  }
  return v;
}

function expectNumber(
  v: unknown,
  path: string,
  issues: Issues,
  opts: { min?: number; max?: number; int?: boolean } = {},
): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || Number.isNaN(v)) {
    issues.push(`${path}: expected a number`);
    return undefined;
  }
  if (opts.int && !Number.isInteger(v)) {
    issues.push(`${path}: expected an integer`);
    return undefined;
  }
  if (opts.min !== undefined && v < opts.min) {
    issues.push(`${path}: must be >= ${opts.min}`);
    return undefined;
  }
  if (opts.max !== undefined && v > opts.max) {
    issues.push(`${path}: must be <= ${opts.max}`);
    return undefined;
  }
  return v;
}

function expectBool(v: unknown, path: string, issues: Issues): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    issues.push(`${path}: expected true or false`);
    return undefined;
  }
  return v;
}

/** Unknown keys are hard errors: a typo'd `thresholds:` silently ignored
 * would be a gate bypass, so this mirrors the API's extra="forbid". */
function rejectUnknown(
  obj: Record<string, unknown>,
  allowed: string[],
  path: string,
  issues: Issues,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      issues.push(`${path}${path ? "." : ""}${key}: unknown key ` +
        `(allowed: ${allowed.join(", ")})`);
    }
  }
}

export function parseConfig(source: string): SynthiaConfig {
  const issues: Issues = [];
  let raw: unknown;
  try {
    raw = parse(source);
  } catch (e) {
    throw new ConfigError(`synthia.yaml is not valid YAML: ${(e as Error).message}`);
  }
  const root = expectObject(raw, "", issues);
  rejectUnknown(root, ["version", "agent", "run", "thresholds", "baseline",
                       "telemetry", "output"], "", issues);

  const version = expectNumber(root["version"], "version", issues, { int: true });
  if (version !== 1) issues.push("version: must be 1");

  const agent = expectObject(root["agent"], "agent", issues);
  rejectUnknown(agent, ["entrypoint", "meta"], "agent", issues);
  const entrypoint = expectString(agent["entrypoint"], "agent.entrypoint", issues);
  if (root["agent"] === undefined || (!entrypoint && !issues.some((i) => i.startsWith("agent.entrypoint")))) {
    issues.push("agent.entrypoint: required (path to your RolloutAgent module)");
  }
  const meta = expectObject(agent["meta"], "agent.meta", issues);

  const run = expectObject(root["run"], "run", issues);
  rejectUnknown(run, ["dataset", "max_turns", "concurrency", "repeats",
                      "timeout_minutes"], "run", issues);
  const dataset = expectString(run["dataset"], "run.dataset", issues);
  if (dataset !== undefined && !/^ds_[a-z0-9]+$/.test(dataset)) {
    issues.push("run.dataset: expected a ds_… dataset id");
  }

  const thresholds = expectObject(root["thresholds"], "thresholds", issues);
  rejectUnknown(thresholds, ["pass_rate", "min_scenarios"], "thresholds", issues);

  const baseline = expectObject(root["baseline"], "baseline", issues);
  rejectUnknown(baseline, ["branch", "max_regression"], "baseline", issues);

  const telemetry = expectObject(root["telemetry"], "telemetry", issues);
  rejectUnknown(telemetry, ["redact"], "telemetry", issues);
  const redact = expectObject(telemetry["redact"], "telemetry.redact", issues);
  rejectUnknown(redact, ["enabled", "patterns"], "telemetry.redact", issues);
  let patterns: string[] = [];
  const rawPatterns = redact["patterns"];
  if (rawPatterns !== undefined && rawPatterns !== null) {
    if (!Array.isArray(rawPatterns) || rawPatterns.some((p) => typeof p !== "string")) {
      issues.push("telemetry.redact.patterns: expected a list of regex strings");
    } else {
      patterns = rawPatterns;
    }
  }

  const config: SynthiaConfig = {
    version: 1,
    agent: { entrypoint: entrypoint ?? "", meta },
    run: {
      dataset,
      max_turns: expectNumber(run["max_turns"], "run.max_turns", issues,
        { int: true, min: 2, max: 40 }) ?? DEFAULTS.run.max_turns,
      concurrency: expectNumber(run["concurrency"], "run.concurrency", issues,
        { int: true, min: 1 }) ?? DEFAULTS.run.concurrency,
      repeats: expectNumber(run["repeats"], "run.repeats", issues,
        { int: true, min: 1, max: 5 }) ?? DEFAULTS.run.repeats,
      timeout_minutes: expectNumber(run["timeout_minutes"], "run.timeout_minutes",
        issues, { min: 1 }) ?? DEFAULTS.run.timeout_minutes,
    },
    thresholds: {
      pass_rate: expectNumber(thresholds["pass_rate"], "thresholds.pass_rate",
        issues, { min: 0, max: 1 }),
      min_scenarios: expectNumber(thresholds["min_scenarios"],
        "thresholds.min_scenarios", issues, { int: true, min: 1 })
        ?? DEFAULTS.thresholds.min_scenarios,
    },
    baseline: {
      branch: expectString(baseline["branch"], "baseline.branch", issues)
        ?? DEFAULTS.baseline.branch,
      max_regression: expectNumber(baseline["max_regression"],
        "baseline.max_regression", issues, { min: 0, max: 1 })
        ?? DEFAULTS.baseline.max_regression,
    },
    telemetry: {
      redact: {
        enabled: expectBool(redact["enabled"], "telemetry.redact.enabled", issues)
          ?? DEFAULTS.telemetry.redact.enabled,
        patterns,
      },
    },
    output: expectString(root["output"], "output", issues) ?? DEFAULTS.output,
  };

  if (issues.length) {
    throw new ConfigError("synthia.yaml has problems:\n  - " + issues.join("\n  - "));
  }
  return config;
}

export function loadConfig(path: string): SynthiaConfig {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(
      `config not found at ${path} — create a synthia.yaml or pass --config`,
    );
  }
  return parseConfig(source);
}

/** Compile user redact patterns; invalid regexes are config errors. */
export function compileExtraPatterns(patterns: string[]): [string, RegExp][] {
  const compiled: [string, RegExp][] = [];
  const issues: string[] = [];
  patterns.forEach((p, i) => {
    try {
      compiled.push([`custom-${i}`, new RegExp(p, "g")]);
    } catch (e) {
      issues.push(`telemetry.redact.patterns[${i}]: invalid regex — ${(e as Error).message}`);
    }
  });
  if (issues.length) {
    throw new ConfigError("synthia.yaml has problems:\n  - " + issues.join("\n  - "));
  }
  return compiled;
}

/**
 * Apply the handshake-mirrored customer CI policy (ignore-with-warning:
 * admin floors/caps win, but never fail the run for trying). Precedence
 * overall: server defaults < synthia.yaml < CLI flags — and then this,
 * which is not a preference layer but org policy.
 */
export function applyServerPolicy(
  config: SynthiaConfig,
  ci: CiSettings | null,
): string[] {
  const warnings: string[] = [];
  if (config.thresholds.pass_rate === undefined) {
    if (ci?.default_pass_rate != null) {
      config.thresholds.pass_rate = ci.default_pass_rate;
      warnings.push(`thresholds.pass_rate not set — using your organization's ` +
        `default (${ci.default_pass_rate})`);
    } else {
      throw new ConfigError("thresholds.pass_rate: required (0..1)");
    }
  }
  if (ci?.pass_rate_floor != null && config.thresholds.pass_rate < ci.pass_rate_floor) {
    warnings.push(`thresholds.pass_rate ${config.thresholds.pass_rate} is below ` +
      `your organization's floor — raised to ${ci.pass_rate_floor}`);
    config.thresholds.pass_rate = ci.pass_rate_floor;
  }
  if (ci?.max_concurrency != null && config.run.concurrency > ci.max_concurrency) {
    warnings.push(`run.concurrency ${config.run.concurrency} exceeds your ` +
      `organization's cap — lowered to ${ci.max_concurrency}`);
    config.run.concurrency = ci.max_concurrency;
  }
  return warnings;
}
