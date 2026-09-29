import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("CollectSignals runtime selection", () => {
  test("defaults to Codex when stale Claude paths are inherited", () => {
    const home = mkdtempSync(join(tmpdir(), "collect-signals-codex-"));
    const codexRoot = join(home, ".codex");
    const claudeRoot = join(home, ".claude");
    try {
      const result = spawnSync(process.execPath, [join(import.meta.dir, "CollectSignals.ts")], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_THREAD_ID: "runtime-path-test",
          CLAUDE_CONFIG_DIR: claudeRoot,
          LIFEOS_DIR: join(claudeRoot, "LIFEOS"),
        },
        windowsHide: true,
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { sources: { root: string } };
      expect(output.sources.root).toBe(codexRoot);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
