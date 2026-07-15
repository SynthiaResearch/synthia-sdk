# Test tool-calling agents in CI — Vercel AI SDK

Gate your Vercel AI SDK agent's PRs on behavioral regressions with Synthia.
Your `generateText` agent runs in CI against a pinned suite of simulated-user
scenarios; the check fails when the pass rate drops below your threshold.

## The entrypoint

`synthia.yaml` points at a module exporting a `RolloutAgent`. Wrap your agent
with the `synthiaresearch/adapters` glue and route tool calls through the
Synthia sandbox so runs replay deterministically:

```ts
// src/synthia-agent.ts
import { generateText, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { fromChatHandler, callTool } from "synthiaresearch/adapters";

export const agent = fromChatHandler(async (messages, sandbox) => {
  const { text } = await generateText({
    model: openai("gpt-4o"),
    system: "You are the customer-support agent for …",
    messages,
    tools: {
      lookup_account: tool({
        description: "Fetch an account by id or email.",
        parameters: z.object({ account_id: z.string() }),
        // Execute against Synthia's deterministic sandbox, not live systems.
        execute: async (input) => callTool(sandbox, "lookup_account", input),
      }),
      adjust_subscription: tool({
        description: "Apply a plan change.",
        parameters: z.object({ account_id: z.string(), action: z.string() }),
        execute: async (input) => callTool(sandbox, "adjust_subscription", input),
      }),
    },
    maxSteps: 8,
  });
  return text;
});
```

```yaml
# synthia.yaml
version: 1
agent:
  entrypoint: ./src/synthia-agent.ts
run:
  dataset: ds_…
thresholds:
  pass_rate: 0.8
baseline:
  branch: main
```

## Workflow

```yaml
name: synthia
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
  pull-requests: write
concurrency:               # cancel superseded runs — evals are metered
  group: synthia-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
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
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        with:
          api-key: ${{ secrets.SYNTHIA_API_KEY }}
          warn-only: true      # advisory while calibrating — remove to enforce the gate
```

See [docs/ci.md](../ci.md) for the full reference and security notes.
