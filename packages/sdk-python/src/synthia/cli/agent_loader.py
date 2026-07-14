"""Load the customer's RolloutAgent from an entrypoint — port of
cli/agent-loader.ts, using importlib instead of a JS dynamic import."""

import importlib.util
import os
import sys
import uuid

from .config import ConfigError


def load_agent(entrypoint: str, config_dir: str):
    """Load the RolloutAgent from `entrypoint` ("./agent.py", optionally
    "path#callable_name"), resolved relative to the config file's directory.
    Attribute pick: the #name if given, else `agent`, else a module-level
    `main`/default is NOT assumed — Python has no default export, so we require
    an `agent` attribute (or an explicit #name)."""
    file, _, export = entrypoint.partition("#")
    path = file if os.path.isabs(file) else os.path.join(config_dir, file)
    path = os.path.abspath(path)
    if not os.path.exists(path):
        raise ConfigError(f"agent.entrypoint: no file at {path}")

    mod_name = f"_synthia_entry_{uuid.uuid4().hex[:8]}"
    spec = importlib.util.spec_from_file_location(mod_name, path)
    if spec is None or spec.loader is None:
        raise ConfigError(f"agent.entrypoint: could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[mod_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as e:  # surface the customer module's own import errors
        raise ConfigError(f"agent.entrypoint failed to import: {e}")

    name = export or "agent"
    picked = getattr(module, name, None)
    if not callable(picked):
        wanted = f"a `{export}`" if export else "an `agent`"
        raise ConfigError(
            f"agent.entrypoint: {entrypoint} must export {wanted} callable "
            "of the form (transcript, sandbox) -> reply")
    return picked
