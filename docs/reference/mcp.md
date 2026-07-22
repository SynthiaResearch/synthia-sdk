# MCP server

`https://mcp.synthiaresearch.com/mcp`

Everything a user can do through the SDKs or the web app is drivable from an
MCP client. The server is a translation layer: each tool calls the same `/v1`
route the SDKs call, in-process, so auth, customer-config scoping, telemetry
redaction and error messages are identical and there is no second copy of the
business logic.

## Connecting

**OAuth** is the intended path. Point a client at the URL and it discovers
Clerk through `/.well-known/oauth-protected-resource`, registers itself, and
opens a browser for sign-in. Signup and connection are the same flow; no
secret is ever pasted.

**API key** works too, for CI and headless use — send
`Authorization: Bearer ak_…`. Not advertised, but supported and stable.

```json
{
  "mcpServers": {
    "synthia": {
      "type": "http",
      "url": "https://mcp.synthiaresearch.com/mcp",
      "headers": { "Authorization": "Bearer ${SYNTHIA_API_KEY}" }
    }
  }
}
```

Both Clerk access-token formats are accepted (opaque `oat_…` and JWT), so the
instance's "generate access tokens as JWTs" setting cannot break clients
either way. See `mcp/oauth.py` for why the audience, not the prefix, is what
separates an access token from a session token.

## Two things to know before reading the catalog

**Jobs never block.** Modal caps a web request at 150s; generation,
validation, quality checks and voice renders take minutes. Those tools return
a handle immediately and are polled with `get_run` — one tool for all four
types, dispatching on the run id's prefix (`gen_`, `vr_`, `qc_`, `vox_`).

**The server never runs your agent.** Probing and rollouts are relays: the
tool hands you the next user turn, you run your agent, you post the reply.
That is why a local script, a notebook cell and a deployed endpoint are all
the same case — nothing has to reach into your environment, so there is no
tunnel and no localhost exposure.

## Tools

### Account and jobs

| Tool | Purpose |
|---|---|
| `health` | Liveness, deployed version and release SHA |
| `get_context` | What Synthia knows about the account — start here |
| `get_run` | Poll any job; status, type-shaped detail, event timeline |
| `list_runs` | Everything run, filterable by type or session |
| `get_usage` | Request volume, error rate, latency over 24h/7d/30d |
| `create_session` | Name a session for attribution |

### Material in

| Tool | Purpose |
|---|---|
| `create_seed` | Ingest a doc, tool schema, policy, conversation or recording |
| `ingest_trace` | Distill a real production failure into scenarios |
| `list_issues` / `get_issue` | Captured production issues and their repros |

### Agents

| Tool | Purpose |
|---|---|
| `start_probe_session` | Begin interviewing the agent under test |
| `post_probe_response` | Answer the current probe, get the next |
| `get_probe_session` | Probe state, `next_probe`, `user_model_id` |
| `list_agents` | User models built from probes |
| `submit_custom_scenarios` | Author scenarios by hand |

### Scenarios and datasets

| Tool | Purpose |
|---|---|
| `generate_scenarios` | Generate a batch (job) |
| `list_datasets` / `get_dataset_rows` | Datasets and their scenario content |
| `compose_dataset` | Assemble or curate from explicit scenario ids |
| `validate_dataset` | Grade the scenarios, not the agent (job) |

### Rollouts and judging

| Tool | Purpose |
|---|---|
| `create_rollout` | Start playing a scenario; returns the opening turn |
| `post_rollout_turn` | Post the agent's reply, get the next user turn |
| `get_rollout` | Full trace: transcript, tools, hidden state, evaluations |
| `create_quality_check` | Judge finished rollouts (job) |
| `get_quality_check_results` | Per-rollout verdicts and judge reasoning |
| `get_latest_quality_check` | Latest pass rate — what a CI gate compares |

### Voice

| Tool | Purpose |
|---|---|
| `create_voice_render` | Render a scenario or rollout to audio (job) |
| `get_voice_render_audio` | Fetch the render, base64 |
| `get_rollout_turn_audio` | Fetch one turn's audio, base64 |

## Prompts

The SDK composites (`prepare`, `run`, `runScenario`, `createFromProbe`) are
prompts rather than tools. They are orchestration loops that run the agent
between turns, and in an MCP client the model is the only party that can do
that — as tools they would be tools unable to do the thing they name.

| Prompt | Does |
|---|---|
| `setup-synthia` | First run: probe → generate → play one → verdict |
| `run-evaluation` | Roll out a whole dataset and judge it |
| `diagnose-run` | Work out why a run failed or scored badly |
| `triage-issue` | Reproduce a production failure, check whether a fix holds |
| `expand-dataset` | Generate a harder batch calibrated on real performance |

## Untrusted data

Scenario text, simulated-user messages, issue notes and transcripts are
attacker-influenced by design — adversarial content is the product. Tool
results label it. It must never drive tool selection, and it is never
interpolated into tool descriptions.

## Not exposed

- The `/v1/demo/*` routes (marketing surface).
- API-key minting — bootstrap and blast radius; listing stays in
  `/live/account`.
- `synthia validate`, which is inherently local (it parses your config and
  imports your entrypoint).
- Raw SQL over the database. The read surface is `/v1/account/*` instead:
  pre-joined, ownership-scoped views that cover the same ground without
  handing a model a query engine. See `.notes/` for why the SQL surface was
  held.

## Example

`examples/mcp-agent/` — a local agent with three documented failure modes, a
`.mcp.json`, and a `/synthia-eval` slash command that drives the whole loop
through the server.
