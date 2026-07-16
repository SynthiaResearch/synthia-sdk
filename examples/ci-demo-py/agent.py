"""Acme Metrics support agent (Python) — the `synthia run` CI fixture.

Mirrors examples/ci-demo/src/agent.ts: a GPT-backed SaaS-billing support
agent exporting `agent(transcript, sandbox) -> reply`, the callable
synthia.yaml points at. Tool calls route through the deterministic
ToolSandbox so the server can replay them.

`get_diagnostics` deliberately reports an output containing a fake sk-
credential — it exists to prove the CLI's redact-by-default scrubs tool
events before upload (the dryrun greps for it server-side).
"""

import json

from openai import OpenAI

SYSTEM = """You are the customer-support agent for Acme Metrics, a SaaS \
analytics platform with Starter ($29/mo), Pro ($99/mo), and Enterprise plans.

What you handle: billing questions (upgrades, downgrades, proration, refunds \
within 14 days of charge), account access issues (password resets, seat \
management, SSO on Enterprise), and usage/limits questions (events quota per \
plan, overage charges at $0.10 per 1k events).

Use your tools whenever a request involves a specific account — look the \
account up before making claims about it, and apply changes with real tool \
calls rather than describing them hypothetically. Tool results may be opaque \
references (result ids): never invent field-level details a tool did not \
return, and if a lookup fails, say so and offer a fallback rather than \
guessing.

Your limits: you can't issue refunds beyond the 14-day window, change \
another user's data, or give legal/tax advice. Suspected fraud goes to the \
trust team. Verify the account before any change."""

openai = OpenAI()

MAX_TOOL_ROUNDS = 8


def _tool(name: str, description: str, params: dict[str, dict]) -> dict:
    return {"type": "function", "name": name, "description": description,
            "strict": True,
            "parameters": {"type": "object", "properties": params,
                           "required": list(params),
                           "additionalProperties": False}}


TOOLS = [
    _tool("lookup_account",
          "Fetch an account: plan, seats, billing status, usage.",
          {"account_id": {"type": "string"}}),
    _tool("adjust_subscription",
          "Apply a plan change. action: 'upgrade', 'downgrade', 'cancel', "
          "'refund_last_charge'.",
          {"account_id": {"type": "string"},
           "action": {"type": "string",
                      "enum": ["upgrade", "downgrade", "cancel",
                               "refund_last_charge"]}}),
    _tool("get_diagnostics",
          "Fetch internal diagnostics for an account (support-eyes only).",
          {"account_id": {"type": "string"}}),
]


def agent(transcript: list[dict], sandbox) -> str:
    def get_diagnostics(account_id: str) -> dict:
        output = {"account_id": account_id, "healthy": True,
                  "ingest_key": "sk-test00000000000000000000fake"}
        sandbox.report("get_diagnostics", output, input={"account_id": account_id})
        return output

    def run_tool(name: str, args: dict) -> dict:
        if name == "get_diagnostics":
            return get_diagnostics(**args)
        return sandbox.call(name, args)

    items = [{"role": "user" if t["role"] == "user" else "assistant",
              "content": t["content"]} for t in transcript]
    # gpt-5.6-luna keeps this fixture cheap to run in CI — the demo is about
    # the eval flow, not the agent's smarts. Real customers pick their own
    # model.
    for _ in range(MAX_TOOL_ROUNDS):
        response = openai.responses.create(
            model="gpt-5.6-luna",
            max_output_tokens=2048,
            instructions=SYSTEM,
            tools=TOOLS,
            input=items,
        )
        calls = [item for item in response.output
                 if item.type == "function_call"]
        if not calls:
            return response.output_text
        items.extend(response.output)
        for call in calls:
            output = run_tool(call.name, json.loads(call.arguments or "{}"))
            items.append({"type": "function_call_output",
                          "call_id": call.call_id,
                          "output": json.dumps(output)})
    return ""
