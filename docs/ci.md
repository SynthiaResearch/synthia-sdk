# Synthia in CI — customer quickstart

Gate your agent's pull requests on Synthia evals: every PR plays your agent
against a pinned suite of simulated-user scenarios, a judge scores each
rollout, and the check fails when the pass rate drops below your threshold.
One secret + two files.

Using a framework? See the per-framework guides in
[docs/integrations/](./integrations/README.md) (LangGraph, OpenAI Agents SDK,
Vercel AI SDK) — each ends in a copy-paste `synthia.yaml` + workflow.

## 1. Secret

Add `SYNTHIA_API_KEY` to the repo's Actions secrets, plus whatever model keys
your agent itself needs (e.g. `ANTHROPIC_API_KEY`).

## 2. `synthia.yaml`

```yaml
version: 1
agent:
  entrypoint: ./src/agent.ts   # module exporting a RolloutAgent
  meta: { name: my-agent }
run:
  dataset: ds_…                # pin one (create it once with the SDK's prepare())
  max_turns: 12
  concurrency: 4
  repeats: 1                   # >1 pools pass rates across repeats
  timeout_minutes: 30
thresholds:
  pass_rate: 0.8               # the gate; org admins can set a floor server-side
  min_scenarios: 1
baseline:
  branch: main                 # deltas vs the newest run on this branch
  max_regression: null         # set (e.g. 0.1) to also gate on regressions
telemetry:
  redact: { enabled: true }    # secret-shaped strings scrubbed before upload
output: synthia-results.json
```

Editor validation: point your YAML language server at
`node_modules/synthiaresearch/schema/synthia.schema.json`.

The entrypoint must export a `RolloutAgent` — `(transcript, sandbox) =>
reply` — as `agent`, the default export, or via an `#exportName` suffix.
TypeScript entrypoints load natively on Node ≥ 22.18 (GitHub runners default
to Node 24); older Node needs a dev install of `tsx` or a built-JS entrypoint.

## 3. Workflow

Use the [Synthia action](https://github.com/SynthiaResearch/synthia-action)
(recommended — PR comments with baseline deltas and config-drift callouts),
or the bare CLI:

```yaml
      - run: npx synthiaresearch run
        env:
          SYNTHIA_API_KEY: ${{ secrets.SYNTHIA_API_KEY }}
```

### Python agents

The CLI ships in both the npm and PyPI `synthiaresearch` packages. For a Python
agent, install from PyPI and set `language: python` — the action shells out to
`python -m synthia` and posts the identical PR comment:

```yaml
jobs:
  evals:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v7
        with: { persist-credentials: false }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install synthiaresearch   # + your agent's own deps
      - uses: SynthiaResearch/synthia-action@v1
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        with:
          api-key: ${{ secrets.SYNTHIA_API_KEY }}
          language: python
```

Your `synthia.yaml` `agent.entrypoint` points at a Python module exporting
`agent(transcript, sandbox) -> reply` (optionally `path.py#callable_name`).
Everything else — the schema, gates, baseline, results JSON — is identical
across languages. Or run the bare CLI directly: `python -m synthia run`.

Trigger on `pull_request` **and** on `push` to your baseline branch — the
push runs are what PR deltas compare against.

Exit codes: `0` gates met · `1` gate failed · `2` config/usage error ·
`3` infrastructure/timeout. `synthia validate` checks the config and
entrypoint without network — the cheap local debug loop.

### Start non-blocking

To adopt Synthia without blocking merges from day one, run it in advisory
mode — `warn-only: true` on the action, or `--warn-only` on the CLI. PRs still
get the full comment (scores, deltas, named regressions), but the check stays
green regardless of the gate (config/infra errors still fail). Flip it off once
your thresholds are calibrated.

## Security notes (non-negotiable)

- `on: pull_request` only. **Never `pull_request_target`** with a checkout of
  the PR head. Fork PRs get no secrets; the check should skip, not fail —
  gate on secret presence (a first step that checks the secret and sets an
  output the eval step is conditioned on). For public repos that need fork
  coverage, use a GitHub Environment with required reviewers and approve
  each run.
- Explicit `permissions: { contents: read, pull-requests: write }` (drop the
  write when not commenting) and `persist-credentials: false` on checkout.
- Egress allowlist for hardened runners:
  `synthia-research--synthia-api-web.modal.run:443` + your agent's own hosts.
- What leaves the runner: agent replies + tool-call events (redacted by
  default), scores, and CI metadata (repo/branch/commit). The results JSON
  contains scores and metadata only — safe to upload as an artifact.
