# JavaScript/TypeScript SDK API

```bash
npm install synthiaresearch   # Node ≥ 18
```

Three entry points:

| Import | Contents |
| --- | --- |
| `synthiaresearch` | The `Synthia` client, resource classes, job types, `ToolSandbox`, all types |
| `synthiaresearch/adapters` | Framework glue: `fromChatHandler`, `transcriptToMessages`, `toolExecutors`, `callTool` |
| `synthiaresearch/ci` | The CLI's core as a library: `runCommand` (what the GitHub Action calls in-process) |

The package also ships the `synthia` CLI binary
([reference](./cli.md)) and the `synthia.yaml` JSON Schema at
`schema/synthia.schema.json`.

## The two agent contracts

Everything in the SDK is built around two function shapes you provide:

```ts
// Probing: answers one question at a time. Return a string, or an
// AgentReply — { reply, tool_calls } — to trace the tool calls made.
type Agent = (probe: string) => string | AgentReply | Promise<…>;

// Rollouts: full conversations. Gets the transcript so far plus a
// deterministic ToolSandbox for tool calls; returns the next reply
// (a string, or audio bytes / a path to an audio file on voice-enabled
// accounts). Scenarios run concurrently — no shared mutable state.
type RolloutAgent = (transcript: TranscriptTurn[], sandbox: ToolSandbox)
  => string | AudioInput | Promise<string | AudioInput>;

// TranscriptTurn.role is "user" (the simulated user) or "agent" (your
// agent's earlier replies). Map "agent" to your stack's assistant role
// before replaying history to your model — LLM APIs reject the literal
// role "agent".
```

If your agent is a chat-style handler, `fromChatHandler` in
[`synthiaresearch/adapters`](#adapters-synthiaresearchadapters) builds the
`RolloutAgent` for you.

## `new Synthia(options?)`

```ts
import { Synthia } from "synthiaresearch";
const synthia = new Synthia(); // reads SYNTHIA_API_KEY / SYNTHIA_BASE_URL
```

| Option | Fallback | Meaning |
| --- | --- | --- |
| `apiKey` | `SYNTHIA_API_KEY` env | Bearer key. Keyless clients degrade to an anonymous session where the server allows it. |
| `baseUrl` | `SYNTHIA_BASE_URL` env, then the hosted API | API origin. |
| `session` | `SYNTHIA_SESSION` env, then a derived name | Session identity (below). `session: false` = fresh ephemeral session. |
| `voice` | account config | `true` forces voice-auto behavior (handshake rejects if the account isn't voice-enabled); `false` keeps rollouts text-only even on a voice-auto account. |
| `ci` | — | CI provenance (commit sha, branch, …) stamped onto every run this process creates. Set by `synthia run`; reporting only. |

**Sessions.** Every client belongs to a named session — the stable,
account-scoped identity of one script, persisted across executions. Same
name ⇒ same session ⇒ re-runs reuse its datasets instead of re-probing and
re-generating. When neither the option nor `SYNTHIA_SESSION` is set, the
name derives from the entry-point script as `"project/script"`. Details and
the degradation ladder: [environment.md](./environment.md#sessions).

Construction never awaits: the session handshake runs in the background and
gates every later request. Public fields populated by it: `sessionName`,
`sessionId`, `invocationId`, `voiceEnabled`, `voiceAuto`, `ciSettings`
(your org's CI policy: `pass_rate_floor`, `max_concurrency`,
`default_pass_rate`; `null` when none).

### `await synthia.ready()`

Awaits the handshake explicitly. Every request waits on it implicitly, so
this is optional — call it to fail fast on a bad API key and to read the
handshake-mirrored fields (`ciSettings`, `voiceEnabled`) before acting.

### `await synthia.run(agent, options?)` → `EvalOutcome`

The whole evaluation in one call — the script-path equivalent of CI's
`synthia run`, minus the gating (thresholds, exit codes, and report files
stay yours): `prepare` (probe + generate, or reuse) → roll out every
scenario against `agent` → judge the rollouts → return the judged results.

```ts
const outcome = await synthia.run(myRolloutAgent, {
  agentMeta: { name: "my-agent", version: "1.2" },
});
console.log(outcome.passRate, outcome.evaluations);
```

| Option | Default | Meaning |
| --- | --- | --- |
| `count` / `minSuccessRate` / `maxSuccessRate` | `20` / `0.6` / `0.9` | Passed through to `prepare()`. |
| `dataset` | — | Roll out this dataset (id or `Dataset`); skips `prepare()` entirely. |
| `probeAgent` | derived | Probe agent for user-model creation. By default `agent` itself is driven: each probe question becomes a one-turn conversation and the sandbox calls it makes are traced onto the reply. |
| `probeMaxTurns` | `10` | Probe conversation cap. |
| `maxTurns` | `12` | Rollout turn cap. |
| `concurrency` | `4` | Scenarios in flight at once. |
| `repeats` | `1` | Roll the whole dataset out this many times. |
| `label` | — | Human name for the run on the platform's Runs page. |
| `agentMeta` | — | Which agent is under test (any JSON); strongly recommended. |
| `verbose` | `false` | Stream server telemetry. |

`EvalOutcome`: `{ prepare, dataset, results, qualityCheck, evaluations,
passRate }` — `prepare` is `null` when you passed `dataset`; `passRate` is
the judged pass fraction (`null` when nothing was judged). The individual
steps below remain available when you need to intervene between them.

### `await synthia.prepare(agent, options?)` → `PrepareResult`

The main entry point for the probe/generate half of the pipeline: **probe +
generate only when needed, otherwise reuse** the session's latest dataset.

```ts
const { dataset, action, reason } = await synthia.prepare(async (probe) => {
  return myAgent.respond(probe);
});
```

| Option | Default | Meaning |
| --- | --- | --- |
| `count` | `20` | Exact dataset size. Reuse requires the latest dataset to match it. |
| `maxTurns` | `10` | Probe conversation cap. |
| `minSuccessRate` | `0.6` | Lower edge of the healthy pass-rate band. |
| `maxSuccessRate` | `0.9` | Upper edge — a suite your agent aces teaches nothing. |
| `verbose` | `false` | Stream server telemetry (probe decisions, generation progress). |
| `voice` | `false` | Also voice every generated scenario (voice-enabled accounts; spends per row). Handles return still-running on `result.voiceRenders`. |

Decision rules — probing/generation runs only when:

1. **No dataset exists** in this session yet; or
2. the latest completed quality check's pass rate falls **outside
   `[minSuccessRate, maxSuccessRate]`** — the server is passed that check so
   the new batch recalibrates difficulty and coverage against your agent's
   real results (this is the one case that also re-probes); or
3. the latest dataset's **row count ≠ `count`** — regenerates at the new
   size but reuses the session's probed user model (no drift signal, no
   re-probe).

Otherwise the latest dataset is **reused**. All lookups are scoped to this
client's session, so other scripts' results never trigger regeneration
here. `PrepareResult`: `{ dataset, userModel, action: "generated"|"reused",
reason, successRate, qualityCheckId, voiceRenders? }` — `reason` is the
human-readable decision trail; log it in CI.

### `await synthia.voiceRender({ scenarioId | rolloutId, ...VoiceOptions })` → `VoiceRender`

Voice one scenario (an LLM authors the two-sided script) or one finished
rollout (deterministic transcript transform — words verbatim). Exactly one
source id. Requires a voice-enabled account (403s are translated into an
actionable error). `VoiceOptions`: `takes` (default 1), `stability` (0–1,
lower = more expressive; default from config, then 0.35), `annotate`,
`phoneFx`, `roomTone`, `voiceOverrides`.

## Resources

### `synthia.seeds`

- **`ingest({ kind, source, content, version?, metadata? })`** — upload seed
  material (documents, tool schemas, policies, traces…) that grounds
  probing and generation. `content` is overloaded: an object is ingested
  as-is; `Uint8Array` bytes or a path to an audio file
  (`.wav/.mp3/.m4a/.ogg/.flac/.webm`) is uploaded and transcribed
  server-side (voice-enabled accounts), the transcript becoming the seed.

### `synthia.userModels`

- **`createFromProbe(agent, { maxTurns?, verbose? })`** → `UserModel` — probe
  the agent until the server converges on a user model. The agent runs
  locally; only probe questions, replies, and traced tool calls travel.
- **`get(id)`**, **`list(session?)`**.

`UserModel`: `{ id, probe_session_id, persona, traits, representation_id }`.

### `synthia.datasets`

- **`generate(userModelOrId, { count?, qualityCheckId? })`** → `GenerationJob`
  — start scenario generation; `qualityCheckId` names a completed check
  whose real results calibrate the batch.
- **`get(id)`**, **`list(session?)`** (newest first).

### `synthia.rollouts`

- **`run(agent, dataset?, { maxTurns?, concurrency?, agentMeta? })`** →
  `RolloutResult[]` — play a dataset's scenarios against a local
  `RolloutAgent`. Defaults: `maxTurns` 12, `concurrency` 4. Turns within a
  conversation are sequential; scenarios run concurrently. `dataset`
  defaults to the session's latest. **Set `agentMeta`** (`{ name, version,
  model, … }`) — it's what lets the dashboard compare runs across agent
  versions. Turn posts that fail transiently are recovered with
  check-then-act idempotency (never blindly retried, so a reply can't
  double-advance the transcript).
- **`runScenario(agent, scenarioId, opts?)`** → `RolloutResult` — one
  scenario; one HTTP round-trip per agent turn.
- **`qualityCheck(rolloutsOrIds, label?)`** → `QualityCheck` — start the
  server-side evaluation of finished rollouts.
- **`get(rolloutId)`** — a stored rollout's full captured state.
- **`voice(rolloutOrId, VoiceOptions?)`** → `VoiceRender`;
  **`turnAudio(rolloutId, idx)`** → `Uint8Array` (turns with an `audio_url`).

`RolloutResult`: `{ rollout_id, scenario_id, status, turns, transcript,
tool_events, voice_render? }` (`voice_render` attaches, already running, on
voice-auto accounts).

## Jobs and `wait()`

`GenerationJob`, `ValidationRun`, `QualityCheck`, and `VoiceRender` are
polling handles over async server work. All share:

```ts
await job.wait({ pollInterval: 2, timeout: 1800, verbose: false });
```

`wait()` polls until the job leaves `running`, throws on failure or timeout,
and with `verbose: true` streams the server's per-stage telemetry lines.

- **`GenerationJob.wait()`** resolves to the finished **`Dataset`**.
- **`Dataset`**: `download()` (rows), `validate(label?)` → `ValidationRun`,
  `rollout(agent, opts)` (sugar for `rollouts.run`), fields `id`,
  `row_count`, `user_model_id`.
- **`ValidationRun`**: dataset validation — per-scenario judge gate plus
  collective `validity` / `fidelity` / `diversity` reports and an advisory
  `verdict`; `scenarios()` lists per-scenario verdicts.
- **`QualityCheck`**: `rollouts()` — the product: per-rollout
  `{ rollout_id, passed, states, judge }` (the agentic-state trajectory and
  the judge's dimensions/issues). There is deliberately no aggregate verdict.
- **`VoiceRender`**: `audio()` → WAV bytes, `saveAudio(path)`; fields
  `duration_ms`, `wpm`, `provenance` (per-turn take provenance).

## `ToolSandbox`

The deterministic tool environment rollout agents call into — a local
replica of the server's, hash-identical by construction, which is how the
server replays your agent's tool behavior from the events the SDK reports.

- **`call(name, input)`** → output — deterministic function of (tool name,
  input, state version, seed). Inputs must be JSON-native values. A tool
  the scenario planted a fault on fails **once** (`{ error }` with
  `is_error`), then succeeds on retry.
- **`report(name, output, { input?, isError? })`** — **bring your own
  environment**: record a call your agent made against its *real* tools.
  The server persists the reported output verbatim, so quality checks can
  judge whether the agent's claims were grounded in what its tools actually
  returned.
- **`shouldFail(name)`** — BYOE adversity: `true` exactly once for a tool
  this scenario plants a first-call fault on. Fail your real tool, return
  the error to your agent, and `report(..., { isError: true })` — so the
  scenario's adversity reaches an agent running its own environment.
- **`fromConfig(config)`**, and fields `seed`, `state`, `events` (the
  `ToolEvent[]` uploaded after each turn).

## Adapters (`synthiaresearch/adapters`)

Dependency-free glue between the `RolloutAgent` contract and framework chat
shapes. Copy-paste recipes per framework (LangGraph, OpenAI Agents SDK,
Vercel AI SDK, MCP): [docs/integrations/](../integrations/README.md).

- **`fromChatHandler(handler)`** → `RolloutAgent` — wrap any
  `(messages, sandbox) => reply` chat handler.
- **`transcriptToMessages(transcript)`** → `{ role, content }[]`.
- **`toolExecutors(sandbox, names)`** — name → executor map for frameworks
  that route tool calls by name; **`callTool(sandbox, name, input)`** — one
  call, JSON-string result.

## CI library (`synthiaresearch/ci`)

`runCommand(flags)` → `{ report, exitCode }` runs the full `synthia run`
flow in-process; `ConfigError` / `InfraError` are the typed failures, and
`RunReport` / `ScenarioRow` type the results JSON. This is the surface the
[GitHub Action](https://github.com/SynthiaResearch/synthia-action) drives.

## Error handling and retries

HTTP failures throw `Error`s carrying method, path, status, and the server's
body. Transient failures (network blips, 5xx/429 from serverless cold
starts) are retried with jittered backoff — but only where a duplicate is
harmless (GETs and create-style POSTs). Rollout turn posts are never blindly
retried; see `rollouts.run` above. Voice calls against a non-voice account
throw an actionable "ask your Synthia contact" error rather than a bare 403.
