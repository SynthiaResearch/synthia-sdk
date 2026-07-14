"""Secret-shaped redaction — port of cli/redact.ts.

Scrubs secret-shaped strings from agent replies and tool events before
anything is uploaded. ON by default (telemetry.redact.enabled: false is the
explicit opt-out) because the customers who most need it won't configure it.
Risk reduction, not a guarantee — novel secret formats pass through.
"""

import re
import sys
from typing import Callable

# name -> compiled pattern. Kept identical to the JS builtin set.
_BUILTIN_PATTERNS: list[tuple[str, "re.Pattern[str]"]] = [
    ("api-key", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b")),        # OpenAI/Anthropic/Stripe
    ("github", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}\b")),
    ("github-pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b")),
    ("aws", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b")),
    ("slack", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("synthia", re.compile(r"\b(?:vox|synthia)_[A-Za-z0-9]{12,}\b")),  # our own prefixes
]


class Redactor:
    def __init__(self, extra: list[tuple[str, "re.Pattern[str]"]] | None = None):
        self._patterns = _BUILTIN_PATTERNS + list(extra or [])

    def scrub(self, text: str) -> str:
        out = text
        for name, pattern in self._patterns:
            out = pattern.sub(f"[REDACTED:{name}]", out)
        return out

    def scrub_json(self, value):
        """Recursively scrub every string in a JSON-shaped value (keys too)."""
        if isinstance(value, str):
            return self.scrub(value)
        if isinstance(value, list):
            return [self.scrub_json(v) for v in value]
        if isinstance(value, dict):
            return {self.scrub(k): self.scrub_json(v) for k, v in value.items()}
        return value


_warned_audio = False


def redacting_agent(agent: Callable, redactor: Redactor) -> Callable:
    """Wrap an agent so its reply and recorded tool events are scrubbed before
    run_scenario serializes them — the one seam where everything about to be
    uploaded is still local. Sandbox hashes are computed inside call() before
    this runs, so scrubbing the stored copies never breaks replay determinism;
    the server persists what we send."""

    def wrapped(transcript, sandbox):
        global _warned_audio
        reply = agent(transcript, sandbox)
        for event in sandbox.events:
            event["input"] = redactor.scrub_json(event.get("input"))
            event["output"] = redactor.scrub_json(event.get("output"))
        if not isinstance(reply, str):
            if not _warned_audio:
                _warned_audio = True
                print("warning: redaction does not apply to audio replies",
                      file=sys.stderr)
            return reply
        return redactor.scrub(reply)

    return wrapped
