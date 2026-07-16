/**
 * Toy SaaS-billing support agent — the `synthia run` CI fixture.
 *
 * Exports the two Synthia-facing callables: `agent` (RolloutAgent — what
 * synthia.yaml's entrypoint loads) and `probe` (probe-style, used by the
 * one-time dataset bootstrap in scripts/bootstrap-dataset.ts). Both run the
 * same GPT-backed support agent; rollout tools route through the
 * deterministic ToolSandbox so the server can replay them.
 *
 * `get_diagnostics` deliberately reports an output containing a fake
 * sk- credential — it exists to prove the CLI's redact-by-default scrubs
 * tool events before upload (the dryrun greps for it server-side).
 */
import OpenAI from "openai";
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

const openai = new OpenAI();

const MAX_TOOL_ROUNDS = 8;

function sandboxTools(sandbox: ToolSandbox) {
  const tools: OpenAI.Responses.FunctionTool[] = [
    {
      type: "function",
      name: "lookup_account",
      description: "Fetch an account: plan, seats, billing status, usage.",
      strict: true,
      parameters: {
        type: "object",
        properties: { account_id: { type: "string", description: "Account id or owner email" } },
        required: ["account_id"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "adjust_subscription",
      description:
        "Apply a plan change. action: 'upgrade', 'downgrade', 'cancel', 'refund_last_charge'.",
      strict: true,
      parameters: {
        type: "object",
        properties: {
          account_id: { type: "string" },
          action: { type: "string", enum: ["upgrade", "downgrade", "cancel", "refund_last_charge"] },
        },
        required: ["account_id", "action"],
        additionalProperties: false,
      },
    },
    {
      type: "function",
      name: "get_diagnostics",
      description: "Fetch internal diagnostics for an account (support-eyes only).",
      strict: true,
      parameters: {
        type: "object",
        properties: { account_id: { type: "string" } },
        required: ["account_id"],
        additionalProperties: false,
      },
    },
  ];
  const run: Record<string, (input: Record<string, string>) => string> = {
    lookup_account: (input) => JSON.stringify(sandbox.call("lookup_account", input)),
    adjust_subscription: (input) => JSON.stringify(sandbox.call("adjust_subscription", input)),
    get_diagnostics: (input) => {
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
  };
  return { tools, run };
}

async function respond(
  messages: { role: "user" | "assistant"; content: string }[],
  sandbox: ToolSandbox,
): Promise<string> {
  const { tools, run } = sandboxTools(sandbox);
  const input: OpenAI.Responses.ResponseInput = [...messages];
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await openai.responses.create({
      model: "gpt-5.6-luna",
      max_output_tokens: 2048,
      instructions: SYSTEM,
      tools,
      input,
    });
    const calls = response.output.filter(
      (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call",
    );
    if (calls.length === 0) return response.output_text;
    input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));
    for (const call of calls) {
      input.push({
        type: "function_call_output",
        call_id: call.call_id,
        output: run[call.name]?.(JSON.parse(call.arguments || "{}")) ?? "unknown tool",
      });
    }
  }
  return "";
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
