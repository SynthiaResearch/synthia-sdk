# Python SDK API

```bash
pip install synthiaresearch   # Python ≥ 3.10; the import name is `synthia`
```

The Python SDK mirrors the [JavaScript SDK](./js-api.md) — same concepts,
same server contract, snake_case names. This page covers the Python surface
and calls out every deliberate divergence; for the *semantics* of prepare,
rollouts, sandboxes, sessions, and voice, the JS doc is the long-form
reference and everything there applies unless listed under
[Divergences](#divergences-from-the-js-sdk).

The package also ships the `synthia` CLI (also invocable as
`python -m synthia`) — [CLI reference](./cli.md).

## Quickstart shape

```python
from synthia import Synthia

client = Synthia()  # reads SYNTHIA_API_KEY / SYNTHIA_BASE_URL

# Probe + generate only when needed; otherwise reuse this script's dataset.
prepared = client.prepare(lambda probe: my_agent.respond(probe))

# Play the scenarios against your agent (thread pool — see Divergences).
results = client.rollouts.run(my_rollout_agent, prepared.dataset,
                              agent_meta={"name": "my-agent", "version": "1.2"})

# Judge the rollouts server-side.
check = client.rollouts.quality_check(results)
check.wait(verbose=True)
evaluations = check.rollouts()
```

## `Synthia(api_key=None, base_url=None, session=None, voice=None, ci=None)`

Same option semantics as JS (`SYNTHIA_API_KEY` / `SYNTHIA_BASE_URL` /
`SYNTHIA_SESSION` fallbacks, `session=False` for an ephemeral session,
`voice=True/False` overriding the account's voice-auto mode, `ci` for CI
provenance). Public attributes after construction: `session_name`,
`session_id`, `invocation_id`, `voice_enabled`, `voice_auto`, `ci_settings`
(a plain dict, or `None`), and the resources `seeds`, `user_models`,
`datasets`, `rollouts`.

**There is no `ready()`.** The session handshake runs synchronously inside
`__init__`, so an invalid API key raises right there, and the
handshake-mirrored attributes are readable immediately after construction.

- **`prepare(agent, *, count=20, max_turns=10, min_success_rate=0.6, max_success_rate=0.9, verbose=False, voice=False)`**
  → `PrepareResult` — identical decision rules to JS
  ([reuse vs regenerate](./js-api.md#await-synthiaprepareagent-options--prepareresult)).
  `PrepareResult` fields: `dataset`, `user_model`, `action`, `reason`,
  `success_rate`, `quality_check_id`, `voice_renders`.
- **`voice_render(*, scenario_id=None, rollout_id=None, takes=1, stability=None, annotate=False, phone_fx=False, room_tone=False, voice_overrides=None)`**
  → `VoiceRender`.

## Resources

- **`client.seeds.ingest(*, kind, source, content, version="1", metadata=None)`**
  — `content` overloaded exactly like JS: a dict is ingested as-is; `bytes`
  or a `str`/`Path` ending in an audio suffix is uploaded and transcribed
  (voice-enabled accounts).
- **`client.user_models`** — `create_from_probe(agent, max_turns=10,
  verbose=False)`, `get(model_id)`, `list(session=None)`.
- **`client.datasets`** — `generate(user_model, count=20, *,
  quality_check_id=None)` → `GenerationJob`, `get(dataset_id)`,
  `list(session=None)`.
- **`client.rollouts`** —
  `run(agent, dataset=None, *, max_turns=12, concurrency=4, agent_meta=None)`
  → `list[RolloutResult]`;
  `run_scenario(agent, scenario_id, *, ...)`;
  `quality_check(rollouts, label=None)` → `QualityCheck`;
  `get(rollout_id)`; `voice(rollout, *, takes=1, ...)` → `VoiceRender`;
  `turn_audio(rollout_id, idx)` → `bytes`.

## Jobs and `wait(...)`

`GenerationJob`, `ValidationRun`, `QualityCheck`, and `VoiceRender` poll with
keyword arguments instead of an options object:

```python
dataset = job.wait(poll_interval=2.0, timeout=1800.0, verbose=False)
```

Same semantics as JS `wait()`: polls until the job leaves `running`, raises
on failure or timeout, streams server telemetry when `verbose=True`.
`Dataset.download()`, `Dataset.validate(label=None)`,
`Dataset.rollout(agent, **kwargs)`, `QualityCheck.rollouts()`,
`ValidationRun.scenarios()`, `VoiceRender.audio()` / `save_audio(path)` all
mirror their JS counterparts.

## Agent contracts and `ToolSandbox`

```python
Agent        = Callable[[str], Union[str, AgentReply]]
RolloutAgent = Callable[[list[dict], ToolSandbox], Union[str, bytes, Path]]
```

Rollout transcripts arrive as a `list` of `{"role", "content", ...}` dicts.
Returning `bytes` or an audio-file `Path` sends audio (voice-enabled
accounts). `ToolSandbox` is hash-identical to the JS and server sandboxes:
`call(name, tool_input)`, `report(name, output, *, input=None,
is_error=False)` (BYOE), `should_fail(name)`, `ToolSandbox.from_config(config)`,
and the `seed` / `state` / `events` attributes — semantics in the
[JS reference](./js-api.md#toolsandbox). `ToolCall`, `AgentReply`,
`UserModel`, `RolloutResult`, `PrepareResult` are dataclasses.

## Divergences from the JS SDK

Deliberate and documented — not gaps queued for fixing:

| | JS | Python |
| --- | --- | --- |
| Handshake | Deferred; `await ready()` to fail fast | Synchronous in `__init__` — a bad key raises at construction |
| `wait` | Options object `{ pollInterval, timeout, verbose }` | Keyword args `poll_interval=, timeout=, verbose=` |
| Rollout concurrency | Async workers in one event loop | `ThreadPoolExecutor` — **your agent must be thread-safe**; `concurrency=1` opts out |
| CLI entrypoint export | `#name`, else `agent`, else default export | `#name`, else `agent` — no default fallback |
| Adapters module | `synthiaresearch/adapters` | None — transcripts are plain dicts; the [integration guides](../integrations/README.md) show direct wiring |
| `synthia.yaml` JSON Schema | Ships in the package (`schema/`) | Not bundled — use the [repo copy](https://raw.githubusercontent.com/SynthiaResearch/synthia-sdk/main/packages/sdk-js/schema/synthia.schema.json) for editor validation |
| CI library | `synthiaresearch/ci` (`runCommand`) | `synthia.cli.run.run_command` |
| HTTP stack | `fetch` | `httpx` (sole runtime dependency, plus `pyyaml` for the CLI) |

Retry behavior matches JS: transient failures retry with backoff only where
a duplicate is harmless; rollout turn posts use check-then-act recovery
instead of blind retries.
