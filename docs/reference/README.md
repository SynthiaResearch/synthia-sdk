# Reference

Granular documentation for the `synthiaresearch` SDKs and the `synthia` CLI.
The package READMEs are the quickstarts; these files are the full contracts.

- [`js-api.md`](./js-api.md) — the JavaScript/TypeScript SDK, method by method.
- [`python-api.md`](./python-api.md) — the Python SDK, plus every deliberate
  divergence from the JS SDK.
- [`cli.md`](./cli.md) — the `synthia` CLI (`run` / `validate`): flags,
  precedence, exit codes, and the results-JSON contract. One doc for both
  languages — the two CLIs are mirrored by contract.
- [`configuration.md`](./configuration.md) — every `synthia.yaml` key,
  baseline regression gating, and telemetry redaction.
- [`environment.md`](./environment.md) — environment variables, session
  semantics, and the CLI's environment-access security posture.

Task-oriented guides live one level up: [CI quickstart](../ci.md) and
[framework integrations](../integrations/README.md) (LangGraph, OpenAI
Agents SDK, Vercel AI SDK, MCP).
