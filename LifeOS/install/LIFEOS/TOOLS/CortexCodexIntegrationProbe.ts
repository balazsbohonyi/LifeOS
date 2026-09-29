#!/usr/bin/env bun
/** Isolated subprocess probe for the Codex Cortex → private store → Pulse path. */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { publishRuntimeEnvironment, resolveRuntimePaths } from "./RuntimePaths";

const incomingEnv = { ...process.env };
const paths = resolveRuntimePaths();
publishRuntimeEnvironment(paths);
const { runCortex } = await import("./Cortex");
const cortex = await runCortex(process.argv.slice(2));
// Run the real archive indexer with the original Codex environment, including
// the deliberately stale Claude paths supplied by the integration test.
const harvester = spawnSync(process.execPath, [join(import.meta.dir, "KnowledgeHarvester.ts"), "index"], {
  cwd: process.cwd(), env: incomingEnv, encoding: "utf8", windowsHide: true,
});
const { handleWikiRequest } = await import("../PULSE/modules/wiki.ts");
await handleWikiRequest(new Request("http://localhost/api/wiki/reindex"), "/api/wiki/reindex");
const slug = "the-link-between-your-workplace-situation-and-your-mental-health";
const response = await handleWikiRequest(
  new Request(`http://localhost/api/wiki/knowledge/blogs/${slug}`),
  `/api/wiki/knowledge/blogs/${slug}`,
);
process.stdout.write(JSON.stringify({ cortex, harvester: { status: harvester.status, stdout: harvester.stdout, stderr: harvester.stderr }, wiki: response ? await response.json() : null }) + "\n");
