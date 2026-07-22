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

# Everything in one call: prepare (probe + generate, or reuse) -> roll out
# -> judge. The script-path equivalent of CI's `synthia run`, minus gating.
outcome = client.run(my_rollout_agent,
                     agent_meta={"name": "my-agent", "version": "1.2"})
print(outcome.pass_rate, outcome.evaluations)
```

The steps stay available individually when you need to intervene between
them:

```python
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

## `Synthia(api_key=None, base_url=None, session=None, ci=None)`

Same option semantics as JS (`SYNTHIA_API_KEY` / `SYNTHIA_BASE_URL` /
`SYNTHIA_SESSION` fallbacks, `session=False` for an ephemeral session,
`ci` for CI provenance). Public attributes after construction:
`session_name`, `session_id`, `invocation_id`, `ci_settings` (a plain
dict, or `None`), and the resources `seeds`, `user_models`, `datasets`,
`rollouts`.

**There is no `ready()`.** The session handshake runs synchronously inside
`__init__`, so an invalid API key raises right there, and the
handshake-mirrored attributes are readable immediately after construction.

- **`run(agent, *, count=100, dataset=None, probe_agent=None, reprobe=False, max_turns=12, probe_max_turns=10, concurrency=4, repeats=1, min_success_rate=0.6, max_success_rate=0.9, label=None, agent_meta=None, verbose=False)`**
  → `EvalOutcome` — the one-call path
  ([semantics](./js-api.md#await-synthiarunagent-options--evaloutcome)):
  prepare → rollouts → quality check → judged results. `EvalOutcome`
  fields: `prepare` (`None` when `dataset` was passed), `dataset`,
  `results`, `quality_check`, `evaluations`, `pass_rate`. By default the
  rollout agent itself is driven for probing (each probe question becomes
  a one-turn conversation, sandbox calls traced onto the reply);
  `probe_agent` overrides. `reprobe=True` forces the full refresh —
  re-interview the agent, re-distill its context, generate a fresh
  batch — use when the agent changed.
- **`prepare(agent, *, count=100, max_turns=10, min_success_rate=0.6, max_success_rate=0.9, reprobe=False, verbose=False)`**
  → `PrepareResult` — identical decision rules to JS
  ([reuse vs regenerate](./js-api.md#await-synthiaprepareagent-options--prepareresult)).
  `PrepareResult` fields: `dataset`, `user_model`, `action`, `reason`,
  `success_rate`, `quality_check_id`.

## Resources

- **`client.seeds.ingest(*, kind, source, content, version="1", metadata=None)`**
  — `content` overloaded exactly like JS: a dict is ingested as-is;
  `bytes` or a `str`/`Path` to a file is uploaded and handled server-side
  with zero parameters — audio (any common container) is transcribed and
  marks the seed voice-origin; images, PDFs, and Office documents are
  rendered to text natively.
- **`client.user_models`** — `create_from_probe(agent, max_turns=10,
  verbose=False)`, `get(model_id)`, `list(session=None)`,
  `submit_scenarios(user_model, scenarios)` → `list[dict]`. `submit_scenarios`
  takes your own scenarios (each a dict; only `user_goal` is required) and
  completes + grounds them in the model's representation server-side. Each
  result's `passed`/`judge` are **advisory** — a failing verdict never blocks;
  the scenario is stored either way. Feed the returned `scenario_id`s to
  `datasets.compose`.
- **`client.datasets`** — `generate(user_model, count=20, *,
  quality_check_id=None, guidance=None)` → `GenerationJob`,
  `compose(user_model, scenario_ids, *, label=None)` → `Dataset`,
  `get(dataset_id)`, `list(session=None)`. `guidance` is a free-text steer that
  biases scenario content toward a theme or situation; it biases content within
  the sampled families/controls, never hard-filters families, and never
  overrides grounding (not a source of new tools, policies, or facts).
  `compose` assembles a dataset from an explicit set of scenarios (custom,
  generated, or a mix) belonging to the user model's representation — the
  **reuse/curation** path: pass existing `scenario_id`s and get a dataset that
  shares those rows by reference.
- **`client.rollouts`** —
  `run(agent, dataset=None, *, max_turns=12, concurrency=4, agent_meta=None)`
  → `list[RolloutResult]`;
  `run_scenario(agent, scenario_id, *, ...)`;
  `quality_check(rollouts, label=None)` → `QualityCheck`;
  `get(rollout_id)`; `turn_audio(rollout_id, idx)` → `bytes`. Voice is
  zero-configuration modality mirroring ([semantics](./js-api.md#voice--zero-configuration)):
  an audio reply flips its rollout into voice mode; on a voiced
  `RolloutResult`, `voiced` is `True`, and `result.audio()` /
  `result.save_audio(path)` fetch the server-attached mixed WAV.

## Jobs and `wait(...)`

`GenerationJob`, `ValidationRun`, and `QualityCheck` poll with keyword
arguments instead of an options object:

```python
dataset = job.wait(poll_interval=2.0, timeout=1800.0, verbose=False)
```

Same semantics as JS `wait()`: polls until the job leaves `running`, raises
on failure or timeout, streams server telemetry when `verbose=True`.
`Dataset.download()`, `Dataset.validate(label=None)`,
`Dataset.rollout(agent, **kwargs)`, `QualityCheck.rollouts()`, and
`ValidationRun.scenarios()` all mirror their JS counterparts.

## Agent contracts and `ToolSandbox`

```python
Agent        = Callable[[str], Union[str, AgentReply]]
RolloutAgent = Callable[[list[dict], ToolSandbox], Union[str, bytes, Path]]
```

Rollout transcripts arrive as a `list` of `{"role", "content", ...}` dicts,
where `role` is `"user"` (the simulated user) or `"agent"` (your agent's
earlier replies) — map `"agent"` to your stack's assistant role before
replaying history to your model; LLM APIs reject the literal role
`"agent"`.
Returning `bytes` or a file `Path` sends a file — audio flips the
rollout into voice mode; images and documents are rendered to text. `ToolSandbox` is hash-identical to the JS and server sandboxes:
`call(name, tool_input)`, `report(name, output, *, input=None,
is_error=False)` (BYOE), `should_fail(name)`, `ToolSandbox.from_config(config)`,
and the `seed` / `state` / `events` attributes — semantics in the
[JS reference](./js-api.md#toolsandbox). `ToolCall`, `AgentReply`,
`UserModel`, `RolloutResult`, `PrepareResult` are dataclasses.

**Stateful agents**: keep per-conversation state (stores, framework
sessions) in `sandbox.context` — a plain dict created fresh for every
rollout that dies with it. Rollouts run concurrently on reused threads, so
module globals and thread-locals leak state across conversations, and
external dicts keyed by `id(sandbox)` are unsafe (CPython recycles ids
after garbage collection). Frameworks with their own memory (LangGraph
checkpointers, session objects) should be fed only the newest transcript
turn.

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
