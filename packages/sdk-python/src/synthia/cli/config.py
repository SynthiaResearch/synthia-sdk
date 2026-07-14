"""synthia.yaml loading, validation, and server-policy merge — port of
cli/config.ts. Same schema, same hard-fail-on-unknown-keys, same precedence:
server defaults < synthia.yaml < CLI flags, then admin caps/floors applied
with a warning (never a hard fail)."""

import re
from dataclasses import dataclass, field

import yaml


class ConfigError(Exception):
    """A synthia.yaml problem the user must fix (exit code 2)."""


@dataclass
class RunCfg:
    dataset: str | None = None
    max_turns: int = 12
    concurrency: int = 4
    repeats: int = 1
    timeout_minutes: float = 30


@dataclass
class ThresholdsCfg:
    # pass_rate is required unless the server config supplies
    # ci.default_pass_rate (resolved after the handshake in apply_server_policy).
    pass_rate: float | None = None
    min_scenarios: int = 1


@dataclass
class BaselineCfg:
    branch: str = "main"
    max_regression: float | None = None


@dataclass
class RedactCfg:
    enabled: bool = True
    patterns: list[str] = field(default_factory=list)


@dataclass
class SynthiaConfig:
    version: int = 1
    entrypoint: str = ""
    agent_meta: dict = field(default_factory=dict)
    run: RunCfg = field(default_factory=RunCfg)
    thresholds: ThresholdsCfg = field(default_factory=ThresholdsCfg)
    baseline: BaselineCfg = field(default_factory=BaselineCfg)
    redact: RedactCfg = field(default_factory=RedactCfg)
    output: str = "synthia-results.json"


# ── Tiny hand-rolled validator (dotted-path errors, unknown keys fatal) ──────

def _expect_mapping(v, path: str, issues: list[str]) -> dict:
    if v is None:
        return {}
    if not isinstance(v, dict):
        issues.append(f"{path}: expected a mapping")
        return {}
    return v


def _reject_unknown(obj: dict, allowed: list[str], path: str,
                    issues: list[str]) -> None:
    for key in obj:
        if key not in allowed:
            prefix = f"{path}." if path else ""
            issues.append(
                f"{prefix}{key}: unknown key (allowed: {', '.join(allowed)})")


def _num(v, path, issues, *, minimum=None, maximum=None, integer=False):
    if v is None:
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        issues.append(f"{path}: expected a number")
        return None
    if integer and not (isinstance(v, int) and not isinstance(v, bool)):
        issues.append(f"{path}: expected an integer")
        return None
    if minimum is not None and v < minimum:
        issues.append(f"{path}: must be >= {minimum}")
        return None
    if maximum is not None and v > maximum:
        issues.append(f"{path}: must be <= {maximum}")
        return None
    return v


def _str(v, path, issues):
    if v is None:
        return None
    if not isinstance(v, str) or not v.strip():
        issues.append(f"{path}: expected a non-empty string")
        return None
    return v


def parse_config(source: str) -> SynthiaConfig:
    issues: list[str] = []
    try:
        raw = yaml.safe_load(source)
    except yaml.YAMLError as e:
        raise ConfigError(f"synthia.yaml is not valid YAML: {e}")
    root = _expect_mapping(raw, "", issues)
    _reject_unknown(root, ["version", "agent", "run", "thresholds",
                           "baseline", "telemetry", "output"], "", issues)

    version = _num(root.get("version"), "version", issues, integer=True)
    if version != 1:
        issues.append("version: must be 1")

    agent = _expect_mapping(root.get("agent"), "agent", issues)
    _reject_unknown(agent, ["entrypoint", "meta"], "agent", issues)
    entrypoint = _str(agent.get("entrypoint"), "agent.entrypoint", issues)
    if root.get("agent") is None or (
            entrypoint is None and not any(
                i.startswith("agent.entrypoint") for i in issues)):
        issues.append(
            "agent.entrypoint: required (path to your RolloutAgent module)")
    meta = _expect_mapping(agent.get("meta"), "agent.meta", issues)

    run = _expect_mapping(root.get("run"), "run", issues)
    _reject_unknown(run, ["dataset", "max_turns", "concurrency", "repeats",
                          "timeout_minutes"], "run", issues)
    dataset = _str(run.get("dataset"), "run.dataset", issues)
    if dataset is not None and not re.match(r"^ds_[a-z0-9]+$", dataset):
        issues.append("run.dataset: expected a ds_… dataset id")

    thresholds = _expect_mapping(root.get("thresholds"), "thresholds", issues)
    _reject_unknown(thresholds, ["pass_rate", "min_scenarios"], "thresholds",
                    issues)

    baseline = _expect_mapping(root.get("baseline"), "baseline", issues)
    _reject_unknown(baseline, ["branch", "max_regression"], "baseline", issues)

    telemetry = _expect_mapping(root.get("telemetry"), "telemetry", issues)
    _reject_unknown(telemetry, ["redact"], "telemetry", issues)
    redact = _expect_mapping(telemetry.get("redact"), "telemetry.redact", issues)
    _reject_unknown(redact, ["enabled", "patterns"], "telemetry.redact", issues)
    patterns: list[str] = []
    raw_patterns = redact.get("patterns")
    if raw_patterns is not None:
        if not isinstance(raw_patterns, list) or any(
                not isinstance(p, str) for p in raw_patterns):
            issues.append(
                "telemetry.redact.patterns: expected a list of regex strings")
        else:
            patterns = raw_patterns
    enabled = redact.get("enabled", True)
    if not isinstance(enabled, bool):
        issues.append("telemetry.redact.enabled: expected true or false")
        enabled = True

    defaults = SynthiaConfig()
    config = SynthiaConfig(
        version=1,
        entrypoint=entrypoint or "",
        agent_meta=meta,
        run=RunCfg(
            dataset=dataset,
            max_turns=_num(run.get("max_turns"), "run.max_turns", issues,
                           integer=True, minimum=2, maximum=40)
            or defaults.run.max_turns,
            concurrency=_num(run.get("concurrency"), "run.concurrency", issues,
                             integer=True, minimum=1) or defaults.run.concurrency,
            repeats=_num(run.get("repeats"), "run.repeats", issues,
                         integer=True, minimum=1, maximum=5)
            or defaults.run.repeats,
            timeout_minutes=_num(run.get("timeout_minutes"),
                                 "run.timeout_minutes", issues, minimum=1)
            or defaults.run.timeout_minutes,
        ),
        thresholds=ThresholdsCfg(
            pass_rate=_num(thresholds.get("pass_rate"), "thresholds.pass_rate",
                           issues, minimum=0, maximum=1),
            min_scenarios=_num(thresholds.get("min_scenarios"),
                               "thresholds.min_scenarios", issues,
                               integer=True, minimum=1)
            or defaults.thresholds.min_scenarios,
        ),
        baseline=BaselineCfg(
            branch=_str(baseline.get("branch"), "baseline.branch", issues)
            or defaults.baseline.branch,
            max_regression=_num(baseline.get("max_regression"),
                                "baseline.max_regression", issues,
                                minimum=0, maximum=1),
        ),
        redact=RedactCfg(enabled=enabled, patterns=patterns),
        output=_str(root.get("output"), "output", issues) or defaults.output,
    )

    if issues:
        raise ConfigError(
            "synthia.yaml has problems:\n  - " + "\n  - ".join(issues))
    return config


def load_config(path: str) -> SynthiaConfig:
    try:
        with open(path, encoding="utf-8") as f:
            source = f.read()
    except OSError:
        raise ConfigError(
            f"config not found at {path} — create a synthia.yaml or pass --config")
    return parse_config(source)


def compile_extra_patterns(patterns: list[str]) -> list[tuple[str, "re.Pattern[str]"]]:
    """Compile user redact patterns; invalid regexes are config errors."""
    compiled: list[tuple[str, "re.Pattern[str]"]] = []
    issues: list[str] = []
    for i, p in enumerate(patterns):
        try:
            compiled.append((f"custom-{i}", re.compile(p)))
        except re.error as e:
            issues.append(
                f"telemetry.redact.patterns[{i}]: invalid regex — {e}")
    if issues:
        raise ConfigError(
            "synthia.yaml has problems:\n  - " + "\n  - ".join(issues))
    return compiled


def apply_server_policy(config: SynthiaConfig, ci: dict | None) -> list[str]:
    """Apply the handshake-mirrored customer CI policy (ignore-with-warning:
    admin floors/caps win, but never fail the run for trying)."""
    warnings: list[str] = []
    ci = ci or {}
    if config.thresholds.pass_rate is None:
        default = ci.get("default_pass_rate")
        if default is not None:
            config.thresholds.pass_rate = default
            warnings.append(
                f"thresholds.pass_rate not set — using your organization's "
                f"default ({default})")
        else:
            raise ConfigError("thresholds.pass_rate: required (0..1)")
    floor = ci.get("pass_rate_floor")
    if floor is not None and config.thresholds.pass_rate < floor:
        warnings.append(
            f"thresholds.pass_rate {config.thresholds.pass_rate} is below your "
            f"organization's floor — raised to {floor}")
        config.thresholds.pass_rate = floor
    cap = ci.get("max_concurrency")
    if cap is not None and config.run.concurrency > cap:
        warnings.append(
            f"run.concurrency {config.run.concurrency} exceeds your "
            f"organization's cap — lowered to {cap}")
        config.run.concurrency = cap
    return warnings
