# ci-demo-py — Synthia CI gating, Python edition

The Python twin of [`../ci-demo/`](../ci-demo/README.md): the same toy
Claude-backed support agent as `agent.py`, played by the same `synthia.yaml`
schema against the same pinned dataset (datasets are account-scoped and
language-agnostic).

Python-specific things it demonstrates:

- **The entrypoint contract** — `agent.entrypoint: ./agent.py` must export a
  callable named `agent` (Python has no default export; an explicit
  `#callable_name` suffix is the alternative).
- **Thread-safety** — the Python CLI runs scenarios on a thread pool, so
  `agent(transcript, sandbox)` builds its per-call state (here, the tool
  closures over `sandbox`) inside the function instead of sharing it.
- **BYOE + redaction** — like the JS twin, `get_diagnostics` reports a fake
  `sk-…` credential through `sandbox.report(...)` to prove redact-by-default
  scrubs tool events before upload.

## Run it

```bash
uv sync                       # or: pip install synthiaresearch openai
export SYNTHIA_API_KEY=…
export OPENAI_API_KEY=…

synthia validate              # config + entrypoint check, no network
synthia run                   # play the suite, judge it, gate on thresholds
```

(`python -m synthia run` works identically.) Exit codes and the results-JSON
contract are byte-identical to the JS CLI — see the
[CLI reference](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/reference/cli.md).

## In a workflow

Use the [Synthia GitHub Action](https://github.com/SynthiaResearch/synthia-action)
with `language: python`, or the bare CLI — full setup in
[Synthia in CI](https://github.com/SynthiaResearch/synthia-sdk/blob/main/docs/ci.md).
