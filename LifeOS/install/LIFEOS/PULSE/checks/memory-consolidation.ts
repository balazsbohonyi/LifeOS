#!/usr/bin/env bun
/** Run the two deterministic memory-maintenance stages without a shell. */

import { findExecutable, resolveRuntimePaths } from "../../TOOLS/RuntimePaths.ts";

const paths = resolveRuntimePaths();
const bun = findExecutable("bun");
if (!bun) throw new Error("memory-consolidation: Bun executable not found");

const stages = [
  ["run", `${paths.toolsDir}/SessionHarvester.ts`, "--recent", "20"],
  ["run", `${paths.toolsDir}/LearningPatternSynthesis.ts`, "--week"],
];

for (const args of stages) {
  const proc = Bun.spawn([bun, ...args], {
    cwd: paths.lifeosDir,
    env: { ...process.env },
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`memory-consolidation stage failed (${args[1]}) with exit code ${exitCode}`);
  }
}
