# Synthia SDK

Synthia evals your AI agent against simulated users: **probe** it to infer
who it's for, **generate** a synthetic scenario dataset, **roll out** the
scenarios against it, and **judge** every conversation — from the SDK while
you develop, and as a CI gate on every pull request.

Both SDKs publish as **`synthiaresearch`** and mirror each other — same API
surface, same CLI, same `synthia.yaml`, byte-identical results contract:

```bash
npm install synthiaresearch    # Node ≥ 18   → import { Synthia } from "synthiaresearch"
pip install synthiaresearch    # Python ≥ 3.10 → from synthia import Synthia
```

```ts
const synthia = new Synthia();                       // SYNTHIA_API_KEY
const { dataset } = await synthia.prepare(myAgent);  // probe + generate (or reuse)
const results = await dataset.rollout(myRolloutAgent);
const check = await synthia.rollouts.qualityCheck(results);
await check.wait({ verbose: true });
```

## Documentation

| | |
| --- | --- |
| [JS/TS SDK](./packages/sdk-js/README.md) · [API reference](./docs/reference/js-api.md) | The npm package. |
| [Python SDK](./packages/sdk-python/README.md) · [API reference](./docs/reference/python-api.md) | The PyPI package. |
| [Synthia in CI](./docs/ci.md) | Gate PRs on evals: one secret + two files. |
| [`synthia` CLI](./docs/reference/cli.md) · [`synthia.yaml`](./docs/reference/configuration.md) | Commands, flags, gates, the results JSON. |
| [Environment & sessions](./docs/reference/environment.md) | Env vars (exactly which, and why), sessions, security posture. |
| [Framework integrations](./docs/integrations/README.md) | LangGraph, OpenAI Agents SDK, Vercel AI SDK, MCP. |
| [Examples](./examples/README.md) | Runnable CI-gating demos, JS and Python. |
| [GitHub Action](https://github.com/SynthiaResearch/synthia-action) | PR comments with baseline deltas and named regressions. |

## About this repo

This is the public home of the Synthia SDKs, CLI, and user docs — releases
are tagged and published from here (npm + PyPI trusted publishing with
build provenance). It's a one-way mirror of the SDK paths in Synthia's
development monorepo, synced automatically; issues and PRs are welcome
here, and maintainers land changes upstream. MIT licensed.
