# Environment, sessions, and security posture

## Environment variables

The SDKs and CLI read **exactly** these variables:

| Variable | Read by | Meaning |
| --- | --- | --- |
| `SYNTHIA_API_KEY` | SDK client | The API key — the only secret. There is deliberately no `--api-key` CLI flag (argv leaks into shell history and CI logs). |
| `SYNTHIA_BASE_URL` | SDK client | API origin override; defaults to the hosted API. |
| `SYNTHIA_SESSION` | SDK client | Session name override (below). |
| `GITHUB_ACTIONS`, `GITHUB_REPOSITORY`, `GITHUB_SHA`, `GITHUB_REF_NAME`, `GITHUB_HEAD_REF`, `GITHUB_EVENT_NAME`, `GITHUB_RUN_ID`, `GITHUB_SERVER_URL` | CLI only | Non-secret CI provenance (repo, branch, commit, run URL) recorded on runs. |

### The never-iterate policy

The CLI reads each variable above **by exact name and never iterates the
process environment.** This is a security posture, not a style choice: what
a CI tool reads from the environment is an audit surface, and tools that
sweep the whole environment are how incidents like Codecov 2021 exfiltrated
unrelated secrets. You can audit Synthia's entire environment access by
grepping the source for the names above; there is nothing else.

Outside GitHub Actions, the CLI falls back to `git` (`remote.origin.url`,
`rev-parse`) for best-effort provenance — so a laptop `synthia run` on your
baseline branch can seed the baseline too.

## Sessions

Every SDK client belongs to a **named session**: the stable, account-scoped
identity of one script, persisted across executions. Sessions are what make
re-runs cheap and safe — `prepare()` reuses the session's own datasets and
user models instead of re-probing, and concurrent scripts never pick up
each other's data.

Name resolution order:

1. The `session` constructor option/argument;
2. the `SYNTHIA_SESSION` environment variable;
3. a derived `"project/script"` name — the entry-point script's parent
   directory and filename (readable, survives moving the project, never
   leaks the full directory layout). REPLs fall back to the working
   directory's name.

`session: false` (JS) / `session=False` (Python) opts out into a fresh
ephemeral session (`…/eph-<random>`): nothing is reused, nothing is left
behind for later runs to reuse.

**CI sessions.** `synthia run` uses `ci/<owner>/<repo>` — one session
grouping every CI run of a repo across branches, which is what makes the
[baseline query](./configuration.md#baseline--regression-gating) work. Use
`--session-suffix <name>` (`ci/<repo>/<name>`) to keep multiple agent
suites in one repo from sharing baselines.

### Degradation ladder

The handshake that opens a session degrades rather than failing over
optional tracking:

| Situation | Behavior |
| --- | --- |
| Transient 5xx on the handshake (serverless cold start) | Retried briefly (which also warms the backend), then the run proceeds **untracked** rather than failing. |
| Server predates sessions (404) | Sessionless — everything works, nothing is session-scoped. |
| No API key against a server that allows it | Anonymous session. |
| Invalid API key (401) | **Fails** with the server's message — in JS on the first awaited request (or `ready()`), in Python at construction. |

## Org CI policy (`CiSettings`)

The handshake mirrors your organization's server-side CI policy onto the
client (`ciSettings` / `ci_settings`; `null`/`None` when the account has
none):

| Field | Effect on `synthia run` |
| --- | --- |
| `default_pass_rate` | Used when `thresholds.pass_rate` is unset (with a warning). Without either, the run is a config error. |
| `pass_rate_floor` | A yaml `pass_rate` below the floor is **raised to it**, with a warning. |
| `max_concurrency` | A yaml/flag `concurrency` above the cap is **lowered to it**, with a warning. |

Policy is applied last — above config and flags — because it's an admin
control, not a preference. It warns, never fails: an over-permissive yaml is
corrected, not punished.

## What leaves the machine

During probing and rollouts, your agent runs locally; what travels is the
probe questions and replies, rollout replies, and tool-call events
([redacted by default](./configuration.md#telemetryredact--redaction)),
plus scores and CI metadata. The CLI's results JSON contains scores and
metadata only — never transcripts, tool events, or credentials. For
hardened CI runners, the only egress the CLI itself needs is the Synthia
API host (your `SYNTHIA_BASE_URL`, or the default hosted API) on port 443.
