"""The `synthia` CLI: run agent evals from CI or the terminal.

Mirrors the JavaScript CLI (packages/sdk-js/src/cli) module-for-module so the
two stay in lockstep: same synthia.yaml schema, same results-JSON contract,
same exit codes (0 pass / 1 gate failed / 2 config error / 3 infra).
"""

from .cli import main

__all__ = ["main"]
