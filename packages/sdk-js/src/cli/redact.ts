import type { RolloutAgent, ToolEvent } from "../client.js";

/**
 * Secret-shaped patterns scrubbed from agent replies and tool events
 * before anything is uploaded. Redaction is ON by default (synthia.yaml
 * `telemetry.redact.enabled: false` is the explicit opt-out) because the
 * customers who most need it are the ones who won't configure it. This is
 * risk reduction, not a guarantee — novel secret formats pass through.
 */
const BUILTIN_PATTERNS: [name: string, re: RegExp][] = [
  ["api-key", /\bsk-[A-Za-z0-9_-]{16,}\b/g], // OpenAI/Anthropic/Stripe style
  ["github", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g],
  ["aws", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ["synthia", /\b(?:vox|synthia)_[A-Za-z0-9]{12,}\b/g], // our own prefixes
];

export class Redactor {
  #patterns: [string, RegExp][];

  /** `extra` must be pre-compiled (config validation owns the try/catch
   * so a bad pattern is a dotted-path config error, not a crash here). */
  constructor(extra: [string, RegExp][] = []) {
    this.#patterns = [...BUILTIN_PATTERNS, ...extra];
  }

  scrub(text: string): string {
    let out = text;
    for (const [name, re] of this.#patterns) {
      out = out.replace(re, `[REDACTED:${name}]`);
    }
    return out;
  }

  /** Recursively scrub every string in a JSON-shaped value (keys too). */
  scrubJson<T>(value: T): T {
    if (typeof value === "string") return this.scrub(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.scrubJson(v)) as T;
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[this.scrub(k)] = this.scrubJson(v);
      }
      return out as T;
    }
    return value;
  }
}

let warnedAudio = false;

/**
 * Wrap an agent so its reply and recorded tool events are scrubbed before
 * runScenario serializes them — the one seam where everything that will
 * be uploaded is still local. Sandbox hashes are computed inside call()
 * before this runs, so scrubbing the stored copies never breaks replay
 * determinism; the server persists what we send.
 */
export function redactingAgent(
  agent: RolloutAgent,
  redactor: Redactor,
): RolloutAgent {
  return async (transcript, sandbox) => {
    const reply = await agent(transcript, sandbox);
    for (const event of sandbox.events as ToolEvent[]) {
      event.input = redactor.scrubJson(event.input);
      event.output = redactor.scrubJson(event.output);
    }
    if (typeof reply !== "string") {
      if (!warnedAudio) {
        warnedAudio = true;
        console.warn("warning: redaction does not apply to audio replies");
      }
      return reply;
    }
    return redactor.scrub(reply);
  };
}
