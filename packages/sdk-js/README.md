# synthiaresearch

Synthia evals your AI agent against simulated users: probe it to infer who
it's for, generate a synthetic scenario dataset, play the scenarios against
it, and judge every rollout — locally from this SDK, or as a CI gate on
every pull request.

```bash
npm install synthiaresearch   # Node ≥ 18
```

## Quickstart

```ts
import { Synthia } from "synthiaresearch";

const synthia = new Synthia(); // reads SYNTHIA_API_KEY / SYNTHIA_BASE_URL

// Probe + generate only when needed; re-runs reuse this script's dataset.
const { dataset } = await synthia.prepare(async (probe) => {
  return myAgent.respond(probe);
});

// Play the scenarios against your agent; tools run in a deterministic sandbox.
const results = await dataset.rollout(async (transcript, sandbox) => {
  return myAgent.respondWithTools(transcript, sandbox);
});

// Judge every rollout server-side.
const check = await synthia.rollouts.qualityCheck(results);
await check.wait({ verbose: true });
console.log(await check.rollouts());
```

## In CI

The package ships the `synthia` CLI: point a `synthia.yaml` at your agent
module and gate PRs on the pass rate —

```bash
npx synthia validate   # check config + entrypoint, no network
npx synthia run        # play the suite, judge it, gate on thresholds
```

— or use the [GitHub Action](https://github.com/SynthiaResearch/synthia-action)
for PR comments with baseline deltas. Setup guide:
[Synthia in CI](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/ci.md).

## What's in the box

- **[`Synthia` client](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/js-api.md)**
  — `prepare()`, datasets, rollouts, quality checks, voice renders.
- **[`synthia` CLI](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/cli.md)**
  — `run`/`validate`, threshold + baseline-regression gates, a results JSON
  that never contains transcripts. Its core is importable from
  `synthiaresearch/ci`.
- **[Framework adapters](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/integrations/README.md)**
  (`synthiaresearch/adapters`) — LangGraph, OpenAI Agents SDK, Vercel AI
  SDK, MCP.
- **[`ToolSandbox`](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/js-api.md#toolsandbox)**
  — deterministic tool environment, replayable server-side; or bring your
  own environment and `report()` real tool results.
- **[Redaction on by default](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/configuration.md#telemetryredact--redaction)**
  — secret-shaped strings are scrubbed before anything is uploaded, and the
  CLI [never iterates your environment](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/environment.md#the-never-iterate-policy).

## Documentation

Full reference: [docs/reference/](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/README.md)
— [JS API](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/js-api.md)
· [CLI](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/cli.md)
· [synthia.yaml](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/configuration.md)
· [environment & sessions](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/environment.md).
Runnable examples: [examples/](https://github.com/SynthiaResearch/synthia-sdk/tree/main/examples).

Mirrors the [Python SDK](https://pypi.org/project/synthiaresearch/)
(`synthiaresearch` on PyPI) — same API surface, same CLI, same yaml. MIT
licensed.
