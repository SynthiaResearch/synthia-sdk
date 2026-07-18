# `synthia.yaml` reference

The config file for `synthia run` / `synthia validate`. One schema for both
CLIs. Unknown keys are **hard errors** at every level — a typo'd
`thresholds:` silently ignored would be a gate bypass — and validation
errors print dotted paths (`run.max_turns: must be <= 40`) and exit 2.

Editor validation: the JSON Schema ships in the npm package at
`node_modules/synthiaresearch/schema/synthia.schema.json`. It is not bundled
in the PyPI package — Python-only projects can point their YAML language
server at the copy in this repo:
`https://raw.githubusercontent.com/SynthiaResearch/synthia-sdk/main/packages/sdk-js/schema/synthia.schema.json`.

## Full example

```yaml
version: 1
agent:
  entrypoint: ./src/agent.ts      # module exporting your RolloutAgent
  meta: { name: my-agent, model: gpt-5.6-terra }
run:
  dataset: ds_1a2b3c4d5e6f        # pin one; created once via prepare()
  max_turns: 12
  concurrency: 4
  repeats: 1
  timeout_minutes: 30
thresholds:
  pass_rate: 0.8
  min_scenarios: 1
baseline:
  branch: main
  max_regression: null
telemetry:
  redact:
    enabled: true
    patterns: []
output: synthia-results.json
```

## Keys

### `version` (required)

Must be `1`. Bumped only on breaking schema changes.

### `agent` (required)

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `entrypoint` | string | *required* | Path to the module exporting your `RolloutAgent` — `(transcript, sandbox) => reply`. Resolved relative to the config file. Optional `#exportName` suffix; otherwise JS picks `agent` then the default export, Python requires an `agent` attribute. TS entrypoints need Node ≥ 22.18 or a dev install of `tsx`. |
| `meta` | object | `{}` | Free-form agent identity (`name`, `version`, `model`, …), recorded on every rollout. This is what lets the Synthia dashboard compare results across your agent's versions — set at least `name`. |

### `run`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `dataset` | `ds_…` id | account's latest | The dataset to play. **Pin one in CI** — omitting it uses the account's newest dataset (with a warning), which makes runs non-reproducible. |
| `max_turns` | int 2–40 | `12` | Turn cap per conversation. |
| `concurrency` | int ≥ 1 | `4` | Scenarios in flight at once. Orgs can cap this server-side. |
| `repeats` | int 1–5 | `1` | Run each scenario N times; pass rates pool across repeats. Use > 1 to tolerate agent stochasticity. |
| `timeout_minutes` | number ≥ 1 | `30` | Wall-clock budget for the whole run; exceeding it exits 3 (infra), not 1. |

### `thresholds`

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `pass_rate` | number 0–1 | org default | The suite gate: fail (exit 1) when `passed / evaluated` drops below it. Required **unless** your organization's config sets `default_pass_rate` server-side; org floors are applied over your value with a warning. |
| `min_scenarios` | int ≥ 1 | `1` | Fail when fewer rollouts were evaluated — guards against a vacuous pass on an empty or filtered dataset. |

### `baseline` — regression gating

Every CI run records itself under the repo's CI session. The baseline for a
run is the **newest succeeded CI quality check on `baseline.branch`** in
that session — which is why your workflow should also trigger on pushes to
that branch: the push runs are what PR runs compare against.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `branch` | string | `"main"` | Branch whose newest run is the baseline. |
| `max_regression` | number 0–1 or `null` | `null` | `null`: baseline deltas are informational only (shown in the summary and PR comment). Set (e.g. `0.1`): the run **fails** when its pass rate drops more than this below the baseline's, even if it still clears `thresholds.pass_rate`. |

Baseline lookups are deliberately fail-open: a first run on a branch, an
old server, or a network blip all mean "no baseline" — never a dead
pipeline. When the baseline run recorded its effective config, the report
(and the Action's PR comment) also diffs config drift between the two runs,
so "pass rate dropped" and "someone lowered max_turns" are distinguishable.

### `telemetry.redact` — redaction

What leaves the machine during a run is your agent's replies and its tool
inputs/outputs. Redaction scrubs secret-shaped strings out of both **before
upload**, on by default — because the customers who most need it are the
ones who won't configure it.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | bool | `true` | Setting `false` is an explicit, warned opt-out. |
| `patterns` | string list | `[]` | Extra regexes to scrub (e.g. an internal token prefix). Invalid regexes are config errors (exit 2). Matches are replaced with `[REDACTED:custom-N]`. |

Built-in patterns (matches become `[REDACTED:<name>]`):

| Name | Shape |
| --- | --- |
| `api-key` | `sk-…` (OpenAI/Anthropic/Stripe-style, 16+ chars) |
| `github` | `ghp_/gho_/ghu_/ghs_/ghr_…` (20+ chars) |
| `github-pat` | `github_pat_…` |
| `aws` | `AKIA…`/`ASIA…` access key ids |
| `jwt` | `eyJ….eyJ….…` three-part tokens |
| `slack` | `xoxb-/xoxa-/xoxp-/xoxr-/xoxs-…` |
| `synthia` | Synthia's own `synthia_…`/`vox_…` prefixes |

Two caveats, stated plainly: this is **risk reduction, not a guarantee** —
novel secret formats pass through — and **file replies (audio, images,
documents) are not redacted** (a one-time warning). The right fix is an agent
that doesn't put secrets in replies; redaction is the seatbelt.

### `output`

Path for the results JSON. Default `synthia-results.json`. Scores and
metadata only — see [the report contract](./cli.md#the-results-json-synthia-resultsjson).
