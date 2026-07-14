"""synthia — CI/terminal entry point for the synthiaresearch Python SDK.

  synthia run [--config synthia.yaml] [--dataset ds_…] [--output p]
              [--max-turns n] [--concurrency n] [--repeats n]
              [--timeout-minutes n] [--fail-on-threshold r] [--verbose]
  synthia validate [--config synthia.yaml]

Exit codes: 0 pass · 1 gate failed · 2 config/usage error · 3 infra/timeout.

ENV POLICY: reads exactly SYNTHIA_API_KEY (the only secret; no --api-key flag
by design), SYNTHIA_BASE_URL, and the named GITHUB_* context vars in
ci_context.py. Never iterates os.environ.
"""

import argparse
import os
import sys

from .agent_loader import load_agent
from .config import ConfigError, compile_extra_patterns, load_config
from .run import InfraError, RunFlags, run_command


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="synthia", add_help=True)
    sub = p.add_subparsers(dest="command")
    for name in ("run", "validate"):
        sp = sub.add_parser(name)
        sp.add_argument("--config", default=None)
        if name == "run":
            sp.add_argument("--dataset", default=None)
            sp.add_argument("--output", default=None)
            sp.add_argument("--max-turns", type=int, default=None)
            sp.add_argument("--concurrency", type=int, default=None)
            sp.add_argument("--repeats", type=int, default=None)
            sp.add_argument("--timeout-minutes", type=float, default=None)
            sp.add_argument("--fail-on-threshold", type=float, default=None)
            sp.add_argument("--warn-only", action="store_true")
            sp.add_argument("--session-suffix", default=None)
            sp.add_argument("--verbose", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        if args.command == "validate":
            config_path = os.path.abspath(args.config or "synthia.yaml")
            config = load_config(config_path)
            compile_extra_patterns(config.redact.patterns)
            load_agent(config.entrypoint, os.path.dirname(config_path))
            print(f"ok: {config_path} is valid and the agent entrypoint loads")
            return 0
        if args.command == "run":
            return run_command(RunFlags(
                config=args.config, dataset=args.dataset, output=args.output,
                max_turns=args.max_turns, concurrency=args.concurrency,
                repeats=args.repeats, timeout_minutes=args.timeout_minutes,
                fail_on_threshold=args.fail_on_threshold,
                warn_only=args.warn_only, session_suffix=args.session_suffix,
                verbose=args.verbose))
        _build_parser().print_help()
        return 2
    except ConfigError as e:
        print(f"config error: {e}", file=sys.stderr)
        return 2
    except InfraError as e:
        print(f"error: {e}", file=sys.stderr)
        return 3
    except KeyboardInterrupt:
        return 3


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
