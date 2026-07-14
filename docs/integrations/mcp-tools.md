# MCP tool regression testing with Synthia

Agents whose tools live on MCP servers have two failure surfaces: the agent's
behavior and the tool contract underneath it. Synthia evals in CI catch the
behavioral half — a prompt or model change that stops the agent calling a
tool, calls the wrong one, or mishandles a tool result — by playing your agent
through simulated-user scenarios and judging the trajectory.

## Wiring MCP tools to the sandbox

`synthia.yaml` points `agent.entrypoint` at a module exporting a
`RolloutAgent` — `(transcript, sandbox) => reply`. For reproducible CI runs,
route your MCP tool calls through Synthia's deterministic sandbox instead of a
live MCP server, using the `synthiaresearch/adapters` glue:

```ts
// src/synthia-agent.ts
import { fromChatHandler, toolExecutors } from "synthiaresearch/adapters";
import { runMyAgent } from "./agent.js"; // your MCP-backed agent loop

export const agent = fromChatHandler(async (messages, sandbox) => {
  // One deterministic executor per MCP tool name your agent may call. Swap
  // these in for your live MCP client in the eval build so runs replay
  // identically server-side.
  const tools = toolExecutors(sandbox, [
    "search_tickets",
    "create_ticket",
    "escalate",
  ]);
  const { reply } = await runMyAgent({ messages, tools });
  return reply;
});
```

The sandbox returns stable, hashed results for each `(tool, input)`, so a run
depends only on your agent's decisions — not on live MCP-server state. A
regression shows up as the agent no longer reaching for `search_tickets`
before answering, or acting on a result it shouldn't have.

Prefer to exercise the real MCP server (integration-style, non-deterministic)?
Have your agent call its live MCP client and record what it did with
`sandbox.report(name, output, { input })` — the judge then sees the real tool
traffic, at the cost of reproducibility.

```yaml
# synthia.yaml
version: 1
agent:
  entrypoint: ./src/synthia-agent.ts
run:
  dataset: ds_…
  repeats: 2          # tolerate MCP/model nondeterminism
thresholds:
  pass_rate: 0.8
baseline:
  branch: main
```

The workflow is identical to the other integrations — see
[docs/ci.md](../ci.md) for the copy-paste job and security notes.
