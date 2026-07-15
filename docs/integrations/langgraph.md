# Run LLM evaluations on every pull request — LangGraph

Gate your LangGraph agent's PRs on behavioral regressions with Synthia. Your
graph runs in CI against a pinned suite of simulated-user scenarios; the check
fails when the pass rate drops below your threshold.

## The entrypoint

`synthia.yaml` points at a module exporting a `RolloutAgent`. Adapt your
compiled graph with the `synthiaresearch/adapters` glue — no bespoke code:

```ts
// src/synthia-agent.ts
import { fromChatHandler, toolExecutors } from "synthiaresearch/adapters";
import { graph } from "./graph.js"; // your compiled LangGraph app

export const agent = fromChatHandler(async (messages, sandbox) => {
  // Route the graph's tool calls through Synthia's deterministic sandbox so
  // runs are replayable. Bind these executors wherever your ToolNode resolves
  // tools (or swap them in for the eval build).
  const tools = toolExecutors(sandbox, [
    "lookup_account",
    "adjust_subscription",
  ]);
  const result = await graph.invoke(
    { messages },
    { configurable: { synthiaTools: tools } },
  );
  const last = result.messages.at(-1);
  return typeof last?.content === "string" ? last.content : String(last?.content ?? "");
});
```

```yaml
# synthia.yaml
version: 1
agent:
  entrypoint: ./src/synthia-agent.ts
run:
  dataset: ds_…            # pin a suite (create once with prepare())
thresholds:
  pass_rate: 0.8
baseline:
  branch: main
```

## Workflow

```yaml
name: synthia
on:
  pull_request:            # never pull_request_target
  push:
    branches: [main]       # seeds the baseline for PR deltas
permissions:
  contents: read
  pull-requests: write
jobs:
  evals:
    name: Synthia Judge
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
        with: { persist-credentials: false }
      - uses: actions/setup-node@v7
        with: { node-version: 24 }
      - run: npm ci
      - uses: SynthiaResearch/synthia-action@v1
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}   # your graph's own keys
        with:
          api-key: ${{ secrets.SYNTHIA_API_KEY }}
```

See [docs/ci.md](../ci.md) for the full `synthia.yaml` reference and security
notes.
