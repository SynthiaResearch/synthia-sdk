# ci-demo — Synthia CI gating, JS edition

The minimal "gate an agent's PRs on Synthia evals" setup: a toy Claude-backed
SaaS-billing support agent (`src/agent.ts`) plus the
[`synthia.yaml`](./synthia.yaml) that `synthia run` plays against it. This is
also the fixture Synthia's own CI self-test runs.

What it demonstrates:

- **The `RolloutAgent` contract** — `src/agent.ts` exports `agent(transcript,
  sandbox)`; its tools route through the deterministic `ToolSandbox` so the
  server can replay them.
- **Bring-your-own-environment reporting** — the `get_diagnostics` tool
  answers from "its own environment" via `sandbox.report(...)`. Its output
  deliberately embeds a fake `sk-…` credential to prove that
  [redact-by-default](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/configuration.md#telemetryredact--redaction)
  scrubs tool events before upload.
- **A pinned dataset** — `run.dataset` in `synthia.yaml` keeps every CI run
  on the same scenarios; `scripts/bootstrap-dataset.ts` is the one-time
  `prepare()` that created it (re-run it to refresh coverage, then update
  the pinned id).

## Run it

```bash
npm install
export SYNTHIA_API_KEY=…      # your Synthia key
export OPENAI_API_KEY=…    # the toy agent runs on GPT

npx synthia validate          # config + entrypoint check, no network
npx synthia run               # play the suite, judge it, gate on thresholds
```

Exit code 0 = gates met, 1 = gate failed, 2 = config error, 3 = infra —
details in the [CLI reference](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/cli.md).
The run writes `synthia-results.json` (scores and metadata only, never
transcripts).

## In a workflow

Use the [Synthia GitHub Action](https://github.com/SynthiaResearch/synthia-action)
for PR comments with baseline deltas, or the bare CLI — full setup in
[Synthia in CI](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/ci.md).
The Python twin of this example is
[`../ci-demo-py/`](../ci-demo-py/README.md) — same dataset, same yaml
schema, same gates.
