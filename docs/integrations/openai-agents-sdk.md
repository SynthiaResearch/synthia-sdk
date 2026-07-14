# Block unsafe agent changes before merge — OpenAI Agents SDK

Gate your OpenAI Agents SDK agent's PRs on behavioral regressions with
Synthia. Your agent runs in CI against a pinned suite of simulated-user
scenarios; the check fails when the pass rate drops below your threshold.

## The entrypoint

`synthia.yaml` points at a module exporting a `RolloutAgent`. Wrap your agent
with the `synthiaresearch/adapters` glue, routing `function_tool` calls
through the Synthia sandbox so runs replay deterministically:

```ts
// src/synthia-agent.ts
import { Agent, run, tool } from "@openai/agents";
import { z } from "zod";
import { fromChatHandler, callTool } from "synthiaresearch/adapters";

export const agent = fromChatHandler(async (messages, sandbox) => {
  const supportAgent = new Agent({
    name: "Support",
    instructions: "You are the customer-support agent for …",
    tools: [
      tool({
        name: "lookup_account",
        description: "Fetch an account by id or email.",
        parameters: z.object({ account_id: z.string() }),
        execute: async (input) => callTool(sandbox, "lookup_account", input),
      }),
      tool({
        name: "adjust_subscription",
        description: "Apply a plan change.",
        parameters: z.object({ account_id: z.string(), action: z.string() }),
        execute: async (input) => callTool(sandbox, "adjust_subscription", input),
      }),
    ],
  });
  const result = await run(supportAgent, messages);
  return result.finalOutput ?? "";
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
jobs:
  evals:
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
```

See [docs/ci.md](../ci.md) for the full reference and security notes.
