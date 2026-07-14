# synthiaresearch

Synthia evals your AI agent against simulated users: probe it to infer who
it's for, generate a synthetic scenario dataset, play the scenarios against
it, and judge every rollout — locally from this SDK, or as a CI gate on
every pull request.

```bash
pip install synthiaresearch   # Python ≥ 3.10; the import name is `synthia`
```

## Quickstart

```python
from synthia import Synthia

client = Synthia()  # reads SYNTHIA_API_KEY / SYNTHIA_BASE_URL

# Probe + generate only when needed; re-runs reuse this script's dataset.
prepared = client.prepare(lambda probe: my_agent.respond(probe))

# Play the scenarios against your agent; tools run in a deterministic sandbox.
def rollout_agent(transcript, sandbox):
    return my_agent.respond_with_tools(transcript, sandbox)

results = client.rollouts.run(rollout_agent, prepared.dataset,
                              agent_meta={"name": "my-agent"})

# Judge every rollout server-side.
check = client.rollouts.quality_check(results)
check.wait(verbose=True)
print(check.rollouts())
```

## In CI

The package ships the `synthia` CLI (also `python -m synthia`): point a
`synthia.yaml` at a module exporting `agent(transcript, sandbox) -> reply`
and gate PRs on the pass rate —

```bash
synthia validate   # check config + entrypoint, no network
synthia run        # play the suite, judge it, gate on thresholds
```

— or use the [GitHub Action](https://github.com/SynthiaResearch/synthia-action)
with `language: python`. Setup guide:
[Synthia in CI](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/ci.md).

## Documentation

- [Python API reference](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/python-api.md)
  — every method, plus the deliberate divergences from the JS SDK (no
  `ready()`; `wait(**kwargs)`; rollouts run on a thread pool, so your agent
  callable must be thread-safe).
- [CLI reference](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/cli.md)
  · [synthia.yaml](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/configuration.md)
  · [environment & sessions](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/environment.md)
- Runnable examples: [examples/](https://github.com/SynthiaResearch/synthia-sdk/tree/main/examples)

Mirrors the [JS/TypeScript SDK](https://www.npmjs.com/package/synthiaresearch)
(`synthiaresearch` on npm) — same API surface, same CLI, same yaml,
byte-identical results-JSON contract. Replies and tool events are
[redacted by default](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/configuration.md#telemetryredact--redaction)
before upload. MIT licensed.

## Development

- `src/synthia/client.py` — the SDK: the `Synthia` client, resource classes,
  and the local probe/rollout loops with tool-call tracing.
- `src/synthia/cli/` — the `synthia` CLI, a module-for-module mirror of the
  JS CLI (same schema, same exit codes, same report contract).
- `pyproject.toml` — the `synthiaresearch` package definition (`httpx` and
  `pyyaml` as the only runtime dependencies; the import name stays
  `synthia`).
