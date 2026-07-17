from __future__ import annotations

import base64
import hashlib
import json
import os
import random
import sys
import time
import uuid
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, fields as _dc_fields
from importlib import metadata
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Union

import httpx

if TYPE_CHECKING:
    # Server payload shapes generated from the OpenAPI contract
    # (scripts/generate-sdk-types.sh). Typing-only: _api_types needs
    # typing_extensions, which is not a runtime dependency. Shapes whose
    # name is taken by a hand-written class get an Api prefix.
    from ._api_types import (
        DatasetRow,
        Rollout,
        RolloutEvaluation,
        ScenarioValidation,
        Seed,
        ToolCall as ApiToolCall,
        TranscriptTurn as ApiTranscriptTurn,
    )

DEFAULT_BASE_URL = "https://synthia-research--synthia-api-web.modal.run"

# Transient server statuses worth retrying (cold DB, overload, gateway).
_RETRYABLE_STATUS = {500, 502, 503, 504, 429, 529}
# POSTs where a retried duplicate is harmless because the caller keys off the
# returned id (an orphaned session/rollout/quality-check is wasteful, not
# wrong). Turn-advance POSTs (/v1/rollouts/{id}/turns) are deliberately absent:
# replaying one could double-advance the transcript — run_scenario recovers
# those explicitly (check-then-act) instead.
_CREATE_POSTS = ("/v1/sdk-sessions", "/v1/rollouts", "/v1/quality-checks")
# The server rejects quality checks over more rollouts than this
# (MAX_QUALITY_ROLLOUTS); run() judges bigger result sets in chunks.
_QUALITY_CHECK_CHUNK = 50


def _backoff(attempt: int) -> float:
    return 0.5 * (2 ** attempt) + random.uniform(0, 0.25)


class _RetryClient:
    """Thin wrapper over httpx.Client that transparently retries idempotent
    requests on transient failures — undici-equivalent hardening so a
    minutes-long CI run of many round trips doesn't die on one serverless
    blip. GETs and create-POSTs retry on network errors (httpx.TransportError)
    and 5xx up to 4 attempts with jittered backoff; everything else (notably
    the turn-advance POST) passes through unretried. All other attributes —
    headers, stream, close — delegate to the wrapped client."""

    def __init__(self, **kwargs) -> None:
        self._c = httpx.Client(**kwargs)

    def __getattr__(self, name):
        if name == "_c":  # not yet set / construction failed: don't recurse
            raise AttributeError(name)
        return getattr(self._c, name)

    def get(self, path, **kwargs) -> httpx.Response:
        return self._send("GET", path, True, **kwargs)

    def post(self, path, **kwargs) -> httpx.Response:
        return self._send("POST", path, path in _CREATE_POSTS, **kwargs)

    def _send(self, method, path, retry, **kwargs) -> httpx.Response:
        attempts = 4 if retry else 1
        for i in range(attempts):
            try:
                resp = self._c.request(method, path, **kwargs)
                resp = self._follow_attempt_redirects(method, resp, **kwargs)
            except httpx.TransportError:
                if i == attempts - 1:
                    raise
                time.sleep(_backoff(i))
                continue
            if retry and resp.status_code in _RETRYABLE_STATUS and i < attempts - 1:
                time.sleep(_backoff(i))
                continue
            return resp
        raise AssertionError("unreachable")  # pragma: no cover

    def _follow_attempt_redirects(self, method, resp, **kwargs) -> httpx.Response:
        """Follow Modal's 303 attempt-token redirects (served while a
        deployment hands requests between containers). The redirect resumes
        the SAME attempt via the token: the original request was already
        accepted, and a GET on the tokened URL awaits its result (async-
        poll pattern) — safe for turn-advance POSTs because nothing is
        resubmitted. Without this, every deploy kills every in-flight
        run."""
        del method, kwargs  # the original input was already accepted
        for _ in range(30):
            if resp.status_code != 303:
                return resp
            location = resp.headers.get("location", "")
            if "__modal_attempt_token" not in location:
                return resp
            # Async-poll pattern: GET the tokened URL to await the result
            # of the already-submitted request. Re-POSTing is rejected 400.
            resp = self._c.get(location)
        return resp

# File suffixes treated as audio when a path is passed where content/replies
# are overloaded (seeds.ingest, rollout agent replies accept audio too).
_AUDIO_SUFFIXES = {".wav", ".mp3", ".m4a", ".ogg", ".flac", ".webm"}


def _as_audio_bytes(value) -> "tuple[bytes, str | None] | None":
    """(audio bytes, filename) when `value` is audio — raw bytes or a path to
    an audio file — else None. This is the runtime half of the overloads."""
    if isinstance(value, (bytes, bytearray)):
        return bytes(value), None
    if isinstance(value, (str, Path)):
        p = Path(value)
        if p.suffix.lower() in _AUDIO_SUFFIXES:
            return p.read_bytes(), p.name
    return None


def _raise_for_voice(r: httpx.Response) -> None:
    """403 on a voice surface means the account's config doesn't enable
    voice — raise something actionable instead of a bare status error."""
    if r.status_code == 403:
        detail = r.json().get("detail", "voice is not enabled for this account")
        raise RuntimeError(
            f"{detail} — voice is enabled per customer config; ask your "
            "Synthia contact to turn it on for your organization")
    r.raise_for_status()

# Launcher argv[0] values that don't identify a script (notebooks, REPLs).
_INTERACTIVE_STEMS = {"", "-c", "-m", "ipykernel_launcher", "pydevconsole"}


def _default_session_name() -> str:
    """Stable session name derived from the entry-point script.

    Last two path components only ("project/script"): readable, survives
    moving the project, and never leaks the full directory layout. Falls
    back to the working directory's name for notebooks and REPLs.
    """
    argv0 = sys.argv[0] if sys.argv else ""
    if not argv0 or Path(argv0).stem in _INTERACTIVE_STEMS:
        return Path.cwd().resolve().name
    p = Path(argv0).resolve()
    return f"{p.parent.name}/{p.stem}"


def _sdk_version() -> str | None:
    # Distribution is "synthiaresearch"; "synthia" is only the import name
    # (and the old pre-rename distribution, kept as a fallback).
    for dist in ("synthiaresearch", "synthia"):
        try:
            return metadata.version(dist)
        except metadata.PackageNotFoundError:
            continue
    return None


def _build(cls, data: dict, **extra):
    """Construct a response dataclass, ignoring unknown server fields —
    newer servers return more than older SDKs know about."""
    known = {f.name for f in _dc_fields(cls)}
    return cls(**{k: v for k, v in data.items() if k in known}, **extra)


@dataclass
class ToolCall:
    """One traced tool invocation made by the agent while answering a probe."""
    name: str
    input: dict
    output: dict | None = None
    is_error: bool = False


@dataclass
class AgentReply:
    """An agent's reply plus the tool calls it made producing it."""
    reply: str
    tool_calls: list[ToolCall] = field(default_factory=list)


# An agent takes a probe question and returns its reply — a plain string, or
# an AgentReply carrying traced tool calls.
Agent = Callable[[str], Union[str, AgentReply]]


class ToolSandbox:
    """Local replica of the server's deterministic tool sandbox.

    Must stay hash-identical to synthia_api.pipeline.rollout.ToolSandbox:
    outputs are a pure function of (tool name, input, state version, seed),
    which is how the server reproduces the same tool behavior from the
    events the SDK reports. Tool inputs must be JSON-native values that
    round-trip exactly (e.g. tuples arrive as lists, 1 and 1.0 differ).
    """

    def __init__(self, seed: int, fail_tools: set[str] | None = None,
                 state: dict | None = None):
        self.seed = seed
        self.fail_tools = fail_tools or set()
        self.state = dict(state or {})
        self.events: list[dict] = []
        # Per-rollout scratch space for YOUR agent's state (stores, clients,
        # framework sessions): created fresh for every rollout and dies with
        # it. Use `sandbox.context.setdefault("world", make_world())` —
        # never key external dicts by id(sandbox) (ids are recycled after
        # GC and will hand a new rollout an old conversation's state).
        self.context: dict = {}

    @classmethod
    def from_config(cls, config: "Mapping[str, Any]") -> "ToolSandbox":
        return cls(seed=config["seed"], fail_tools=set(config["fail_tools"]),
                   state=config["state"])

    def report(self, name: str, output: dict, *, input: dict | None = None,
               is_error: bool = False) -> None:
        """Record a tool call the agent made against its OWN environment.

        Use this when your agent has real tools (a database, an API, a
        store) instead of the synthetic sandbox: the server persists the
        reported output verbatim, so quality checks can judge whether the
        agent's claims were grounded in what its tools actually returned.
        """
        self.events.append({"name": name, "input": input or {},
                            "output": output, "is_error": is_error,
                            "external": True})

    def should_fail(self, name: str) -> bool:
        """BYOE adversity: True exactly once for a tool this scenario
        plants a first-call fault on. Fail your real tool (return an error
        to your agent) and report(..., is_error=True), so the scenario's
        adversity actually reaches an agent running its own environment."""
        if name in self.fail_tools:
            self.fail_tools.discard(name)
            return True
        return False

    def call(self, name: str, tool_input: dict) -> dict:
        is_error = name in self.fail_tools
        if is_error:
            # fail once, like the server: the retry must succeed
            self.fail_tools.discard(name)
            output = {"error": f"{name} is unavailable"}
        else:
            digest = hashlib.sha256(
                json.dumps([name, tool_input, self.state.get("version", 0),
                            self.seed], sort_keys=True).encode()
            ).hexdigest()[:8]
            output = {"ok": True, "result_id": digest}
            self.state["version"] = self.state.get("version", 0) + 1
            self.state[f"last_{name}"] = digest
        self.events.append({"name": name, "input": tool_input,
                            "output": output, "is_error": is_error})
        return output


# A rollout agent takes the conversation transcript ([{role, content}]) and a
# ToolSandbox for its tool calls, and returns its reply — text, or audio
# bytes / a path to an audio file (voice-enabled accounts: the server
# transcribes it and the transcript drives the simulator). It is invoked
# from worker threads when rollouts run concurrently, so it must be
# thread-safe. Voiced simulated-user turns carry an `audio_url` on their
# transcript entries (fetch via Rollouts.turn_audio).
RolloutAgent = Callable[[list, ToolSandbox], Union[str, bytes, Path]]


def _probe_from_rollout(agent: RolloutAgent) -> Agent:
    """Drive a RolloutAgent with a probe question as a one-turn
    conversation, tracing its sandbox calls onto the probe reply so
    probing still observes tool usage."""
    def probe(question: str) -> AgentReply:
        sandbox = ToolSandbox(seed=0)
        reply = agent([{"role": "user", "content": question}], sandbox)
        if not isinstance(reply, str):
            raise TypeError("probing needs a text reply — pass probe_agent "
                            "for audio agents")
        return AgentReply(reply=reply, tool_calls=[
            ToolCall(name=e["name"], input=e["input"], output=e.get("output"),
                     is_error=bool(e.get("is_error")))
            for e in sandbox.events])
    return probe


class _EventStream:
    """Cursor-based poller that prints a run's server-side telemetry."""

    def __init__(self, http: httpx.Client, path: str, enabled: bool):
        self._http = http
        self._path = path
        self._after = 0
        self._enabled = enabled

    def pump(self) -> None:
        """Fetch and print events newer than the cursor."""
        if not self._enabled:
            return
        r = self._http.get(self._path, params={"after": self._after})
        r.raise_for_status()
        for event in r.json()["data"]:
            self._after = event["seq"]
            detail = " ".join(f"{k}={v}" for k, v in event["data"].items())
            print(f"    ~ [{event['stage']}] {event['message']}"
                  + (f"  ({detail})" if detail else ""))


@dataclass
class UserModel:
    id: str
    probe_session_id: str
    persona: str
    traits: list[str]
    representation_id: str | None


@dataclass
class ValidationRun:
    """A validation of a dataset: a per-scenario judge gate plus
    collective fidelity/diversity reports and an advisory verdict."""
    id: str
    dataset_id: str
    status: str
    label: str | None
    verdict: str | None
    reference: dict | None
    validity: dict | None
    fidelity: dict | None
    diversity: dict | None
    error: str | None
    _http: httpx.Client

    def wait(self, poll_interval: float = 2.0, timeout: float = 1800.0,
             verbose: bool = False) -> "ValidationRun":
        """Poll until validation finishes; verbose prints server telemetry."""
        events = _EventStream(
            self._http, f"/v1/validation-runs/{self.id}/events", verbose)
        deadline = time.monotonic() + timeout
        while self.status == "running":
            if time.monotonic() > deadline:
                raise TimeoutError(
                    f"validation run {self.id} still running after {timeout}s")
            time.sleep(poll_interval)
            r = self._http.get(f"/v1/validation-runs/{self.id}")
            r.raise_for_status()
            data = r.json()
            for key in ("status", "verdict", "reference", "validity",
                        "fidelity", "diversity", "error"):
                setattr(self, key, data[key])
            events.pump()
        events.pump()  # catch events written after the final status poll
        if self.status != "succeeded":
            raise RuntimeError(f"validation run {self.id} failed: {self.error}")
        return self

    def scenarios(self) -> list[ScenarioValidation]:
        """Per-scenario judge verdicts: scenario_id, passed, judge."""
        r = self._http.get(f"/v1/validation-runs/{self.id}/scenarios")
        r.raise_for_status()
        return r.json()["data"]


@dataclass
class Dataset:
    id: str
    generation_id: str
    user_model_id: str
    row_count: int
    _http: httpx.Client

    def download(self) -> list[DatasetRow]:
        r = self._http.get(f"/v1/datasets/{self.id}/rows")
        r.raise_for_status()
        return r.json()["data"]

    def validate(self, label: str | None = None) -> ValidationRun:
        """Start an async validation run over this dataset. `label` is a
        human name shown on the platform's Runs page."""
        r = self._http.post(f"/v1/datasets/{self.id}/validations",
                            json={"label": label} if label else None)
        r.raise_for_status()
        return _build(ValidationRun, r.json(), _http=self._http)

    def rollout(self, agent: "RolloutAgent", **kwargs) -> "list[RolloutResult]":
        """Play this dataset's scenarios against a local agent."""
        return Rollouts(self._http).run(agent, dataset=self, **kwargs)


@dataclass
class GenerationJob:
    id: str
    status: str
    user_model_id: str
    count: int
    dataset_id: str | None
    error: str | None
    _http: httpx.Client

    def wait(self, poll_interval: float = 2.0, timeout: float = 1800.0,
             verbose: bool = False) -> Dataset:
        """Poll until the job finishes; verbose prints server telemetry live."""
        events = _EventStream(
            self._http, f"/v1/generations/{self.id}/events", verbose)
        deadline = time.monotonic() + timeout
        while self.status == "running":
            if time.monotonic() > deadline:
                raise TimeoutError(f"generation {self.id} still running after {timeout}s")
            time.sleep(poll_interval)
            r = self._http.get(f"/v1/generations/{self.id}")
            r.raise_for_status()
            data = r.json()
            self.status = data["status"]
            self.dataset_id = data["dataset_id"]
            self.error = data["error"]
            events.pump()
        events.pump()  # catch events written after the final status poll
        if self.status != "succeeded":
            raise RuntimeError(f"generation {self.id} failed: {self.error}")
        r = self._http.get(f"/v1/datasets/{self.dataset_id}")
        r.raise_for_status()
        return _build(Dataset, r.json(), _http=self._http)


class Seeds:
    def __init__(self, http: httpx.Client):
        self._http = http

    def ingest(self, *, kind: str, source: str,
               content: Union[dict, str, Path, bytes],
               version: str = "1", metadata: dict | None = None) -> Seed:
        """Upload seed material (documents, tool schemas, policies, traces...).

        Overloaded on `content`: a dict is ingested as-is (text pipeline);
        raw bytes or a path to an audio file (.wav/.mp3/...) is uploaded and
        transcribed server-side (voice-enabled accounts only) — the
        transcript becomes the seed content.
        """
        audio = _as_audio_bytes(content)
        if audio is not None:
            data, filename = audio
            r = self._http.post("/v1/seeds", json={
                "kind": kind, "source": source,
                "audio_b64": base64.b64encode(data).decode(),
                "audio_filename": filename,
                "version": version, "metadata": metadata or {},
            })
            _raise_for_voice(r)
            return r.json()
        if not isinstance(content, dict):
            raise TypeError(
                "content must be a dict, or audio bytes / a path to an "
                f"audio file ({', '.join(sorted(_AUDIO_SUFFIXES))})")
        r = self._http.post("/v1/seeds", json={
            "kind": kind, "source": source, "content": content,
            "version": version, "metadata": metadata or {},
        })
        r.raise_for_status()
        return r.json()


class UserModels:
    def __init__(self, http: httpx.Client):
        self._http = http

    def create_from_probe(self, agent: Agent, max_turns: int = 10,
                          verbose: bool = False) -> UserModel:
        """Probe `agent` until the server converges on a user model.

        The agent runs locally; only probe questions, replies, and traced
        tool calls travel over the wire. `verbose` prints the server's
        telemetry (probe decisions, ingestion, inference) after each turn.
        """
        r = self._http.post("/v1/probe-sessions", json={"max_turns": max_turns})
        r.raise_for_status()
        session = r.json()
        events = _EventStream(
            self._http, f"/v1/probe-sessions/{session['id']}/events", verbose)
        while session["status"] == "active":
            raw = agent(session["next_probe"])
            reply = raw if isinstance(raw, str) else raw.reply
            tool_calls = [] if isinstance(raw, str) else [
                asdict(tc) for tc in raw.tool_calls
            ]
            r = self._http.post(
                f"/v1/probe-sessions/{session['id']}/responses",
                json={"reply": reply, "tool_calls": tool_calls},
            )
            r.raise_for_status()
            session = r.json()
            events.pump()
        return self.get(session["user_model_id"])

    def get(self, model_id: str) -> UserModel:
        r = self._http.get(f"/v1/user-models/{model_id}")
        r.raise_for_status()
        return _build(UserModel, r.json())

    def list(self, session: str | None = None) -> list[UserModel]:
        params = {"sdk_session": session} if session else {}
        r = self._http.get("/v1/user-models", params=params)
        r.raise_for_status()
        return [_build(UserModel, m) for m in r.json()["data"]]


class Datasets:
    def __init__(self, http: httpx.Client):
        self._http = http

    def get(self, dataset_id: str) -> Dataset:
        r = self._http.get(f"/v1/datasets/{dataset_id}")
        r.raise_for_status()
        return _build(Dataset, r.json(), _http=self._http)

    def list(self, session: str | None = None) -> list[Dataset]:
        """Datasets newest first; `session` filters to one SDK session."""
        params = {"sdk_session": session} if session else {}
        r = self._http.get("/v1/datasets", params=params)
        r.raise_for_status()
        return [_build(Dataset, d, _http=self._http) for d in r.json()["data"]]

    def generate(self, user_model: UserModel | str, count: int = 20, *,
                 quality_check_id: str | None = None) -> GenerationJob:
        """Start a generation job. quality_check_id names a completed quality
        check whose results calibrate the batch's difficulty and coverage."""
        model_id = user_model.id if isinstance(user_model, UserModel) else user_model
        body = {"user_model_id": model_id, "count": count}
        if quality_check_id:
            body["quality_check_id"] = quality_check_id
        r = self._http.post("/v1/generations", json=body)
        r.raise_for_status()
        return _build(GenerationJob, r.json(), _http=self._http)


@dataclass
class PrepareResult:
    """Outcome of Synthia.prepare(): the dataset to roll out, the user model
    behind it, and how the decision was made. voice_renders holds running
    render handles when prepare(voice=True) pre-voiced the scenarios."""
    dataset: Dataset
    user_model: UserModel
    action: str                     # "generated" | "reused"
    reason: str                     # human-readable decision trail
    success_rate: float | None      # latest completed check's rate, if any
    quality_check_id: str | None    # check that calibrated generation, if any
    voice_renders: "list[VoiceRender]" = field(default_factory=list)


@dataclass
class QualityCheck:
    """An async evaluation of finished rollouts: per rollout, the server
    analyzes the agent's state trajectory and judges pass/fail. The
    per-rollout results are the product; there is no aggregate verdict."""
    id: str
    status: str
    rollout_ids: list[str]
    label: str | None
    error: str | None
    _http: httpx.Client

    def wait(self, poll_interval: float = 2.0, timeout: float = 1800.0,
             verbose: bool = False) -> "QualityCheck":
        """Poll until the check finishes; verbose prints server telemetry."""
        events = _EventStream(
            self._http, f"/v1/quality-checks/{self.id}/events", verbose)
        deadline = time.monotonic() + timeout
        while self.status == "running":
            if time.monotonic() > deadline:
                raise TimeoutError(
                    f"quality check {self.id} still running after {timeout}s")
            time.sleep(poll_interval)
            r = self._http.get(f"/v1/quality-checks/{self.id}")
            r.raise_for_status()
            data = r.json()
            self.status = data["status"]
            self.error = data["error"]
            events.pump()
        events.pump()  # catch events written after the final status poll
        if self.status != "succeeded":
            raise RuntimeError(f"quality check {self.id} failed: {self.error}")
        return self

    def rollouts(self) -> list[RolloutEvaluation]:
        """Per-rollout results: rollout_id, passed, states (the agentic-state
        trajectory), and judge (dimensions + issues)."""
        r = self._http.get(f"/v1/quality-checks/{self.id}/rollouts")
        r.raise_for_status()
        return r.json()["data"]


@dataclass
class VoiceRender:
    """An async voice render: a scenario (LLM-authored script) or a rollout
    transcript, voiced with ElevenLabs — N takes spliced into one mixed WAV
    with per-turn provenance. Requires a voice-enabled customer config."""
    id: str
    status: str
    scenario_id: str | None
    rollout_id: str | None
    params: dict
    duration_ms: int | None
    wpm: float | None
    provenance: list[dict] | None
    error: str | None
    _http: httpx.Client

    def wait(self, poll_interval: float = 2.0, timeout: float = 1800.0,
             verbose: bool = False) -> "VoiceRender":
        """Poll until the render finishes; verbose prints server telemetry
        (per-TTS-call latencies, take/mix progress)."""
        events = _EventStream(
            self._http, f"/v1/voice-renders/{self.id}/events", verbose)
        deadline = time.monotonic() + timeout
        while self.status == "running":
            if time.monotonic() > deadline:
                raise TimeoutError(
                    f"voice render {self.id} still running after {timeout}s")
            time.sleep(poll_interval)
            r = self._http.get(f"/v1/voice-renders/{self.id}")
            r.raise_for_status()
            data = r.json()
            for key in ("status", "params", "duration_ms", "wpm",
                        "provenance", "error"):
                setattr(self, key, data[key])
            events.pump()
        events.pump()  # catch events written after the final status poll
        if self.status != "succeeded":
            raise RuntimeError(f"voice render {self.id} failed: {self.error}")
        return self

    def audio(self) -> bytes:
        """The mixed conversation WAV."""
        r = self._http.get(f"/v1/voice-renders/{self.id}/audio")
        _raise_for_voice(r)
        return r.content

    def save_audio(self, path: Union[str, Path]) -> Path:
        """Write the mixed conversation WAV to `path`; returns it."""
        p = Path(path)
        p.write_bytes(self.audio())
        return p


def _create_voice_render(http: httpx.Client, body: dict) -> VoiceRender:
    r = http.post("/v1/voice-renders",
                  json={k: v for k, v in body.items() if v is not None})
    _raise_for_voice(r)
    return _build(VoiceRender, r.json(), _http=http)


@dataclass
class RolloutResult:
    """One finished rollout: the conversation a scenario produced, plus every
    tool call the agent made along the way (each tagged with its turn_idx).
    voice_render is attached (already running) when the account's config has
    voice.auto — call .wait()/.save_audio() on it if you want the WAV."""
    rollout_id: str
    scenario_id: str
    status: str
    turns: int
    transcript: "list[ApiTranscriptTurn]"
    tool_events: "list[ApiToolCall]"
    voice_render: "VoiceRender | None" = None


@dataclass
class EvalOutcome:
    """Outcome of Synthia.run(): everything each step produced, judged."""
    prepare: PrepareResult | None   # None when a dataset was passed in
    dataset: Dataset
    results: "list[RolloutResult]"
    quality_check: QualityCheck
    evaluations: "list[RolloutEvaluation]"  # per-rollout judge rows
    pass_rate: float | None         # judged pass fraction; None when empty


class Rollouts:
    def __init__(self, http: httpx.Client, session_id: str | None = None,
                 voice_auto: bool = False):
        self._http = http
        self._session_id = session_id
        self._voice_auto = voice_auto

    def get(self, rollout_id: str) -> Rollout:
        """A stored rollout's full captured state: status, seed, transcript,
        tool events, and sandbox."""
        r = self._http.get(f"/v1/rollouts/{rollout_id}")
        r.raise_for_status()
        return r.json()

    def voice(self, rollout: "Union[RolloutResult, str]", *,
              takes: int = 1, stability: float | None = None,
              annotate: bool = False, phone_fx: bool = False,
              room_tone: bool = False,
              voice_overrides: dict | None = None) -> VoiceRender:
        """Voice a finished rollout: the transcript maps to a script
        deterministically (words verbatim; `annotate` may add delivery tags
        only), then N takes are rendered and spliced into one mixed WAV.
        Voices are cast from the scenario unless overridden; `stability`
        (0..1) trades consistency for expressiveness. Requires a
        voice-enabled customer config (403 otherwise)."""
        rollout_id = (rollout.rollout_id
                      if isinstance(rollout, RolloutResult) else rollout)
        return _create_voice_render(self._http, {
            "rollout_id": rollout_id, "takes": takes, "stability": stability,
            "annotate": annotate, "phone_fx": phone_fx,
            "room_tone": room_tone,
            "voice_overrides": voice_overrides})

    def turn_audio(self, rollout_id: str, idx: int) -> bytes:
        """One voiced turn's WAV (turns with an audio_url only)."""
        r = self._http.get(f"/v1/rollouts/{rollout_id}/turns/{idx}/audio")
        _raise_for_voice(r)
        return r.content

    def run(self, agent: RolloutAgent, dataset: Union[Dataset, str, None] = None,
            *, max_turns: int = 12, concurrency: int = 4,
            agent_meta: dict | None = None) -> list[RolloutResult]:
        """Play a dataset's scenarios against `agent` (most recent dataset
        when none is given).

        The agent runs locally: each turn it gets the transcript so far and
        a deterministic ToolSandbox for its tool calls; only its reply and
        tool events travel over the wire. Scenarios run on `concurrency`
        worker threads (turns within one conversation are sequential), so
        the agent must be thread-safe — pass concurrency=1 to opt out.

        `agent_meta` declares which agent is under test ({"name", "version",
        "model", ...} — any JSON). It is pure telemetry, stored on every
        rollout, and what lets the platform's Runs page compare results
        across your agent's versions. Strongly recommended.
        """
        if dataset is None:
            # Session-scoped default: this script's latest dataset, so two
            # concurrent scripts never pick up each other's data.
            data = []
            if self._session_id:
                r = self._http.get("/v1/datasets",
                                   params={"sdk_session": self._session_id})
                r.raise_for_status()
                data = r.json()["data"]
            if not data:
                r = self._http.get("/v1/datasets")
                r.raise_for_status()
                data = r.json()["data"]
                if data and self._session_id:
                    print(f"note: no dataset in this session yet; "
                          f"using latest dataset {data[0]['id']}")
            if not data:
                raise RuntimeError("no datasets exist yet; generate one first")
            dataset_id = data[0]["id"]
        else:
            dataset_id = dataset.id if isinstance(dataset, Dataset) else dataset
        r = self._http.get(f"/v1/datasets/{dataset_id}/rows")
        r.raise_for_status()
        rows = r.json()["data"]
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            results = list(pool.map(
                lambda row: self.run_scenario(
                    agent, row["scenario_id"], max_turns=max_turns,
                    random_seed=row.get("random_seed"),
                    agent_meta=agent_meta, dataset_id=dataset_id),
                rows))
        if self._voice_auto:
            # voice.auto accounts: every completed rollout gets a takes=1
            # mixed render, kicked here and attached still-running — audio
            # is ready server-side whether or not anyone .wait()s.
            for result in results:
                if result.status == "completed":
                    try:
                        result.voice_render = self.voice(result, takes=1)
                    except Exception:
                        pass  # rendering is a bonus; results stand alone
        return results

    def quality_check(
            self, rollouts: "Sequence[Union[RolloutResult, str]]",
            label: str | None = None) -> QualityCheck:
        """Start an async quality check over finished rollouts: the server
        analyzes each rollout's agentic states in parallel and judges
        whether the agent passed each scenario. `label` is a human name
        shown on the platform's Runs page."""
        rollout_ids = [r.rollout_id if isinstance(r, RolloutResult) else r
                       for r in rollouts]
        r = self._http.post("/v1/quality-checks",
                            json={"rollout_ids": rollout_ids, "label": label})
        r.raise_for_status()
        return _build(QualityCheck, r.json(), _http=self._http)

    def _recover_turn(self, rollout_id: str, prior_turn: int,
                      body: dict, original: Exception) -> Rollout:
        """Recover a turn post that failed transiently (lost/timed-out
        connection or a retryable 5xx) without risking a double-advance.
        Re-fetch the rollout: if its turn count moved past `prior_turn` the
        write landed (only the response was lost) — adopt that state; if it's
        unchanged and still running, re-send once. A genuine 4xx (409/422/403)
        re-raises. Mirrors the JS client's #recoverTurn."""
        transient = isinstance(original, httpx.TransportError) or (
            isinstance(original, httpx.HTTPStatusError)
            and original.response.status_code in _RETRYABLE_STATUS)
        if not transient:
            raise original
        try:
            gr = self._http.get(f"/v1/rollouts/{rollout_id}")  # retried
            gr.raise_for_status()
            fetched = gr.json()
        except httpx.HTTPError:
            raise original  # can't confirm state — surface the original failure
        if fetched["status"] != "running" or fetched["turn"] > prior_turn:
            return fetched  # the turn landed (or the rollout finished); continue
        # The turn never reached the server — safe to send it again.
        r = self._http.post(f"/v1/rollouts/{rollout_id}/turns", json=body)
        r.raise_for_status()
        return r.json()

    def run_scenario(self, agent: RolloutAgent, scenario_id: str, *,
                     max_turns: int = 12, random_seed: int | None = None,
                     agent_meta: dict | None = None,
                     dataset_id: str | None = None) -> RolloutResult:
        """Run one rollout session; one HTTP round-trip per agent turn."""
        r = self._http.post("/v1/rollouts", json={
            "scenario_id": scenario_id, "random_seed": random_seed,
            "max_turns": max_turns, "agent": agent_meta,
            "dataset_id": dataset_id,
        })
        r.raise_for_status()
        session: "Rollout" = r.json()
        while session["status"] == "running":
            sandbox = ToolSandbox.from_config(session["sandbox"])
            reply = agent(session["transcript"], sandbox)
            body: dict[str, Any] = {"tool_calls": sandbox.events}
            audio = _as_audio_bytes(reply)
            if audio is not None:
                # The agent replied with audio — the server transcribes it
                # (voice-enabled accounts) and the transcript drives the
                # simulator.
                body["reply"] = ""
                body["audio_b64"] = base64.b64encode(audio[0]).decode()
            else:
                body["reply"] = reply
            # Turn posts advance server transcript state, so a blind retry
            # could double-record the reply (the retry client excludes them).
            # Recover explicitly: on a transient failure re-fetch the rollout
            # and only re-send if the turn didn't land.
            prior_turn = session["turn"]
            try:
                r = self._http.post(
                    f"/v1/rollouts/{session['id']}/turns", json=body)
                if audio is not None:
                    _raise_for_voice(r)
                else:
                    r.raise_for_status()
                session = r.json()
            except (httpx.TransportError, httpx.HTTPStatusError) as e:
                if audio is not None:
                    # Voice path: don't attempt turn recovery — translate a
                    # 403 to a friendly voice error, otherwise re-raise.
                    if isinstance(e, httpx.HTTPStatusError):
                        _raise_for_voice(e.response)
                    raise
                session = self._recover_turn(
                    session["id"], prior_turn, body, e)
        return RolloutResult(
            rollout_id=session["id"], scenario_id=scenario_id,
            status=session["status"], turns=session["turn"],
            transcript=session["transcript"],
            tool_events=session.get("tool_events", []))


class Synthia:
    """Client entry point.

    Session identity: every client belongs to a named session — the stable,
    account-scoped identity of one script, persisted across executions
    (same name resumes the same session; re-runs reuse its datasets instead
    of re-probing/re-generating). Resolution order: `session` arg >
    SYNTHIA_SESSION env var > derived "project/script" name from the entry
    point. `session=False` opts out into a fresh ephemeral session.

    Degradation: an old server without /v1/sdk-sessions -> no session
    (today's behavior); keyless against a keyed server -> anonymous session;
    an invalid api_key fails immediately with the server's message.

    Voice: the session handshake mirrors the account's customer config
    (voice_enabled unlocks the voice surfaces; voice_auto makes rollouts
    voice themselves). `voice` overrides the mode for this client:
    voice=True behaves like a voice.auto account — every completed rollout
    gets a mixed-WAV render attached (requires a voice-enabled config;
    raises up front otherwise) — and voice=False keeps rollouts text-only
    even when the config says auto. voice=None (default) follows the config.
    """

    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 session: Union[str, bool, None] = None,
                 voice: bool | None = None,
                 ci: dict | None = None):
        api_key = api_key or os.environ.get("SYNTHIA_API_KEY")
        base_url = base_url or os.environ.get("SYNTHIA_BASE_URL", DEFAULT_BASE_URL)
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        # Generous timeout: probe convergence runs model inference server-side.
        # _RetryClient adds transient-failure retries over httpx.Client.
        self._http = _RetryClient(base_url=base_url, headers=headers, timeout=300.0)
        # CI provenance (commit sha, branch, ...) sent on the handshake and
        # stamped onto every run this invocation creates; reporting only.
        self._ci = ci
        if session is False:
            self.session_name = (f"{_default_session_name()}"
                                 f"/eph-{uuid.uuid4().hex[:8]}")
        elif isinstance(session, str) and session:
            self.session_name = session
        else:
            self.session_name = (os.environ.get("SYNTHIA_SESSION")
                                 or _default_session_name())
        self.session_id: str | None = None
        self.invocation_id: str | None = None
        # Voice mode, mirrored from the account's customer config by the
        # session handshake: enabled unlocks the voice surfaces; auto makes
        # rollouts voice themselves. The `voice` argument overrides the
        # config-mirrored auto default for this client (see class docstring).
        self.voice_enabled: bool = False
        self.voice_auto: bool = False
        # CI floors/caps mirrored from the customer config by the handshake
        # (shape: pass_rate_floor, max_concurrency, default_pass_rate); None
        # when the account has no CI policy. Populated by _start_session.
        self.ci_settings: dict | None = None
        self._start_session()
        if voice is not None:
            if voice and self.session_id and not self.voice_enabled:
                # Fail fast only when the handshake actually reported the
                # account's capabilities; degraded runs get the server's
                # friendly 403 on first voice call instead.
                raise RuntimeError(
                    "voice=True but voice is not enabled for this account — "
                    "voice is enabled per customer config; ask your Synthia "
                    "contact to turn it on for your organization")
            self.voice_auto = voice
        self.seeds = Seeds(self._http)
        self.user_models = UserModels(self._http)
        self.datasets = Datasets(self._http)
        self.rollouts = Rollouts(self._http, session_id=self.session_id,
                                 voice_auto=self.voice_auto)

    def _start_session(self) -> None:
        """One handshake per process: get-or-create the named session and
        mint this invocation; all later requests carry both ids as headers.

        The serverless backend can 500 on the first request after idling
        (cold start), and the handshake is every process's first request —
        retry briefly (which also warms the container for everything that
        follows), then degrade to sessionless rather than failing the
        constructor over optional tracking."""
        body = {"name": self.session_name, "sdk_version": _sdk_version()}
        if self._ci:
            body["ci"] = self._ci
        r = None
        for attempt in range(3):
            try:
                r = self._http.post("/v1/sdk-sessions", json=body)
            except httpx.HTTPError:
                r = None
            if r is not None and r.status_code < 500:
                break
            if attempt < 2:
                time.sleep(2 * (attempt + 1))
        if r is None or r.status_code >= 500:
            return  # transient trouble even after retries: run untracked
        if r.status_code == 404:
            return  # server predates sessions: degrade to old behavior
        if r.status_code == 401:
            raise RuntimeError(r.json().get("detail", "invalid API key"))
        r.raise_for_status()
        data = r.json()
        self.session_id = data["sdk_session_id"]
        self.invocation_id = data["sdk_invocation_id"]
        self.voice_enabled = data.get("voice_enabled", False)
        self.voice_auto = data.get("voice_auto", False)
        self.ci_settings = data.get("ci")
        self._http.headers["X-Synthia-Session"] = self.session_id
        self._http.headers["X-Synthia-Invocation"] = self.invocation_id

    def voice_render(self, *, scenario_id: str | None = None,
                     rollout_id: str | None = None, takes: int = 1,
                     stability: float | None = None, annotate: bool = False,
                     phone_fx: bool = False, room_tone: bool = False,
                     voice_overrides: dict | None = None) -> VoiceRender:
        """Voice one scenario (an LLM authors the full two-sided script) or
        one finished rollout (deterministic transcript transform). Exactly
        one source id. Voices are cast from the scenario unless overridden;
        `stability` (0..1) trades consistency for expressiveness. Requires
        a voice-enabled customer config."""
        return _create_voice_render(self._http, {
            "scenario_id": scenario_id, "rollout_id": rollout_id,
            "takes": takes, "stability": stability, "annotate": annotate,
            "phone_fx": phone_fx, "room_tone": room_tone,
            "voice_overrides": voice_overrides})

    def prepare(self, agent: Agent, *, count: int = 100, max_turns: int = 10,
                min_success_rate: float = 0.6, max_success_rate: float = 0.9,
                reprobe: bool = False,
                verbose: bool = False, voice: bool = False) -> PrepareResult:
        """Probe + generate only when needed; otherwise reuse the latest
        dataset. See _prepare for the decision rules. `reprobe=True` skips
        every reuse check: the agent is re-interviewed, the context
        re-distilled, and a fresh batch generated — use it when the agent
        or its domain changed.

        voice=True additionally voices every scenario in the prepared
        dataset (an LLM authors each script, then a takes=1 render) —
        explicit opt-in because it spends per row; the handles come back
        still-running on PrepareResult.voice_renders. Accounts with
        voice.auto don't need this: their rollouts voice themselves.
        """
        result = self._prepare(agent, count=count, max_turns=max_turns,
                               min_success_rate=min_success_rate,
                               max_success_rate=max_success_rate,
                               reprobe=reprobe, verbose=verbose)
        if voice:
            for row in result.dataset.download():
                result.voice_renders.append(
                    self.voice_render(scenario_id=row["scenario_id"],
                                      takes=1))
        return result

    def run(self, agent: RolloutAgent, *, count: int = 100,
            dataset: Union[Dataset, str, None] = None,
            probe_agent: Agent | None = None,
            reprobe: bool = False,
            max_turns: int = 12, probe_max_turns: int = 10,
            concurrency: int = 4, repeats: int = 1,
            min_success_rate: float = 0.6, max_success_rate: float = 0.9,
            label: str | None = None, agent_meta: dict | None = None,
            verbose: bool = False) -> EvalOutcome:
        """The whole evaluation in one call: prepare (probe + generate, or
        reuse) -> roll out every scenario against `agent` -> judge the
        rollouts -> return the judged results. The script-path equivalent
        of `synthia run`, minus the CI gating: thresholds and exit codes
        stay yours.

        `probe_agent` overrides the probing default, which drives `agent`
        itself: each probe question becomes a one-turn conversation and
        the sandbox calls it makes are traced onto the reply. Passing
        `dataset` (id or Dataset) skips prepare entirely. `reprobe=True`
        forces the full refresh — re-interview the agent, re-distill its
        context, generate a fresh batch — for when the agent changed.
        """
        prepare = None
        if dataset is not None:
            target = (self.datasets.get(dataset)
                      if isinstance(dataset, str) else dataset)
        else:
            prepare = self.prepare(
                probe_agent or _probe_from_rollout(agent),
                count=count, max_turns=probe_max_turns,
                min_success_rate=min_success_rate,
                max_success_rate=max_success_rate, reprobe=reprobe,
                verbose=verbose)
            target = prepare.dataset
        results: list[RolloutResult] = []
        for _ in range(repeats):
            results.extend(self.rollouts.run(
                agent, target, max_turns=max_turns,
                concurrency=concurrency, agent_meta=agent_meta))
        # The server bounds one quality check's LLM fan-out at 50 rollouts;
        # bigger runs judge in chunks and pool the evaluations. The outcome
        # carries the last check; every chunk lands on the platform.
        chunks = [results[i:i + _QUALITY_CHECK_CHUNK]
                  for i in range(0, len(results), _QUALITY_CHECK_CHUNK)]
        evaluations: list[dict] = []
        quality_check = None
        for part, chunk in enumerate(chunks, start=1):
            chunk_label = (f"{label} {part}/{len(chunks)}"
                           if label and len(chunks) > 1 else label)
            quality_check = self.rollouts.quality_check(chunk, chunk_label)
            quality_check.wait(verbose=verbose)
            evaluations.extend(quality_check.rollouts())
        passed = sum(1 for e in evaluations if e.get("passed"))
        return EvalOutcome(
            prepare=prepare, dataset=target, results=results,
            quality_check=quality_check, evaluations=evaluations,
            pass_rate=(passed / len(evaluations)) if evaluations else None)

    def _prepare(self, agent: Agent, *, count: int, max_turns: int,
                 min_success_rate: float, max_success_rate: float,
                 reprobe: bool = False, verbose: bool = False) -> PrepareResult:
        """Probe + generate only when needed; otherwise reuse the latest dataset.

        The main entry point for the probe and generation steps. `count` is
        exact: the returned dataset has exactly that many rows, so reuse
        requires the latest dataset to match it in addition to the quality
        gate. Probing and generation run only when no dataset exists yet,
        when the row count differs (generation-only — the session's probed
        user model is reused), or when the latest completed quality check's
        pass rate falls outside [min_success_rate, max_success_rate].
        Out-of-band regeneration passes that quality check to the server,
        which feeds its real results (pass rate, per-scenario outcomes,
        judge issues) into scenario generation so the new batch recalibrates
        difficulty and coverage.

        All lookups are scoped to this client's session: re-running the
        same script reuses its own dataset, and drift signals from other
        scripts/sessions never trigger regeneration here.
        """
        if reprobe:
            # Explicit refresh: the caller says the agent (or its domain)
            # changed. Skip every reuse check — new interview, new
            # context, fresh batch. quality_check_id stays None so the
            # probe actually re-runs (see _probe_and_generate).
            return self._probe_and_generate(
                agent, count=count, max_turns=max_turns, verbose=verbose,
                reason="reprobe requested", success_rate=None,
                quality_check_id=None, force_probe=True)
        existing = (self.datasets.list(session=self.session_id)
                    if self.session_id else self.datasets.list())  # newest first
        if not existing:
            return self._probe_and_generate(
                agent, count=count, max_turns=max_turns, verbose=verbose,
                reason=("no datasets in this session yet" if self.session_id
                        else "no datasets exist yet"),
                success_rate=None, quality_check_id=None)

        r = self._http.get(
            "/v1/quality-checks/latest",
            params={"sdk_session": self.session_id} if self.session_id else {})
        r.raise_for_status()
        latest = r.json()
        rate = (latest["passed"] / latest["total"]
                if latest["id"] is not None and latest["total"] > 0 else None)

        if rate is not None and not (min_success_rate <= rate <= max_success_rate):
            direction = ("below" if rate < min_success_rate else "above")
            bound = (min_success_rate if rate < min_success_rate
                     else max_success_rate)
            return self._probe_and_generate(
                agent, count=count, max_turns=max_turns, verbose=verbose,
                reason=f"success rate {rate:.0%} {direction} {bound:.0%}; "
                       f"regenerating calibrated on {latest['id']}",
                success_rate=rate, quality_check_id=latest["id"])

        # Quality is in band (or unjudged): reuse only on an exact size
        # match; otherwise regenerate at the requested count — without
        # re-probing, since nothing suggests the agent changed.
        if existing[0].row_count != count:
            return self._probe_and_generate(
                agent, count=count, max_turns=max_turns, verbose=verbose,
                reason=f"latest dataset has {existing[0].row_count} rows; "
                       f"requested {count}",
                success_rate=rate, quality_check_id=None)

        return PrepareResult(
            dataset=existing[0],
            user_model=self.user_models.get(existing[0].user_model_id),
            action="reused",
            reason=(f"success rate {rate:.0%} within "
                    f"{min_success_rate:.0%}-{max_success_rate:.0%} band"
                    if rate is not None else
                    "no completed quality check to judge by; "
                    "reusing latest dataset"),
            success_rate=rate, quality_check_id=None)

    def _probe_and_generate(self, agent: Agent, *, count: int, max_turns: int,
                            verbose: bool, reason: str,
                            success_rate: float | None,
                            quality_check_id: str | None,
                            force_probe: bool = False) -> PrepareResult:
        # Without a drift signal the agent hasn't been shown to change, so a
        # user model this session already probed is still good — skip the
        # probe. Drift-triggered regeneration and reprobe=True re-probe
        # deliberately.
        user_model = None
        if self.session_id and not quality_check_id and not force_probe:
            session_models = self.user_models.list(session=self.session_id)
            if session_models:
                user_model = session_models[-1]  # newest (list is oldest-first)
                reason += "; reusing session user model (no drift signal)"
        if user_model is None:
            user_model = self.user_models.create_from_probe(
                agent, max_turns=max_turns, verbose=verbose)
        job = self.datasets.generate(user_model, count=count,
                                     quality_check_id=quality_check_id)
        dataset = job.wait(verbose=verbose)
        return PrepareResult(dataset=dataset, user_model=user_model,
                             action="generated", reason=reason,
                             success_rate=success_rate,
                             quality_check_id=quality_check_id)
