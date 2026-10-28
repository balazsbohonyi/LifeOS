#!/usr/bin/env bun
/** Run the two deterministic memory-maintenance stages without a shell. */

import { findExecutable, resolveRuntimePaths } from "../../TOOLS/RuntimePaths.ts";
import { runHidden } from "../lib/hidden-spawn";

const paths = resolveRuntimePaths();
const bun = findExecutable("bun");
if (!bun) throw new Error("memory-consolidation: Bun executable not found");

const stages = [
  ["run", `${paths.toolsDir}/SessionHarvester.ts`, "--recent", "20"],
  ["run", `${paths.toolsDir}/LearningPatternSynthesis.ts`, "--week"],
];

for (const args of stages) {
  // runHidden, not Bun.spawn: a bun child can open a Windows Terminal window. Output is forwarded
  // so the stage logs still reach the Pulse log.
  const { stdout, stderr, exitCode } = await runHidden(bun, args, {
    cwd: paths.lifeosDir,
    env: { ...process.env } as Record<string, string>,
    timeoutMs: 30 * 60_000,
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (exitCode !== 0) {
    throw new Error(`memory-consolidation stage failed (${args[1]}) with exit code ${exitCode}`);
  }
}
