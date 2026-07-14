/**
 * Framework adapters: the small, dependency-free glue between Synthia's
 * RolloutAgent contract — (transcript, sandbox) => reply — and the chat/tool
 * shapes that agent frameworks expose (LangGraph, OpenAI Agents SDK, Vercel
 * AI SDK, plain chat handlers). Import from "synthiaresearch/adapters".
 *
 * Full per-framework recipes: docs/integrations/ in the Synthia repo.
 */
import type { RolloutAgent, ToolSandbox, TranscriptTurn } from "./client.js";

/** The universal chat-message shape every framework accepts. */
export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** Synthia transcript → chat messages (simulated user speaks as "user"). */
export function transcriptToMessages(
  transcript: TranscriptTurn[],
): ChatMessage[] {
  return transcript.map((t) => ({
    role: t.role === "user" ? "user" : "assistant",
    content: t.content,
  }));
}

/**
 * Wrap any chat-style handler as a RolloutAgent. The handler gets the
 * conversation in the universal shape plus the sandbox for tool calls:
 *
 *   export const agent = fromChatHandler(async (messages, sandbox) => {
 *     const result = await myFramework.invoke({ messages, tools: ... });
 *     return result.text;
 *   });
 */
export function fromChatHandler(
  handler: (
    messages: ChatMessage[],
    sandbox: ToolSandbox,
  ) => string | Promise<string>,
): RolloutAgent {
  return (transcript, sandbox) =>
    handler(transcriptToMessages(transcript), sandbox);
}

/**
 * Execute one sandbox tool call and return the JSON string most framework
 * tool executors expect. Deterministic and replayable server-side.
 */
export function callTool(
  sandbox: ToolSandbox,
  name: string,
  input: Record<string, unknown>,
): string {
  return JSON.stringify(sandbox.call(name, input));
}

/**
 * Build a name → executor map for frameworks that route tool calls by name
 * (LangGraph ToolNode, MCP-style dispatchers, hand-rolled loops):
 *
 *   const run = toolExecutors(sandbox, ["lookup_account", "adjust_subscription"]);
 *   const output = run.lookup_account({ account_id: "acc_1" });
 */
export function toolExecutors(
  sandbox: ToolSandbox,
  names: string[],
): Record<string, (input: Record<string, unknown>) => string> {
  return Object.fromEntries(
    names.map((name) => [
      name,
      (input: Record<string, unknown>) => callTool(sandbox, name, input),
    ]),
  );
}
