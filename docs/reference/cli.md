# The `synthia` CLI

The CLI runs your agent against a pinned scenario dataset and gates on the
results — it's how Synthia runs in CI. It ships in **both** `synthiaresearch`
packages (`npx synthia …` from npm, `synthia` / `python -m synthia` from
PyPI), and the two implementations are mirrored by contract: same
`synthia.yaml` schema, same flags, same exit codes, and a byte-identical
results-JSON contract. Everything below applies to both languages; the few
deliberate differences are in [Language differences](#language-differences).

## Commands

### `synthia run`

Runs the eval suite defined by `synthia.yaml`:

1. Loads and validates the config, then loads your agent entrypoint.
2. Opens a CI-scoped SDK session (`ci/<owner>/<repo>`, see
   [environment.md](./environment.md#sessions)) and applies your
   organization's server-side CI policy (floors/caps, applied with warnings).
3. Fetches the baseline — the newest succeeded CI run on `baseline.branch` —
   before any rollout, so auth problems surface early. A missing baseline is
   never an error (first runs, network blips → "no baseline").
4. Plays every scenario in the dataset against your agent (`run.repeats`
   times each, `run.concurrency` in flight), wrapping the agent so
   [redaction](./configuration.md#telemetry-redaction) scrubs replies and
   tool events before upload.
5. Starts a server-side quality check over the finished rollouts and waits
   for the per-rollout pass/fail judgments.
6. Applies the gates (threshold, minimum scenario count, optional baseline
   regression), prints a summary, and writes the results JSON.

### `synthia validate`

Checks `synthia.yaml` and the agent entrypoint **without any network
access**: parses the config, compiles custom redaction patterns, and imports
the entrypoint. The cheap local debug loop — run it before pushing.

## Flags

Flags override `synthia.yaml`. Full precedence, lowest to highest:

1. Built-in defaults
2. `synthia.yaml` values
3. CLI flags
4. Organization CI policy (server-side floors/caps — not a preference layer;
   applied last, with a printed warning, and never fails the run)

| Flag | Overrides | Notes |
| --- | --- | --- |
| `--config <path>` | — | Config location. Default `./synthia.yaml`; the entrypoint resolves relative to it. |
| `--dataset <ds_…>` | `run.dataset` | Dataset id to play. |
| `--output <path>` | `output` | Results JSON path. Default `synthia-results.json`. |
| `--max-turns <n>` | `run.max_turns` | Conversation turn cap per rollout. Default 12. |
| `--concurrency <n>` | `run.concurrency` | Scenarios in flight at once. Default 4; orgs can cap it server-side. |
| `--repeats <n>` | `run.repeats` | Times each scenario runs (1–5); pass rates pool across repeats. Default 1. |
| `--timeout-minutes <n>` | `run.timeout_minutes` | Whole-run wall clock budget. Default 30; exceeding it is an infra failure (exit 3). |
| `--fail-on-threshold <0..1>` | `thresholds.pass_rate` | The suite gate. |
| `--warn-only` | — | Advisory mode: the full report still prints/writes, but a failed *gate* exits 0. Config and infra errors still fail (2/3). |
| `--session-suffix <name>` | — | Scopes the CI session to `ci/<repo>/<name>` — use it to keep multiple agent suites in one repo from sharing baselines. |
| `--verbose` | — | Streams server-side telemetry (judging progress, per-stage events) while waiting. |
| `--help` | — | Usage. |

There is deliberately **no `--api-key` flag**: the key is read only from the
`SYNTHIA_API_KEY` environment variable, so it can never land in shell
history or CI logs via argv.

## Exit codes

| Code | Meaning | Typical cause |
| --- | --- | --- |
| `0` | All gates met | Also: any gate result under `--warn-only`. |
| `1` | A gate failed | Pass rate below threshold, fewer than `min_scenarios` evaluated, or regression beyond `baseline.max_regression`. |
| `2` | Config / usage error | Invalid `synthia.yaml` (unknown keys are fatal), bad flag value, entrypoint didn't load or doesn't export an agent. |
| `3` | Infrastructure error / timeout | Network failure that survived retries, server error, or `timeout_minutes` exceeded. |

Gate your CI job on the exit code; `2` and `3` mean "the run didn't happen",
not "the agent got worse" — treat them as pipeline failures even under
`--warn-only`.

## The results JSON (`synthia-results.json`)

A versioned report (`version: 1`) written on every completed run. By
construction it **never contains transcripts, tool events, judge payloads,
or credentials** — it's safe to upload as a CI artifact to third-party
aggregators.

```jsonc
{
  "version": 1,
  "status": "passed",                  // "passed" | "failed" (all gates combined)
  "session": "ci/acme/support-bot",
  "quality_check_id": "qc_…",
  "dataset_id": "ds_…",
  "ci": { "provider": "github", "repo": "…", "branch": "…",
          "commit_sha": "…", "run_id": "…", "run_url": "…", "pr": 42 },
  "totals": { "scenarios": 20, "rollouts": 20, "completed": 20,
              "evaluated": 20, "passed": 17, "pass_rate": 0.85 },
  "thresholds": { "pass_rate": 0.8, "min_scenarios": 1, "passed": true },
  "baseline": {                        // null when no baseline was found
    "quality_check_id": "qc_…", "branch": "main",
    "pass_rate": 0.9, "delta": -0.05,
    "max_regression": null, "gate_passed": true,
    "effective_config": { }           // the baseline run's config, for drift diffs
  },
  "scenarios": [                       // sorted weakest-first
    { "scenario_id": "sc_…", "title": "…", "task_family": "…",
      "repeats": 1, "passed": 0, "pass_rate": 0,
      "top_issue": "Refund loop after tool timeout" }  // one behavioral sentence, never transcript content
  ],
  "config": { "effective": { }, "warnings": [ ] },
  "report_url": "https://…",           // the full run on the Synthia dashboard
  "started_at": "…", "finished_at": "…"
}
```

The Python CLI produces the same JSON field-for-field, including timestamp
formatting, so downstream tooling never needs to know which language ran.

## Programmatic use

The JS CLI's core is exported as `synthiaresearch/ci` — this is what the
[GitHub Action](https://github.com/SynthiaResearch/synthia-action) calls
in-process:

```ts
import { runCommand, ConfigError, InfraError } from "synthiaresearch/ci";
const { report, exitCode } = await runCommand({ config: "synthia.yaml" });
```

Python: `from synthia.cli.run import run_command, RunFlags, InfraError`.

## Language differences

The contract is shared; the loaders and runtimes differ:

| | JS (`npx synthia`) | Python (`synthia` / `python -m synthia`) |
| --- | --- | --- |
| Entrypoint export pick | `#name` if given, else `agent`, else the default export | `#name` if given, else `agent` — **no default fallback** (Python has no default export) |
| TypeScript entrypoints | Load natively on Node ≥ 22.18; older Node falls back to a dev install of `tsx` | n/a |
| Concurrency model | Async workers in one event loop | A thread pool — **your agent callable must be thread-safe** (no shared mutable state across invocations) |
| Requirements | Node ≥ 18 | Python ≥ 3.10 |

See [configuration.md](./configuration.md) for the full `synthia.yaml`
reference and [environment.md](./environment.md) for what the CLI reads from
the environment (exactly, and nothing else).
