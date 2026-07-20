import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

import type { components } from "./generated/api.js";

/** Server payload shape for a schema in the OpenAPI contract. */
type Api<K extends keyof components["schemas"]> = components["schemas"][K];

// Server payload shapes, re-exported under SDK-facing names. Shapes whose
// name is taken by a hand-written interface (the local sandbox surface) get
// an `Api` prefix.
export type Seed = Api<"Seed">;
export type DatasetRow = Api<"DatasetRow">;
export type ScenarioValidation = Api<"ScenarioValidation">;
export type RolloutEvaluation = Api<"RolloutEvaluation">;
export type ApiRollout = Api<"Rollout">;
export type ApiToolCall = Api<"ToolCall">;

export const DEFAULT_BASE_URL =
  "https://synthia-research--synthia-api-web.modal.run";

const SDK_VERSION = "0.1.0"; // keep in lockstep with package.json
// The server rejects quality checks over more rollouts than this
// (MAX_QUALITY_ROLLOUTS); run() judges bigger result sets in chunks.
const QUALITY_CHECK_CHUNK = 500;

// File suffixes recognized where inputs are overloaded (seeds.ingest
// content, rollout agent replies): a string ending in one of these is read
// as a file path and uploaded; any other string is a text reply/content.
// The server sniffs the actual type — audio (in any of these containers)
// engages voice mode; images and documents are rendered to text.
const FILE_SUFFIXES = new Set([
  ".wav", ".mp3", ".m4a", ".ogg", ".flac", ".webm", ".aac", ".aiff",
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".pdf", ".docx", ".pptx", ".xlsx",
]);

/** File input for overloaded surfaces: raw bytes or a path to a file. */
export type FileInput = Uint8Array | string;

/**
 * {file_b64, filename} when `value` is a file — raw bytes, or a string path
 * ending in a recognized suffix — else null. The runtime half of the input
 * overloads; the server sniffs the type, filename is only a hint.
 */
function asFileUpload(
  value: unknown,
): { file_b64: string; filename: string | null } | null {
  if (value instanceof Uint8Array) {
    return { file_b64: Buffer.from(value).toString("base64"), filename: null };
  }
  if (typeof value === "string" && FILE_SUFFIXES.has(extname(value).toLowerCase())) {
    return {
      file_b64: readFileSync(value).toString("base64"),
      filename: basename(value),
    };
  }
  return null;
}

// Launcher argv[1] stems that don't identify a script (REPLs, runners).
const INTERACTIVE_STEMS = new Set(["", "node", "npx", "tsx", "ts-node"]);

/**
 * Stable session name derived from the entry-point script.
 *
 * Last two path components only ("project/script"): readable, survives
 * moving the project, and never leaks the full directory layout. Falls
 * back to the working directory's name for REPLs.
 */
function defaultSessionName(): string {
  const argv1 = process.argv[1] ?? "";
  const stem = argv1 ? basename(argv1, extname(argv1)) : "";
  if (!argv1 || INTERACTIVE_STEMS.has(stem)) return basename(process.cwd());
  const p = resolve(argv1);
  return `${basename(dirname(p))}/${stem}`;
}

/**
 * JSON serialization matching Python's json.dumps(v, sort_keys=True):
 * sorted keys, ", "/": " separators, non-ASCII escaped. Required so
 * ToolSandbox hashes agree with the server. Caveat: JS has one number
 * type, so Python's 1 vs 1.0 distinction cannot be reproduced here.
 */
function pyJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return pyString(v);
  if (Array.isArray(v)) return "[" + v.map(pyJson).join(", ") + "]";
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" + keys.map((k) => `${pyString(k)}: ${pyJson(obj[k])}`).join(", ") + "}"
  );
}

function pyString(s: string): string {
  return JSON.stringify(s).replace(
    /[\u0080-\uffff]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** One traced tool invocation made by the agent while answering a probe. */
export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  is_error?: boolean;
}

/** An agent's reply plus the tool calls it made producing it. */
export interface AgentReply {
  reply: string;
  tool_calls?: ToolCall[];
}

// An agent takes a probe question and returns its reply — a plain string,
// or an AgentReply carrying traced tool calls.
export type Agent = (
  probe: string,
) => string | AgentReply | Promise<string | AgentReply>;

export interface SandboxConfig {
  seed: number;
  fail_tools: string[];
  state: Record<string, unknown>;
}

export interface ToolEvent {
  name: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  is_error: boolean;
  /** True when the agent ran this call against its own environment (see report()). */
  external?: boolean;
}

/**
 * Local replica of the server's deterministic tool sandbox.
 *
 * Must stay hash-identical to synthia_api.pipeline.rollout.ToolSandbox:
 * outputs are a pure function of (tool name, input, state version, seed),
 * which is how the server reproduces the same tool behavior from the
 * events the SDK reports. Tool inputs must be JSON-native values that
 * round-trip exactly.
 */
export class ToolSandbox {
  seed: number;
  failTools: Set<string>;
  state: Record<string, unknown>;
  events: ToolEvent[] = [];
  /**
   * Per-rollout scratch space for YOUR agent's state (stores, clients,
   * framework sessions): created fresh for every rollout and dies with it.
   * `sandbox.context.world ??= makeWorld()` — never key external maps by
   * anything derived from the sandbox's identity.
   */
  context: Record<string, unknown> = {};

  constructor(
    seed: number,
    failTools?: Set<string>,
    state?: Record<string, unknown>,
  ) {
    this.seed = seed;
    this.failTools = failTools ?? new Set();
    this.state = { ...(state ?? {}) };
  }

  static fromConfig(config: SandboxConfig): ToolSandbox {
    return new ToolSandbox(
      config.seed,
      new Set(config.fail_tools),
      config.state,
    );
  }

  /**
   * Record a tool call the agent made against its OWN environment. The
   * server persists the reported output verbatim, so quality checks can
   * judge whether the agent's claims were grounded in what its tools
   * actually returned.
   */
  report(
    name: string,
    output: Record<string, unknown>,
    opts: { input?: Record<string, unknown>; isError?: boolean } = {},
  ): void {
    this.events.push({
      name,
      input: opts.input ?? {},
      output,
      is_error: opts.isError ?? false,
      external: true,
    });
  }

  /**
   * BYOE adversity: true exactly once for a tool this scenario plants a
   * first-call fault on. Fail your real tool (return an error to your
   * agent) and report(..., {isError: true}), so the scenario's adversity
   * actually reaches an agent running its own environment.
   */
  shouldFail(name: string): boolean {
    if (this.failTools.has(name)) {
      this.failTools.delete(name);
      return true;
    }
    return false;
  }

  call(
    name: string,
    toolInput: Record<string, unknown>,
  ): Record<string, unknown> {
    const isError = this.failTools.has(name);
    let output: Record<string, unknown>;
    if (isError) {
      // fail once, like the server: the retry must succeed
      this.failTools.delete(name);
      output = { error: `${name} is unavailable` };
    } else {
      const version = (this.state["version"] as number | undefined) ?? 0;
      const digest = createHash("sha256")
        .update(pyJson([name, toolInput, version, this.seed]))
        .digest("hex")
        .slice(0, 8);
      output = { ok: true, result_id: digest };
      this.state["version"] = version + 1;
      this.state[`last_${name}`] = digest;
    }
    this.events.push({ name, input: toolInput, output, is_error: isError });
    return output;
  }
}

export interface TranscriptTurn {
  role: string;
  content: string;
  /** Set on turns that carry audio (every simulated-user turn of a
   * voice-mode rollout, and agent turns that replied with audio); fetch
   * via Rollouts.turnAudio. */
  audio_url?: string | null;
}

// A rollout agent takes the conversation transcript and a ToolSandbox for
// its tool calls, and returns its reply — text, or a file (bytes / a path).
// Audio replies flip the rollout into voice mode (the server talks back in
// audio); image/document replies are rendered to text. Either way the
// server-extracted text drives the simulator. Scenarios may run
// concurrently, so it must not share mutable state across invocations.
export type RolloutAgent = (
  transcript: TranscriptTurn[],
  sandbox: ToolSandbox,
) => string | FileInput | Promise<string | FileInput>;

class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    method: string,
    path: string,
  ) {
    super(`${method} ${path} failed with ${status}: ${body}`);
  }
}

class Http {
  headers: Record<string, string>;
  /** Gate awaited before every request; Synthia points it at the session
   * handshake so all later requests carry the session headers. */
  ready: Promise<void> = Promise.resolve();

  constructor(
    private baseUrl: string,
    headers: Record<string, string>,
  ) {
    this.headers = headers;
  }

  async get<T = unknown>(
    path: string,
    params?: Record<string, string | number>,
  ): Promise<T> {
    await this.ready;
    const r = await this.raw("GET", path, undefined, params);
    if (!r.ok) throw new HttpError(r.status, await r.text(), "GET", path);
    return r.json() as Promise<T>;
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    await this.ready;
    const r = await this.raw("POST", path, body);
    if (!r.ok) throw new HttpError(r.status, await r.text(), "POST", path);
    return r.json() as Promise<T>;
  }

  /** Binary GET (audio artifacts). */
  async getBytes(path: string): Promise<Uint8Array> {
    await this.ready;
    const r = await this.raw("GET", path);
    if (!r.ok) throw new HttpError(r.status, await r.text(), "GET", path);
    return new Uint8Array(await r.arrayBuffer());
  }

  /** Un-gated request returning the raw Response (used by the handshake). */
  async raw(
    method: string,
    path: string,
    body?: unknown,
    params?: Record<string, string | number>,
  ): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params ?? {})) {
      url.searchParams.set(k, String(v));
    }
    const sendTo = (target: string | URL) =>
      fetch(target, {
        method,
        headers: { "content-type": "application/json", ...this.headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        // Generous timeout: probe convergence runs model inference server-side.
        signal: AbortSignal.timeout(300_000),
        // Manual: fetch would auto-follow a 303 as a GET, silently breaking
        // POST semantics. Modal serves 303 attempt-token redirects while a
        // deployment hands requests between containers; the token resumes
        // the SAME attempt, so re-issuing the original method+body is safe —
        // including turn-advance POSTs, which may be resumed, never retried.
        redirect: "manual",
      });
    const send = async () => {
      let r = await sendTo(url);
      for (let hop = 0; hop < 30 && r.status === 303; hop++) {
        const location = r.headers.get("location") ?? "";
        if (!location.includes("__modal_attempt_token")) break;
        // Async-poll pattern: GET awaits the already-accepted request's
        // result; re-POSTing the body is rejected with a 400.
        r = await fetch(location, {
          method: "GET",
          headers: this.headers,
          signal: AbortSignal.timeout(300_000),
          redirect: "manual",
        });
      }
      return r;
    };

    // A minutes-long CI run is many round trips against serverless infra that
    // can transiently blip — undici "fetch failed" (ETIMEDOUT/ECONNRESET) or a
    // 5xx from a cold DB. One blip shouldn't fail the whole run. Retry only
    // where a duplicate is harmless: GETs, and create-style POSTs whose caller
    // uses the returned id (an orphaned rollout/quality check is wasteful, not
    // wrong). Turn-advance POSTs are NOT retried — a re-sent reply could
    // double-advance the server transcript; that needs server-side turn-index
    // idempotency (see the CI plan doc).
    const retryable = method === "GET" || isCreatePost(method, path);
    const maxAttempts = retryable ? 4 : 1;
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const r = await send();
        if (retryable && RETRYABLE_STATUS.has(r.status) && attempt < maxAttempts - 1) {
          await sleep(backoff(attempt));
          continue;
        }
        return r;
      } catch (e) {
        if (!isNetworkError(e)) throw e; // non-network (e.g. abort) — surface it
        lastErr = e;
        if (attempt < maxAttempts - 1) await sleep(backoff(attempt));
      }
    }
    throw lastErr;
  }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Transient server statuses worth retrying (cold DB, overload, gateway).
const RETRYABLE_STATUS = new Set([500, 502, 503, 504, 429, 529]);
// Backoff with jitter: 0.5s, 1s, 2s (+ up to 250ms).
const backoff = (attempt: number) =>
  500 * 2 ** attempt + Math.floor(Math.random() * 250);

/** A fetch() rejection means no HTTP response arrived (undici "fetch failed"
 * wrapping ETIMEDOUT/ECONNRESET/…). HTTP error *statuses* are a resolved
 * Response, not a throw, so they don't land here. */
function isNetworkError(e: unknown): boolean {
  return e instanceof TypeError || (e instanceof Error && e.name === "TypeError");
}

/** Create-style POSTs where a retried duplicate is harmless because the
 * caller keys off the returned id: the session handshake, rollout start, and
 * quality-check start. Explicitly excludes turn-advance POSTs
 * (/v1/rollouts/{id}/turns), which must not be replayed. */
function isCreatePost(method: string, path: string): boolean {
  if (method !== "POST") return false;
  return (
    path === "/v1/sdk-sessions" ||
    path === "/v1/rollouts" ||
    path === "/v1/quality-checks"
  );
}

/** Cursor-based poller that prints a run's server-side telemetry. */
class EventStream {
  #after = 0;

  constructor(
    private http: Http,
    private path: string,
    private enabled: boolean,
  ) {}

  async pump(): Promise<void> {
    if (!this.enabled) return;
    const body = await this.http.get<Api<"EventList">>(this.path, {
      after: this.#after,
    });
    for (const event of body.data) {
      this.#after = event.seq;
      const detail = Object.entries(event.data)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      console.log(
        `    ~ [${event.stage}] ${event.message}` +
          (detail ? `  (${detail})` : ""),
      );
    }
  }
}

export interface UserModel {
  id: string;
  probe_session_id: string;
  persona: string;
  traits: string[];
  representation_id: string | null;
}

export interface WaitOptions {
  pollInterval?: number; // seconds
  timeout?: number; // seconds
  verbose?: boolean;
}

/**
 * A validation of a dataset: a per-scenario judge gate plus collective
 * fidelity/diversity reports and an advisory verdict.
 */
export class ValidationRun {
  id: string;
  dataset_id: string;
  status: string;
  verdict: string | null;
  reference: Record<string, unknown> | null;
  validity: Record<string, unknown> | null;
  fidelity: Record<string, unknown> | null;
  diversity: Record<string, unknown> | null;
  error: string | null;
  #http: Http;

  label: string | null;

  constructor(data: Api<"ValidationRun">, http: Http) {
    this.id = data.id;
    this.dataset_id = data.dataset_id;
    this.status = data.status;
    this.label = data.label ?? null;
    this.verdict = data.verdict ?? null;
    this.reference = data.reference ?? null;
    this.validity = data.validity ?? null;
    this.fidelity = data.fidelity ?? null;
    this.diversity = data.diversity ?? null;
    this.error = data.error ?? null;
    this.#http = http;
  }

  /** Poll until validation finishes; verbose prints server telemetry. */
  async wait(opts: WaitOptions = {}): Promise<ValidationRun> {
    const { pollInterval = 2, timeout = 1800, verbose = false } = opts;
    const events = new EventStream(
      this.#http,
      `/v1/validation-runs/${this.id}/events`,
      verbose,
    );
    const deadline = Date.now() + timeout * 1000;
    while (this.status === "running") {
      if (Date.now() > deadline) {
        throw new Error(
          `validation run ${this.id} still running after ${timeout}s`,
        );
      }
      await sleep(pollInterval * 1000);
      const data = await this.#http.get<Api<"ValidationRun">>(
        `/v1/validation-runs/${this.id}`,
      );
      this.status = data.status;
      this.verdict = data.verdict ?? null;
      this.reference = data.reference ?? null;
      this.validity = data.validity ?? null;
      this.fidelity = data.fidelity ?? null;
      this.diversity = data.diversity ?? null;
      this.error = data.error ?? null;
      await events.pump();
    }
    await events.pump(); // catch events written after the final status poll
    if (this.status !== "succeeded") {
      throw new Error(`validation run ${this.id} failed: ${this.error}`);
    }
    return this;
  }

  /** Per-scenario judge verdicts: scenario_id, passed, judge. */
  async scenarios(): Promise<ScenarioValidation[]> {
    const body = await this.#http.get<Api<"ScenarioValidationList">>(
      `/v1/validation-runs/${this.id}/scenarios`,
    );
    return body.data;
  }
}

export class Dataset {
  id: string;
  generation_id: string;
  user_model_id: string;
  row_count: number;
  #http: Http;

  constructor(data: Api<"Dataset">, http: Http) {
    this.id = data.id;
    this.generation_id = data.generation_id;
    this.user_model_id = data.user_model_id;
    this.row_count = data.row_count;
    this.#http = http;
  }

  async download(): Promise<DatasetRow[]> {
    const body = await this.#http.get<Api<"DatasetRows">>(
      `/v1/datasets/${this.id}/rows`,
    );
    return body.data;
  }

  /**
   * Start an async validation run over this dataset. `label` is a human
   * name shown on the platform's Runs page.
   */
  async validate(label?: string): Promise<ValidationRun> {
    const data = await this.#http.post<Api<"ValidationRun">>(
      `/v1/datasets/${this.id}/validations`,
      label ? { label } : undefined,
    );
    return new ValidationRun(data, this.#http);
  }

  /** Play this dataset's scenarios against a local agent. */
  async rollout(
    agent: RolloutAgent,
    opts: RunOptions = {},
  ): Promise<RolloutResult[]> {
    return new Rollouts(this.#http).run(agent, this, opts);
  }
}

export class GenerationJob {
  id: string;
  status: string;
  user_model_id: string;
  count: number;
  dataset_id: string | null;
  error: string | null;
  #http: Http;

  constructor(data: Api<"GenerationJob">, http: Http) {
    this.id = data.id;
    this.status = data.status;
    this.user_model_id = data.user_model_id;
    this.count = data.count;
    this.dataset_id = data.dataset_id ?? null;
    this.error = data.error ?? null;
    this.#http = http;
  }

  /** Poll until the job finishes; verbose prints server telemetry live. */
  async wait(opts: WaitOptions = {}): Promise<Dataset> {
    const { pollInterval = 2, timeout = 1800, verbose = false } = opts;
    const events = new EventStream(
      this.#http,
      `/v1/generations/${this.id}/events`,
      verbose,
    );
    const deadline = Date.now() + timeout * 1000;
    while (this.status === "running") {
      if (Date.now() > deadline) {
        throw new Error(
          `generation ${this.id} still running after ${timeout}s`,
        );
      }
      await sleep(pollInterval * 1000);
      const data = await this.#http.get<Api<"GenerationJob">>(
        `/v1/generations/${this.id}`,
      );
      this.status = data.status;
      this.dataset_id = data.dataset_id ?? null;
      this.error = data.error ?? null;
      await events.pump();
    }
    await events.pump(); // catch events written after the final status poll
    if (this.status !== "succeeded") {
      throw new Error(`generation ${this.id} failed: ${this.error}`);
    }
    const data = await this.#http.get<Api<"Dataset">>(
      `/v1/datasets/${this.dataset_id}`,
    );
    return new Dataset(data, this.#http);
  }
}

export class Seeds {
  #http: Http;

  constructor(http: Http) {
    this.#http = http;
  }

  /**
   * Upload seed material (documents, tool schemas, policies, traces...).
   *
   * Overloaded on `content`: an object is ingested as-is (text pipeline);
   * raw bytes or a path to a file (audio in any common container, an
   * image, a PDF/Office document, plain text) is uploaded and handled
   * server-side with zero parameters — audio is transcribed (and marks
   * the seed voice-origin: rollouts on scenarios built from it run in
   * voice mode), everything else is rendered to text.
   */
  async ingest(opts: {
    kind: string;
    source: string;
    content: Record<string, unknown> | FileInput;
    version?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Seed> {
    const upload = asFileUpload(opts.content);
    if (upload !== null) {
      return this.#http.post<Seed>("/v1/seeds", {
        kind: opts.kind,
        source: opts.source,
        file_b64: upload.file_b64,
        filename: upload.filename,
        version: opts.version ?? "1",
        metadata: opts.metadata ?? {},
      });
    }
    return this.#http.post<Seed>("/v1/seeds", {
      kind: opts.kind,
      source: opts.source,
      content: opts.content,
      version: opts.version ?? "1",
      metadata: opts.metadata ?? {},
    });
  }
}

export class UserModels {
  #http: Http;

  constructor(http: Http) {
    this.#http = http;
  }

  /**
   * Probe `agent` until the server converges on a user model.
   *
   * The agent runs locally; only probe questions, replies, and traced
   * tool calls travel over the wire. `verbose` prints the server's
   * telemetry (probe decisions, ingestion, inference) after each turn.
   */
  async createFromProbe(
    agent: Agent,
    opts: { maxTurns?: number; verbose?: boolean } = {},
  ): Promise<UserModel> {
    const { maxTurns = 10, verbose = false } = opts;
    let session = await this.#http.post<Api<"ProbeSession">>(
      "/v1/probe-sessions",
      { max_turns: maxTurns },
    );
    const events = new EventStream(
      this.#http,
      `/v1/probe-sessions/${session.id}/events`,
      verbose,
    );
    while (session.status === "active") {
      const raw = await agent(session.next_probe!);
      const reply = typeof raw === "string" ? raw : raw.reply;
      const toolCalls =
        typeof raw === "string"
          ? []
          : (raw.tool_calls ?? []).map((tc) => ({
              name: tc.name,
              input: tc.input,
              output: tc.output ?? null,
              is_error: tc.is_error ?? false,
            }));
      session = await this.#http.post<Api<"ProbeSession">>(
        `/v1/probe-sessions/${session.id}/responses`,
        { reply, tool_calls: toolCalls },
      );
      await events.pump();
    }
    return this.get(session.user_model_id!);
  }

  async get(modelId: string): Promise<UserModel> {
    return this.#http.get<UserModel>(`/v1/user-models/${modelId}`);
  }

  async list(session?: string): Promise<UserModel[]> {
    const params = session ? { sdk_session: session } : undefined;
    const body = await this.#http.get<Api<"UserModelList">>(
      "/v1/user-models",
      params,
    );
    return body.data.map((m) => ({
      ...m,
      representation_id: m.representation_id ?? null,
    }));
  }
}

export class Datasets {
  #http: Http;

  constructor(http: Http) {
    this.#http = http;
  }

  async get(datasetId: string): Promise<Dataset> {
    const data = await this.#http.get<Api<"Dataset">>(
      `/v1/datasets/${datasetId}`,
    );
    return new Dataset(data, this.#http);
  }

  /** Datasets newest first; `session` filters to one SDK session. */
  async list(session?: string): Promise<Dataset[]> {
    const params = session ? { sdk_session: session } : undefined;
    const body = await this.#http.get<Api<"DatasetList">>(
      "/v1/datasets",
      params,
    );
    return body.data.map((d) => new Dataset(d, this.#http));
  }

  /**
   * Start a generation job. qualityCheckId names a completed quality
   * check whose results calibrate the batch's difficulty and coverage.
   */
  async generate(
    userModel: UserModel | string,
    opts: { count?: number; qualityCheckId?: string } = {},
  ): Promise<GenerationJob> {
    const { count = 20, qualityCheckId } = opts;
    const modelId = typeof userModel === "string" ? userModel : userModel.id;
    const body: Record<string, unknown> = {
      user_model_id: modelId,
      count,
    };
    if (qualityCheckId) body["quality_check_id"] = qualityCheckId;
    const data = await this.#http.post<Api<"GenerationJob">>(
      "/v1/generations",
      body,
    );
    return new GenerationJob(data, this.#http);
  }
}

/**
 * Outcome of Synthia.prepare(): the dataset to roll out, the user model
 * behind it, and how the decision was made.
 */
export interface PrepareResult {
  dataset: Dataset;
  userModel: UserModel;
  action: "generated" | "reused";
  reason: string; // human-readable decision trail
  successRate: number | null; // latest completed check's rate, if any
  qualityCheckId: string | null; // check that calibrated generation, if any
}

/**
 * An async evaluation of finished rollouts: per rollout, the server
 * analyzes the agent's state trajectory and judges pass/fail. The
 * per-rollout results are the product; there is no aggregate verdict.
 */
export class QualityCheck {
  id: string;
  status: string;
  rollout_ids: string[];
  label: string | null;
  error: string | null;
  #http: Http;

  constructor(data: Api<"QualityCheck">, http: Http) {
    this.id = data.id;
    this.status = data.status;
    this.rollout_ids = data.rollout_ids;
    this.label = data.label ?? null;
    this.error = data.error ?? null;
    this.#http = http;
  }

  /** Poll until the check finishes; verbose prints server telemetry. */
  async wait(opts: WaitOptions = {}): Promise<QualityCheck> {
    const { pollInterval = 2, timeout = 1800, verbose = false } = opts;
    const events = new EventStream(
      this.#http,
      `/v1/quality-checks/${this.id}/events`,
      verbose,
    );
    const deadline = Date.now() + timeout * 1000;
    while (this.status === "running") {
      if (Date.now() > deadline) {
        throw new Error(
          `quality check ${this.id} still running after ${timeout}s`,
        );
      }
      await sleep(pollInterval * 1000);
      const data = await this.#http.get<Api<"QualityCheck">>(
        `/v1/quality-checks/${this.id}`,
      );
      this.status = data.status;
      this.error = data.error ?? null;
      await events.pump();
    }
    await events.pump(); // catch events written after the final status poll
    if (this.status !== "succeeded") {
      throw new Error(`quality check ${this.id} failed: ${this.error}`);
    }
    return this;
  }

  /**
   * Per-rollout results: rollout_id, passed, states (the agentic-state
   * trajectory), and judge (dimensions + issues).
   */
  async rollouts(): Promise<RolloutEvaluation[]> {
    const body = await this.#http.get<Api<"RolloutEvaluationList">>(
      `/v1/quality-checks/${this.id}/rollouts`,
    );
    return body.data;
  }
}

/**
 * Poll a server-attached voice render until it finishes, then download the
 * mixed conversation WAV. Voice-mode rollouts get their render created
 * server-side on completion — the SDK only fetches it.
 */
async function fetchRenderAudio(
  http: Http,
  renderId: string,
  opts: WaitOptions = {},
): Promise<Uint8Array> {
  const { pollInterval = 2, timeout = 1800 } = opts;
  const deadline = Date.now() + timeout * 1000;
  let render = await http.get<Api<"VoiceRender">>(
    `/v1/voice-renders/${renderId}`,
  );
  while (render.status === "running") {
    if (Date.now() > deadline) {
      throw new Error(`voice render ${renderId} still running after ${timeout}s`);
    }
    await sleep(pollInterval * 1000);
    render = await http.get<Api<"VoiceRender">>(`/v1/voice-renders/${renderId}`);
  }
  if (render.status !== "succeeded") {
    throw new Error(`voice render ${renderId} failed: ${render.error}`);
  }
  return http.getBytes(`/v1/voice-renders/${renderId}/audio`);
}

/**
 * One finished rollout: the conversation a scenario produced, plus every
 * tool call the agent made along the way (each tagged with its turn_idx).
 * voiced rollouts (the agent interacted through audio, or the scenario is
 * voice-origin) carry audio on every simulated-user turn and a
 * server-attached mixed render — call audio() for the WAV.
 */
export interface RolloutResult {
  rollout_id: string;
  scenario_id: string;
  status: string;
  turns: number;
  transcript: TranscriptTurn[];
  tool_events: ApiToolCall[];
  /** Voice mode: true when the rollout ran with voiced replies. */
  voiced: boolean;
  /** The server-attached mixed render's id (voiced rollouts). */
  voice_render_id?: string | null;
  /** Download the mixed conversation WAV (waits for the render). Present
   * only on voiced rollouts. */
  audio?: (opts?: WaitOptions) => Promise<Uint8Array>;
}

export interface RunOptions {
  maxTurns?: number;
  concurrency?: number;
  /**
   * Which agent is under test ({name, version, model, ...} — any JSON).
   * Pure telemetry, stored on every rollout; what lets the platform's
   * Runs page compare results across your agent's versions. Strongly
   * recommended.
   */
  agentMeta?: Record<string, unknown>;
}

export class Rollouts {
  #http: Http;
  #sessionId: string | null;

  constructor(http: Http, sessionId: string | null = null) {
    this.#http = http;
    this.#sessionId = sessionId;
  }

  /**
   * A stored rollout's full captured state: status, seed, transcript,
   * tool events, and sandbox.
   */
  async get(rolloutId: string): Promise<ApiRollout> {
    return this.#http.get<ApiRollout>(`/v1/rollouts/${rolloutId}`);
  }

  /** One turn's audio (turns with an audio_url only). */
  async turnAudio(rolloutId: string, idx: number): Promise<Uint8Array> {
    return this.#http.getBytes(`/v1/rollouts/${rolloutId}/turns/${idx}/audio`);
  }

  /**
   * Play a dataset's scenarios against `agent` (most recent dataset when
   * none is given).
   *
   * The agent runs locally: each turn it gets the transcript so far and
   * a deterministic ToolSandbox for its tool calls; only its reply and
   * tool events travel over the wire. Scenarios run with `concurrency`
   * in-flight at once (turns within one conversation are sequential) —
   * pass concurrency: 1 to run them strictly one at a time.
   */
  async run(
    agent: RolloutAgent,
    dataset: Dataset | string | null = null,
    opts: RunOptions = {},
  ): Promise<RolloutResult[]> {
    const { maxTurns = 12, concurrency = 4, agentMeta } = opts;
    let datasetId: string;
    if (dataset === null) {
      // Session-scoped default: this script's latest dataset, so two
      // concurrent scripts never pick up each other's data.
      let data: Api<"Dataset">[] = [];
      if (this.#sessionId) {
        const body = await this.#http.get<Api<"DatasetList">>("/v1/datasets", {
          sdk_session: this.#sessionId,
        });
        data = body.data;
      }
      if (!data.length) {
        const body = await this.#http.get<Api<"DatasetList">>("/v1/datasets");
        data = body.data;
        if (data.length && this.#sessionId) {
          console.log(
            `note: no dataset in this session yet; ` +
              `using latest dataset ${data[0].id}`,
          );
        }
      }
      if (!data.length) {
        throw new Error("no datasets exist yet; generate one first");
      }
      datasetId = data[0].id;
    } else {
      datasetId = typeof dataset === "string" ? dataset : dataset.id;
    }
    const body = await this.#http.get<Api<"DatasetRows">>(
      `/v1/datasets/${datasetId}/rows`,
    );
    const rows = body.data;
    const results: RolloutResult[] = new Array(rows.length);
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const i = next++;
        results[i] = await this.runScenario(agent, rows[i].scenario_id, {
          maxTurns,
          randomSeed: rows[i].random_seed ?? undefined,
          agentMeta,
          datasetId,
        });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, rows.length) }, worker),
    );
    return results;
  }

  /**
   * Recover a turn post that failed transiently (a lost/timed-out connection,
   * or a retryable 5xx), without risking a double-advance. Re-fetch the
   * rollout: if its turn count moved past `priorTurn`, the write landed (only
   * the response was lost) — adopt that state. If it's unchanged and still
   * running, the write didn't land — it's safe to re-send once. A genuine 4xx
   * (409 already-completed, 422 bad file/turn) is rethrown unchanged.
   */
  async #recoverTurn(
    rolloutId: string,
    priorTurn: number,
    body: Record<string, unknown>,
    original: unknown,
  ): Promise<ApiRollout> {
    const transient =
      original instanceof TypeError ||
      (original instanceof HttpError && RETRYABLE_STATUS.has(original.status));
    if (!transient) throw original;
    let fetched: ApiRollout;
    try {
      fetched = await this.#http.get<ApiRollout>(`/v1/rollouts/${rolloutId}`); // retried
    } catch {
      throw original; // can't confirm state — surface the original failure
    }
    if (fetched.status !== "running" || fetched.turn > priorTurn) {
      return fetched; // the turn landed (or the rollout finished); continue
    }
    // The turn never reached the server — safe to send it again.
    return this.#http.post<ApiRollout>(`/v1/rollouts/${rolloutId}/turns`, body);
  }

  /**
   * Start an async quality check over finished rollouts: the server
   * analyzes each rollout's agentic states in parallel and judges
   * whether the agent passed each scenario.
   */
  async qualityCheck(
    rollouts: (RolloutResult | string)[],
    label?: string,
  ): Promise<QualityCheck> {
    const rolloutIds = rollouts.map((r) =>
      typeof r === "string" ? r : r.rollout_id,
    );
    const data = await this.#http.post<Api<"QualityCheck">>(
      "/v1/quality-checks",
      { rollout_ids: rolloutIds, label: label ?? null },
    );
    return new QualityCheck(data, this.#http);
  }

  /** Run one rollout session; one HTTP round-trip per agent turn. */
  async runScenario(
    agent: RolloutAgent,
    scenarioId: string,
    opts: {
      maxTurns?: number;
      randomSeed?: number;
      agentMeta?: Record<string, unknown>;
      datasetId?: string;
    } = {},
  ): Promise<RolloutResult> {
    const { maxTurns = 12, randomSeed = null, agentMeta, datasetId } = opts;
    let session = await this.#http.post<ApiRollout>("/v1/rollouts", {
      scenario_id: scenarioId,
      random_seed: randomSeed,
      max_turns: maxTurns,
      agent: agentMeta ?? null,
      dataset_id: datasetId ?? null,
    });
    // ONE sandbox object for the whole rollout: your agent's per-
    // conversation state lives on sandbox.context, so identity must be
    // stable across turns (a fresh object per turn silently amnesia-ed
    // every stateful agent). Server-mirrored fields refresh each turn.
    let sandbox: ToolSandbox | null = null;
    while (session.status === "running") {
      if (sandbox === null) {
        sandbox = ToolSandbox.fromConfig(session.sandbox);
      } else {
        sandbox.state = { ...session.sandbox.state };
        sandbox.failTools = new Set(session.sandbox.fail_tools);
        sandbox.events = [];
      }
      const reply = await agent(session.transcript, sandbox);
      const upload = asFileUpload(reply);
      const body: Record<string, unknown> = { tool_calls: sandbox.events };
      if (upload !== null) {
        // The agent replied with a file — the server sniffs it: audio is
        // transcribed and flips the rollout into voice mode; images and
        // documents are rendered to text. The extracted text drives the
        // simulator either way.
        body["reply"] = "";
        body["file_b64"] = upload.file_b64;
        body["filename"] = upload.filename;
      } else {
        body["reply"] = reply;
      }
      // Turn posts advance server transcript state, so a blind retry could
      // double-record the reply — the plain Http retry excludes them. Instead
      // recover explicitly: on a network failure, re-fetch the rollout and
      // only re-send if the turn didn't land (check-then-act idempotency).
      const priorTurn: number = session.turn;
      try {
        session = await this.#http.post<ApiRollout>(
          `/v1/rollouts/${session.id}/turns`,
          body,
        );
      } catch (e) {
        session = await this.#recoverTurn(session.id, priorTurn, body, e);
      }
    }
    const result: RolloutResult = {
      rollout_id: session.id,
      scenario_id: scenarioId,
      status: session.status,
      turns: session.turn,
      transcript: session.transcript,
      tool_events: session.tool_events,
      voiced: session.voiced ?? false,
      voice_render_id: session.voice_render_id ?? null,
    };
    const renderId = result.voice_render_id;
    if (renderId) {
      result.audio = (opts?: WaitOptions) =>
        fetchRenderAudio(this.#http, renderId, opts);
    }
    return result;
  }
}

// --- Production issue traces ------------------------------------------------

/** One real tool call from a production trace; external outputs are the
 * agent's own tools' real results (persisted verbatim server-side). */
export interface TraceToolEvent {
  name: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown> | null;
  is_error?: boolean;
  turn_idx?: number;
  external?: boolean;
}

/** A captured production trace: a conversation plus the real tool calls the
 * agent made — the same shape a rollout emits. Feed to traces.ingest() to
 * generate synthetic scenarios that reproduce a failure. */
export interface TraceInput {
  transcript: TranscriptTurn[];
  tool_events: TraceToolEvent[];
}

export interface TraceIngestOptions {
  /** Provenance label shown on the Issues page (e.g. "prod/zendesk"). */
  source: string;
  /** Optional operator hint describing the failure; sharpens extraction. */
  error?: string;
  /** Size of the generated dataset. */
  count?: number;
  /** Extra redactor composed after the built-in detectors, applied to every
   * transcript/tool string before the trace leaves this process. */
  redact?: (value: string) => string;
}

// Built-in structured-PII detectors. Client-side redaction is REQUIRED and
// runs before the trace leaves this process — raw PII never reaches the
// server or its LLM. Structured PII is caught deterministically here; the
// server re-scans as a backstop. Names/addresses need the `redact` hook.
// Order matters: card (13-19 digits) is matched before phone (9-15) so a card
// number isn't partially eaten and mislabeled as a phone.
const PII_DETECTORS: [RegExp, string][] = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<redacted:email>"],
  [/(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g, "<redacted:ssn>"],
  [/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g, "<redacted:card>"],
  [/(?<!\d)(?:\+?\d[\s.-]?){9,14}\d(?!\d)/g, "<redacted:phone>"],
  [
    /(?<!\d)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\d)/g,
    "<redacted:ip>",
  ],
];

// Tool inputs/outputs are structured JSON: a value under a sensitive key is
// masked wholesale (more reliable than free-text regex over JSON).
const SENSITIVE_KEY =
  /email|phone|ssn|dob|birth|address|name|card|account|token|secret|password/i;

function redactString(s: string, extra?: (v: string) => string): string {
  let out = s;
  for (const [re, repl] of PII_DETECTORS) out = out.replace(re, repl);
  return extra ? extra(out) : out;
}

function redactValue(
  value: unknown,
  extra?: (v: string) => string,
  keyHint?: string,
): unknown {
  if (typeof value === "string") {
    if (keyHint && SENSITIVE_KEY.test(keyHint)) return "<redacted>";
    return redactString(value, extra);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, extra));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, extra, k);
    }
    return out;
  }
  return value;
}

function redactTrace(
  trace: TraceInput,
  extra?: (v: string) => string,
): TraceInput {
  return {
    transcript: trace.transcript.map((t) => ({
      ...t,
      content: redactString(t.content, extra),
    })),
    tool_events: trace.tool_events.map((e) => ({
      ...e,
      input: redactValue(e.input, extra) as Record<string, unknown>,
      output:
        e.output == null
          ? e.output
          : (redactValue(e.output, extra) as Record<string, unknown>),
    })),
  };
}

/**
 * Detached trace recorder with report() ergonomics identical to ToolSandbox,
 * but not bound to any rollout — capture a production conversation as it
 * happens, then hand the recorder (or its .trace) to traces.ingest().
 */
export class TraceRecorder {
  #turns: TranscriptTurn[] = [];
  #events: TraceToolEvent[] = [];

  /** Append a user turn. */
  user(content: string): void {
    this.#turns.push({ role: "user", content });
  }

  /** Append an agent turn. */
  agent(content: string): void {
    this.#turns.push({ role: "agent", content });
  }

  /** Record a real tool call the agent made on the current turn. */
  report(
    name: string,
    output: Record<string, unknown>,
    opts: { input?: Record<string, unknown>; isError?: boolean } = {},
  ): void {
    this.#events.push({
      name,
      input: opts.input ?? {},
      output,
      is_error: opts.isError ?? false,
      external: true,
      turn_idx: Math.max(0, this.#turns.length - 1),
    });
  }

  /** The captured trace. */
  get trace(): TraceInput {
    return { transcript: this.#turns, tool_events: this.#events };
  }
}

export class Traces {
  #http: Http;

  constructor(http: Http) {
    this.#http = http;
  }

  /**
   * Ingest a production issue trace: redact it client-side (required, always
   * on), then distill it server-side into synthetic scenarios that reproduce
   * the failure. The raw trace is never persisted. Returns the generation
   * job — await its wait() for the dataset.
   */
  async ingest(
    trace: TraceInput | TraceRecorder,
    opts: TraceIngestOptions,
  ): Promise<GenerationJob> {
    const raw = trace instanceof TraceRecorder ? trace.trace : trace;
    const redacted = redactTrace(raw, opts.redact);
    const data = await this.#http.post<Api<"GenerationJob">>("/v1/traces", {
      transcript: redacted.transcript,
      tool_events: redacted.tool_events,
      source: opts.source,
      error: opts.error ?? null,
      count: opts.count ?? 20,
    });
    return new GenerationJob(data, this.#http);
  }
}

export interface SynthiaOptions {
  apiKey?: string;
  baseUrl?: string;
  session?: string | false;
  /** CI provenance for this process (commit sha, branch, ...), sent on the
   * session handshake and stamped onto every run this invocation creates.
   * Set by `synthia run`; reporting only. */
  ci?: Record<string, unknown>;
}

/** The customer config's CI policy, mirrored on the handshake:
 * floors/caps `synthia run` applies to its yaml config with a warning. */
export interface CiSettings {
  pass_rate_floor?: number | null;
  max_concurrency?: number | null;
  default_pass_rate?: number | null;
}

export interface PrepareOptions {
  count?: number;
  maxTurns?: number;
  minSuccessRate?: number;
  maxSuccessRate?: number;
  /** Force the full refresh: re-interview the agent, re-distill its
   * context, and generate a fresh batch — use when the agent or its
   * domain changed. Skips every reuse check. */
  reprobe?: boolean;
  verbose?: boolean;
}

export interface EvalOptions {
  /** Dataset size, passed to prepare(); ignored when `dataset` is given. */
  count?: number;
  /** Roll out this dataset (id or Dataset) instead of preparing one. */
  dataset?: Dataset | string;
  /** Probe agent for user-model creation. Defaults to driving `agent`
   * itself: each probe question becomes a one-turn conversation and the
   * sandbox calls it makes are traced onto the reply. */
  probeAgent?: Agent;
  /** Force the full refresh: re-interview the agent, re-distill its
   * context, and generate a fresh batch — use when the agent changed. */
  reprobe?: boolean;
  maxTurns?: number;
  /** Max probe turns during prepare(). */
  probeMaxTurns?: number;
  concurrency?: number;
  /** Roll the whole dataset out this many times (variance across runs). */
  repeats?: number;
  /** prepare()'s reuse band: outside it, the dataset regenerates
   * calibrated on the latest quality check. */
  minSuccessRate?: number;
  maxSuccessRate?: number;
  /** Human name for the run on the platform's Runs page. */
  label?: string;
  /** Which agent is under test ({name, version, model, ...} — any JSON).
   * Pure telemetry; strongly recommended. */
  agentMeta?: Record<string, unknown>;
  verbose?: boolean;
}

/** Outcome of Synthia.run(): everything each step produced, judged. */
export interface EvalOutcome {
  /** How the dataset was prepared; null when `dataset` was passed in. */
  prepare: PrepareResult | null;
  dataset: Dataset;
  results: RolloutResult[];
  qualityCheck: QualityCheck;
  /** Per-rollout judge rows: rollout_id, passed, states, judge. */
  evaluations: RolloutEvaluation[];
  /** Judged pass fraction across all rollouts; null when none judged. */
  passRate: number | null;
}

/** Drive a RolloutAgent with a probe question as a one-turn conversation,
 * tracing its sandbox calls onto the probe reply so probing still
 * observes tool usage. */
function probeFromRollout(agent: RolloutAgent): Agent {
  return async (probe: string) => {
    const sandbox = new ToolSandbox(0);
    const reply = await agent([{ role: "user", content: probe }], sandbox);
    if (typeof reply !== "string") {
      throw new Error(
        "probing needs a text reply — pass probeAgent for audio agents",
      );
    }
    return { reply, tool_calls: sandbox.events };
  };
}

/**
 * Client entry point.
 *
 * Session identity: every client belongs to a named session — the stable,
 * account-scoped identity of one script, persisted across executions
 * (same name resumes the same session; re-runs reuse its datasets instead
 * of re-probing/re-generating). Resolution order: `session` option >
 * SYNTHIA_SESSION env var > derived "project/script" name from the entry
 * point. `session: false` opts out into a fresh ephemeral session.
 *
 * Degradation: an old server without /v1/sdk-sessions -> no session;
 * keyless against a keyed server -> anonymous session; an invalid apiKey
 * fails on first use with the server's message.
 */
export class Synthia {
  sessionName: string;
  sessionId: string | null = null;
  invocationId: string | null = null;
  /** CI floors/caps mirrored from the customer config by the handshake;
   * null when the account has no CI policy. Populated after ready(). */
  ciSettings: CiSettings | null = null;
  seeds: Seeds;
  userModels: UserModels;
  datasets: Datasets;
  rollouts: Rollouts;
  traces: Traces;
  #http: Http;
  #ci: Record<string, unknown> | null;

  constructor(options: SynthiaOptions = {}) {
    const apiKey = options.apiKey ?? process.env["SYNTHIA_API_KEY"];
    const baseUrl =
      options.baseUrl ?? process.env["SYNTHIA_BASE_URL"] ?? DEFAULT_BASE_URL;
    const headers: Record<string, string> = apiKey
      ? { authorization: `Bearer ${apiKey}` }
      : {};
    this.#http = new Http(baseUrl, headers);
    if (options.session === false) {
      this.sessionName =
        `${defaultSessionName()}/eph-` +
        randomUUID().replace(/-/g, "").slice(0, 8);
    } else if (options.session) {
      this.sessionName = options.session;
    } else {
      this.sessionName =
        process.env["SYNTHIA_SESSION"] || defaultSessionName();
    }
    this.#ci = options.ci ?? null;
    // The handshake gates every later request, so all of them carry the
    // session headers without callers having to await anything up front.
    this.#http.ready = this.#startSession();
    this.seeds = new Seeds(this.#http);
    this.userModels = new UserModels(this.#http);
    this.datasets = new Datasets(this.#http);
    this.rollouts = new Rollouts(this.#http);
    this.traces = new Traces(this.#http);
  }

  /**
   * Await the session handshake. Every request already waits on it
   * implicitly; call this to fail fast on a bad key and to read the
   * handshake-mirrored fields (ciSettings) before acting.
   */
  async ready(): Promise<void> {
    await this.#http.ready;
  }

  /**
   * One handshake per process: get-or-create the named session and mint
   * this invocation; all later requests carry both ids as headers.
   */
  async #startSession(): Promise<void> {
    // The serverless backend can 500 on the first request after idling
    // (cold start), and the handshake is every process's first request —
    // retry briefly (which also warms the container for everything that
    // follows), then degrade to sessionless rather than failing over
    // optional tracking.
    let r: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        r = await this.#http.raw("POST", "/v1/sdk-sessions", {
          name: this.sessionName,
          sdk_version: SDK_VERSION,
          ...(this.#ci ? { ci: this.#ci } : {}),
        });
      } catch {
        r = null;
      }
      if (r && r.status < 500) break;
      if (attempt < 2) {
        await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      }
    }
    if (!r || r.status >= 500) {
      return; // transient trouble even after retries: run untracked
    }
    if (r.status === 404) return; // server predates sessions: degrade
    if (r.status === 401) {
      const detail = await r
        .json()
        .then((b) => (b as { detail?: string }).detail)
        .catch(() => null);
      throw new Error(detail ?? "invalid API key");
    }
    if (!r.ok) {
      throw new HttpError(r.status, await r.text(), "POST", "/v1/sdk-sessions");
    }
    const data = (await r.json()) as Api<"SdkSession">;
    this.sessionId = data.sdk_session_id;
    this.invocationId = data.sdk_invocation_id;
    this.ciSettings = data.ci ?? null;
    this.#http.headers["X-Synthia-Session"] = this.sessionId!;
    this.#http.headers["X-Synthia-Invocation"] = this.invocationId!;
    this.rollouts = new Rollouts(this.#http, this.sessionId);
  }

  /**
   * Probe + generate only when needed; otherwise reuse the latest dataset.
   *
   * The main entry point for the probe and generation steps. `count` is
   * exact: the returned dataset has exactly that many rows, so reuse
   * requires the latest dataset to match it in addition to the quality
   * gate. Probing and generation run only when no dataset exists yet,
   * when the row count differs (generation-only — the session's probed
   * user model is reused), or when the latest completed quality check's
   * pass rate falls outside [minSuccessRate, maxSuccessRate].
   * Out-of-band regeneration passes that quality check to the server,
   * which feeds its real results into scenario generation so the new
   * batch recalibrates difficulty and coverage.
   *
   * All lookups are scoped to this client's session: re-running the same
   * script reuses its own dataset, and drift signals from other
   * scripts/sessions never trigger regeneration here.
   */
  async prepare(agent: Agent, opts: PrepareOptions = {}): Promise<PrepareResult> {
    return this.#prepare(agent, opts);
  }

  /**
   * The whole evaluation in one call: prepare (probe + generate, or
   * reuse) → roll out every scenario against `agent` → judge the
   * rollouts → return the judged results. The script-path equivalent of
   * `synthia run`, minus the CI gating: thresholds, exit codes, and
   * report files stay yours.
   */
  async run(
    agent: RolloutAgent,
    opts: EvalOptions = {},
  ): Promise<EvalOutcome> {
    const {
      count = 100,
      dataset,
      probeAgent,
      reprobe = false,
      maxTurns = 12,
      probeMaxTurns = 10,
      concurrency = 4,
      repeats = 1,
      minSuccessRate = 0.6,
      maxSuccessRate = 0.9,
      label,
      agentMeta,
      verbose = false,
    } = opts;
    let prepare: PrepareResult | null = null;
    let target: Dataset;
    if (dataset !== undefined) {
      target =
        typeof dataset === "string"
          ? await this.datasets.get(dataset)
          : dataset;
    } else {
      prepare = await this.prepare(probeAgent ?? probeFromRollout(agent), {
        count,
        maxTurns: probeMaxTurns,
        minSuccessRate,
        maxSuccessRate,
        reprobe,
        verbose,
      });
      target = prepare.dataset;
    }
    const results: RolloutResult[] = [];
    for (let i = 0; i < repeats; i++) {
      results.push(
        ...(await this.rollouts.run(agent, target, {
          maxTurns,
          concurrency,
          agentMeta,
        })),
      );
    }
    // The server bounds one quality check's LLM fan-out (500 rollouts);
    // bigger runs judge in chunks and pool the evaluations. The outcome
    // carries the last check; every chunk lands on the platform.
    const chunks: RolloutResult[][] = [];
    for (let i = 0; i < results.length; i += QUALITY_CHECK_CHUNK)
      chunks.push(results.slice(i, i + QUALITY_CHECK_CHUNK));
    const evaluations: RolloutEvaluation[] = [];
    let qualityCheck!: QualityCheck;
    for (const [part, chunk] of chunks.entries()) {
      const chunkLabel =
        label && chunks.length > 1
          ? `${label} ${part + 1}/${chunks.length}`
          : label;
      qualityCheck = await this.rollouts.qualityCheck(chunk, chunkLabel);
      await qualityCheck.wait({ verbose });
      evaluations.push(...(await qualityCheck.rollouts()));
    }
    const passed = evaluations.filter((e) => e.passed).length;
    return {
      prepare,
      dataset: target,
      results,
      qualityCheck,
      evaluations,
      passRate: evaluations.length ? passed / evaluations.length : null,
    };
  }

  async #prepare(agent: Agent, opts: PrepareOptions): Promise<PrepareResult> {
    const {
      count = 100,
      maxTurns = 10,
      minSuccessRate = 0.6,
      maxSuccessRate = 0.9,
      reprobe = false,
      verbose = false,
    } = opts;
    await this.#http.ready;
    if (reprobe) {
      // Explicit refresh: the caller says the agent (or its domain)
      // changed. Skip every reuse check — new interview, new context,
      // fresh batch.
      return this.#probeAndGenerate(agent, {
        count,
        maxTurns,
        verbose,
        reason: "reprobe requested",
        successRate: null,
        qualityCheckId: null,
        forceProbe: true,
      });
    }
    const existing = await this.datasets.list(
      this.sessionId ?? undefined,
    ); // newest first
    if (!existing.length) {
      return this.#probeAndGenerate(agent, {
        count,
        maxTurns,
        verbose,
        reason: this.sessionId
          ? "no datasets in this session yet"
          : "no datasets exist yet",
        successRate: null,
        qualityCheckId: null,
      });
    }

    const latest = await this.#http.get<Api<"QualityCheckSummary">>(
      "/v1/quality-checks/latest",
      this.sessionId ? { sdk_session: this.sessionId } : undefined,
    );
    const rate =
      latest.id !== null && latest.total > 0
        ? latest.passed / latest.total
        : null;

    if (rate !== null && !(minSuccessRate <= rate && rate <= maxSuccessRate)) {
      const direction = rate < minSuccessRate ? "below" : "above";
      const bound = rate < minSuccessRate ? minSuccessRate : maxSuccessRate;
      return this.#probeAndGenerate(agent, {
        count,
        maxTurns,
        verbose,
        reason:
          `success rate ${pct(rate)} ${direction} ${pct(bound)}; ` +
          `regenerating calibrated on ${latest.id}`,
        successRate: rate,
        qualityCheckId: latest.id ?? null,
      });
    }

    // Quality is in band (or unjudged): reuse only on an exact size
    // match; otherwise regenerate at the requested count — without
    // re-probing, since nothing suggests the agent changed.
    if (existing[0]!.row_count !== count) {
      return this.#probeAndGenerate(agent, {
        count,
        maxTurns,
        verbose,
        reason:
          `latest dataset has ${existing[0]!.row_count} rows; ` +
          `requested ${count}`,
        successRate: rate,
        qualityCheckId: null,
      });
    }

    return {
      dataset: existing[0]!,
      userModel: await this.userModels.get(existing[0]!.user_model_id),
      action: "reused",
      reason:
        rate !== null
          ? `success rate ${pct(rate)} within ` +
            `${pct(minSuccessRate)}-${pct(maxSuccessRate)} band`
          : "no completed quality check to judge by; reusing latest dataset",
      successRate: rate,
      qualityCheckId: null,
    };
  }

  async #probeAndGenerate(
    agent: Agent,
    opts: {
      count: number;
      maxTurns: number;
      verbose: boolean;
      reason: string;
      successRate: number | null;
      qualityCheckId: string | null;
      forceProbe?: boolean;
    },
  ): Promise<PrepareResult> {
    // Without a drift signal the agent hasn't been shown to change, so a
    // user model this session already probed is still good — skip the
    // probe. Drift-triggered regeneration and reprobe re-probe
    // deliberately.
    let reason = opts.reason;
    let userModel: UserModel | null = null;
    if (this.sessionId && !opts.qualityCheckId && !opts.forceProbe) {
      const sessionModels = await this.userModels.list(this.sessionId);
      if (sessionModels.length) {
        userModel = sessionModels[sessionModels.length - 1]!; // newest last
        reason += "; reusing session user model (no drift signal)";
      }
    }
    if (userModel === null) {
      userModel = await this.userModels.createFromProbe(agent, {
        maxTurns: opts.maxTurns,
        verbose: opts.verbose,
      });
    }
    const job = await this.datasets.generate(userModel, {
      count: opts.count,
      qualityCheckId: opts.qualityCheckId ?? undefined,
    });
    const dataset = await job.wait({ verbose: opts.verbose });
    return {
      dataset,
      userModel,
      action: "generated",
      reason,
      successRate: opts.successRate,
      qualityCheckId: opts.qualityCheckId,
    };
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
