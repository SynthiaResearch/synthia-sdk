# Synthia CI integrations

Run production-style agent simulations on every pull request and block
behavioral regressions — whichever framework your agent is built with. Each
guide ends in a working `synthia.yaml` + workflow you can copy.

| Framework | Guide |
|---|---|
| LangGraph | [langgraph.md](./langgraph.md) |
| OpenAI Agents SDK | [openai-agents-sdk.md](./openai-agents-sdk.md) |
| Vercel AI SDK | [vercel-ai-sdk.md](./vercel-ai-sdk.md) |
| MCP tools | [mcp-tools.md](./mcp-tools.md) |
| Plain chat handler / other | [../ci.md](../ci.md) — the base guide |

All of them share the same contract: `synthia.yaml` points `agent.entrypoint`
at a module exporting a `RolloutAgent` — `(transcript, sandbox) => reply`. The
[`synthiaresearch/adapters`](../reference/js-api.md#adapters-synthiaresearchadapters) helpers
(`fromChatHandler`, `toolExecutors`, `callTool`) are the small, dependency-free
glue between that contract and each framework's chat/tool shapes; tool calls
route through the deterministic sandbox so runs replay server-side.

The action, the security posture, and the full config schema are in
[docs/ci.md](../ci.md).
