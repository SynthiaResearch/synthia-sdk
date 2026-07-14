/**
 * One-time bootstrap: probe the agent, build a user model, and generate the
 * scenario dataset that synthia.yaml pins for CI runs.
 *
 *   SYNTHIA_API_KEY=... ANTHROPIC_API_KEY=... \
 *     node --experimental-strip-types scripts/bootstrap-dataset.ts
 *
 * Prints the ds_… id to paste into synthia.yaml's run.dataset. Uses the same
 * ci/<repo> session naming as `synthia run` so the dataset lives where CI
 * looks for it.
 */
import { Synthia } from "synthiaresearch";
import { probe } from "../src/agent.ts";

const synthia = new Synthia({ session: process.env["SYNTHIA_SESSION"] ?? "ci/ci-demo" });

const result = await synthia.prepare(probe, { count: 8, verbose: true });
console.log(`\naction: ${result.action} — ${result.reason}`);
console.log(`dataset: ${result.dataset.id} (${result.dataset.row_count} rows)`);
console.log(`\npin it in synthia.yaml ->  run.dataset: ${result.dataset.id}`);
