import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

describe("LinkUser runtime selection", () => {
  test("dry-run targets Codex when stale Claude paths are inherited", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-link-user-"));
    const codexRoot = join(home, "codex profile");
    const claudeRoot = join(home, ".claude");
    try {
      const script = join(import.meta.dir, "LinkUser.ts");
      const result = spawnSync(process.execPath, [script], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codexRoot,
          CODEX_THREAD_ID: "runtime-path-test",
          CLAUDE_CONFIG_DIR: claudeRoot,
          LIFEOS_DIR: join(claudeRoot, "LIFEOS"),
        },
        windowsHide: true,
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { dryRun: boolean; willLink: string };
      expect(output.dryRun).toBe(true);
      expect(output.willLink).toContain(join(codexRoot, "LIFEOS", "USER"));
      expect(output.willLink).not.toContain(claudeRoot);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
