#!/usr/bin/env node
/**
 * synthia — CI/terminal entry point for the synthiaresearch SDK.
 *
 *   synthia run [--config synthia.yaml] [--dataset ds_…] [--output p]
 *               [--max-turns n] [--concurrency n] [--repeats n]
 *               [--timeout-minutes n] [--fail-on-threshold r] [--verbose]
 *   synthia validate [--config synthia.yaml]
 *
 * Exit codes: 0 pass · 1 gate failed · 2 config/usage error · 3 infra/timeout.
 *
 * ENV POLICY: reads exactly SYNTHIA_API_KEY (the only secret; no --api-key
 * flag by design), SYNTHIA_BASE_URL, and the named GITHUB_* context vars in
 * cli/ci-context.ts. Never iterates process.env.
 */
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";

import { loadAgent } from "./cli/agent-loader.js";
import { compileExtraPatterns, ConfigError, loadConfig } from "./cli/config.js";
import { InfraError, runCommand, type RunFlags } from "./cli/run.js";

const USAGE = `usage: synthia <run|validate> [options]

  run       run the synthia.yaml eval suite and gate on thresholds
  validate  check synthia.yaml and the agent entrypoint without network

options:
  --config <path>            synthia.yaml location (default ./synthia.yaml)
  --dataset <ds_…>           override run.dataset
  --output <path>            override results JSON path
  --max-turns <n>            override run.max_turns
  --concurrency <n>          override run.concurrency
  --repeats <n>              override run.repeats
  --timeout-minutes <n>      override run.timeout_minutes
  --fail-on-threshold <0..1> override thresholds.pass_rate
  --warn-only                report the gate but exit 0 (advisory; non-blocking)
  --session-suffix <name>    scope the CI session (ci/<repo>/<name>) for
                             multiple agent suites in one repo
  --verbose                  stream server telemetry while judging
`;

function intFlag(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (Number.isNaN(n)) throw new ConfigError(`${name}: expected a number, got "${v}"`);
  return n;
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string" },
      dataset: { type: "string" },
      output: { type: "string" },
      "max-turns": { type: "string" },
      concurrency: { type: "string" },
      repeats: { type: "string" },
      "timeout-minutes": { type: "string" },
      "fail-on-threshold": { type: "string" },
      "warn-only": { type: "boolean" },
      "session-suffix": { type: "string" },
      verbose: { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 2;
  }

  if (command === "validate") {
    const configPath = resolve(values.config ?? "synthia.yaml");
    const config = loadConfig(configPath);
    compileExtraPatterns(config.telemetry.redact.patterns);
    await loadAgent(config.agent.entrypoint, dirname(configPath));
    console.log(`ok: ${configPath} is valid and the agent entrypoint loads`);
    return 0;
  }

  if (command !== "run") {
    console.error(`unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }

  const flags: RunFlags = {
    config: values.config,
    dataset: values.dataset,
    output: values.output,
    maxTurns: intFlag(values["max-turns"], "--max-turns"),
    concurrency: intFlag(values.concurrency, "--concurrency"),
    repeats: intFlag(values.repeats, "--repeats"),
    timeoutMinutes: intFlag(values["timeout-minutes"], "--timeout-minutes"),
    failOnThreshold: intFlag(values["fail-on-threshold"], "--fail-on-threshold"),
    warnOnly: values["warn-only"],
    sessionSuffix: values["session-suffix"],
    verbose: values.verbose,
  };
  const { exitCode } = await runCommand(flags);
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof ConfigError) {
      console.error(`config error: ${message}`);
      process.exit(2);
    }
    console.error(`error: ${message}`);
    process.exit(e instanceof InfraError ? 3 : 3);
  });
