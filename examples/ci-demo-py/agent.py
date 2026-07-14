"""Acme Metrics support agent (Python) — the `synthia run` CI fixture.

Mirrors examples/ci-demo/src/agent.ts: a Claude-backed SaaS-billing support
agent exporting `agent(transcript, sandbox) -> reply`, the callable
synthia.yaml points at. Tool calls route through the deterministic
ToolSandbox so the server can replay them.

`get_diagnostics` deliberately reports an output containing a fake sk-
credential — it exists to prove the CLI's redact-by-default scrubs tool
events before upload (the dryrun greps for it server-side).
"""

import json

from anthropic import Anthropic, beta_tool

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

anthropic = Anthropic()


def agent(transcript: list[dict], sandbox) -> str:
    @beta_tool
    def lookup_account(account_id: str) -> str:
        """Fetch an account: plan, seats, billing status, usage."""
        return json.dumps(sandbox.call("lookup_account",
                                       {"account_id": account_id}))

    @beta_tool
    def adjust_subscription(account_id: str, action: str) -> str:
        """Apply a plan change. action: 'upgrade', 'downgrade', 'cancel',
        'refund_last_charge'."""
        return json.dumps(sandbox.call(
            "adjust_subscription", {"account_id": account_id, "action": action}))

    @beta_tool
    def get_diagnostics(account_id: str) -> str:
        """Fetch internal diagnostics for an account (support-eyes only)."""
        output = {"account_id": account_id, "healthy": True,
                  "ingest_key": "sk-test00000000000000000000fake"}
        sandbox.report("get_diagnostics", output, input={"account_id": account_id})
        return json.dumps(output)

    # Haiku keeps this fixture cheap to run in CI — the demo is about the eval
    # flow, not the agent's smarts. Real customers pick their own model.
    runner = anthropic.beta.messages.tool_runner(
        model="claude-haiku-4-5",
        max_tokens=2048,
        system=SYSTEM,
        tools=[lookup_account, adjust_subscription, get_diagnostics],
        messages=[{"role": "user" if t["role"] == "user" else "assistant",
                   "content": t["content"]} for t in transcript],
    )
    final = runner.until_done()
    return "".join(b.text for b in final.content if b.type == "text")
