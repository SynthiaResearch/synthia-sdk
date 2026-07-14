/**
 * Toy SaaS-billing support agent — the `synthia run` CI fixture.
 *
 * Exports the two Synthia-facing callables: `agent` (RolloutAgent — what
 * synthia.yaml's entrypoint loads) and `probe` (probe-style, used by the
 * one-time dataset bootstrap in scripts/bootstrap-dataset.ts). Both run the
 * same Claude-backed support agent; rollout tools route through the
 * deterministic ToolSandbox so the server can replay them.
 *
 * `get_diagnostics` deliberately reports an output containing a fake
 * sk- credential — it exists to prove the CLI's redact-by-default scrubs
 * tool events before upload (the dryrun greps for it server-side).
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaTool } from "@anthropic-ai/sdk/helpers/beta/json-schema";
import type { RolloutAgent, ToolSandbox, TranscriptTurn } from "synthiaresearch";

const SYSTEM = `You are the customer-support agent for Acme Metrics, a SaaS \
analytics platform with Starter ($29/mo), Pro ($99/mo), and Enterprise plans.

What you handle: billing questions (upgrades, downgrades, proration, refunds \
within 14 days of charge), account access issues (password resets, seat \
management, SSO on Enterprise), and usage/limits questions (events quota per \
plan, overage charges at $0.10 per 1k events).

Use your tools whenever a request involves a specific account — look the \
account up before making claims about it, and apply changes with real tool \
calls rather than describing them hypothetically.

Your limits: you can't issue refunds beyond the 14-day window, change \
another user's data, or give legal/tax advice. Suspected fraud goes to the \
trust team. Verify the account before any change.`;

const anthropic = new Anthropic();

function sandboxTools(sandbox: ToolSandbox) {
  return [
    betaTool({
      name: "lookup_account",
      description: "Fetch an account: plan, seats, billing status, usage.",
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "string", description: "Account id or owner email" } },
        required: ["account_id"],
        additionalProperties: false,
      } as const,
      run: (input: { account_id: string }) =>
        JSON.stringify(sandbox.call("lookup_account", input)),
    }),
    betaTool({
      name: "adjust_subscription",
      description:
        "Apply a plan change. action: 'upgrade', 'downgrade', 'cancel', 'refund_last_charge'.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          action: { type: "string", enum: ["upgrade", "downgrade", "cancel", "refund_last_charge"] },
        },
        required: ["account_id", "action"],
        additionalProperties: false,
      } as const,
      run: (input: { account_id: string; action: string }) =>
        JSON.stringify(sandbox.call("adjust_subscription", input)),
    }),
    betaTool({
      name: "get_diagnostics",
      description: "Fetch internal diagnostics for an account (support-eyes only).",
      inputSchema: {
        type: "object",
        properties: { account_id: { type: "string" } },
        required: ["account_id"],
        additionalProperties: false,
      } as const,
      run: (input: { account_id: string }) => {
        // A "real environment" tool: reported via sandbox.report, and its
        // output embeds a fake secret so CI can assert redaction works.
        const output = {
          account_id: input.account_id,
          healthy: true,
          ingest_key: "sk-test00000000000000000000fake",
        };
        sandbox.report("get_diagnostics", output, { input });
        return JSON.stringify(output);
      },
    }),
  ];
}

async function respond(
  messages: { role: "user" | "assistant"; content: string }[],
  sandbox: ToolSandbox,
): Promise<string> {
  const runner = anthropic.beta.messages.toolRunner({
    model: "claude-opus-4-8",
    max_tokens: 2048,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    tools: sandboxTools(sandbox),
    messages,
  });
  const final = await runner;
  return final.content
    .filter((b): b is { type: "text"; text: string } & typeof b => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/** RolloutAgent: transcript in, reply out — what synthia.yaml loads. */
export const agent: RolloutAgent = async (
  transcript: TranscriptTurn[],
  sandbox: ToolSandbox,
) =>
  respond(
    transcript.map((t) => ({
      role: t.role === "user" ? ("user" as const) : ("assistant" as const),
      content: t.content,
    })),
    sandbox,
  );

/** Probe-style agent for the one-time dataset bootstrap (prepare()). */
export async function probe(question: string): Promise<string> {
  const { ToolSandbox } = await import("synthiaresearch");
  return respond([{ role: "user", content: question }], new ToolSandbox(0));
}
