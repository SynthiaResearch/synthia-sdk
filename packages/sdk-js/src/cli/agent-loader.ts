import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { RolloutAgent } from "../client.js";
import { ConfigError } from "./config.js";

const HINT =
  "TypeScript entrypoints need Node >= 22.18 (GitHub runners default to " +
  "Node 24), a dev install of tsx (`npm i -D tsx`), or point " +
  "agent.entrypoint at built JS instead.";

/**
 * Load the customer's RolloutAgent from `entrypoint` ("./src/agent.ts",
 * optionally "#exportName"), resolved relative to the config file's
 * directory. Export pick: the #name if given, else `agent`, else default.
 */
export async function loadAgent(
  entrypoint: string,
  configDir: string,
): Promise<RolloutAgent> {
  const [file, exportName] = splitEntrypoint(entrypoint);
  const path = isAbsolute(file) ? file : resolve(configDir, file);
  const url = pathToFileURL(path).href;

  let mod: Record<string, unknown>;
  try {
    mod = await import(url);
  } catch (e) {
    mod = await retryWithTsx(url, path, e);
  }

  const picked = exportName
    ? mod[exportName]
    : (mod["agent"] ?? mod["default"]);
  if (typeof picked !== "function") {
    const wanted = exportName ? `a \`${exportName}\`` : "an `agent` (or default)";
    throw new ConfigError(
      `agent.entrypoint: ${entrypoint} must export ${wanted} function ` +
        "of type (transcript, sandbox) => reply",
    );
  }
  return picked as RolloutAgent;
}

function splitEntrypoint(entrypoint: string): [string, string | undefined] {
  const hash = entrypoint.lastIndexOf("#");
  return hash > 0
    ? [entrypoint.slice(0, hash), entrypoint.slice(hash + 1)]
    : [entrypoint, undefined];
}

/** Older Node can't strip .ts types natively; if the customer has tsx
 * installed, register its ESM loader and retry — no dependency of ours. */
async function retryWithTsx(
  url: string,
  path: string,
  original: unknown,
): Promise<Record<string, unknown>> {
  const code = (original as { code?: string })?.code;
  const message = original instanceof Error ? original.message : String(original);
  if (code === "ERR_MODULE_NOT_FOUND" && !message.includes(path)) {
    // The entrypoint itself resolved; some import inside it didn't. Not
    // a loader problem — surface the real error.
    throw new ConfigError(`agent.entrypoint failed to load: ${message}`);
  }
  const tsProblem =
    code === "ERR_UNKNOWN_FILE_EXTENSION" ||
    code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" ||
    (code === "ERR_MODULE_NOT_FOUND" && /\.tsx?$/.test(path));
  if (!tsProblem) {
    throw new ConfigError(`agent.entrypoint failed to load: ${message}`);
  }
  try {
    const require = createRequire(path);
    const tsxApi = require.resolve("tsx/esm/api");
    const { register } = await import(pathToFileURL(tsxApi).href);
    register();
    return await import(url);
  } catch (e) {
    if ((e as { code?: string })?.code === "MODULE_NOT_FOUND") {
      throw new ConfigError(
        `agent.entrypoint could not be loaded (${message}). ${HINT}`,
      );
    }
    throw new ConfigError(
      `agent.entrypoint failed to load: ${e instanceof Error ? e.message : e}. ${HINT}`,
    );
  }
}
