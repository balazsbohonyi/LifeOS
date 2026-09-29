import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRuntimePaths, toRuntimePathDisplay } from "../../TOOLS/RuntimePaths.ts";
import { resolveUserIndexPaths } from "./user-index";

describe("USER index Windows Codex runtime", () => {
  test("reports and indexes the .codex USER junction instead of the legacy .claude tree", () => {
    if (process.platform !== "win32") return;

    const home = mkdtempSync(join(tmpdir(), "lifeos-user-index-codex-"));
    const configRoot = join(home, ".codex");
    const lifeosDir = join(configRoot, "LIFEOS");
    const userDir = join(lifeosDir, "USER");
    const canonicalUserDir = join(home, ".config", "LIFEOS", "USER");
    const legacyUserDir = join(home, ".claude", "LIFEOS", "USER");
    const runtimeEnv = {
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: configRoot,
    };

    try {
      mkdirSync(join(lifeosDir, "TOOLS"), { recursive: true });
      mkdirSync(canonicalUserDir, { recursive: true });
      mkdirSync(legacyUserDir, { recursive: true });
      symlinkSync(canonicalUserDir, userDir, "junction");
      writeFileSync(join(canonicalUserDir, "PROJECTS.md"), "# Projects\n\nMy Codex project data.\n");
      writeFileSync(join(legacyUserDir, "WRONG-ROOT.md"), "# Must not be indexed\n");

      const runtime = resolveRuntimePaths({ env: runtimeEnv, home });
      const displayed = toRuntimePathDisplay(runtime);
      const indexPaths = resolveUserIndexPaths({ env: runtimeEnv, home });

      expect(displayed.configRoot).toBe(join("~", ".codex"));
      expect(displayed.userDir).toBe(join("~", ".codex", "LIFEOS", "USER"));
      expect(indexPaths.userDir).toBe(userDir);
      expect(indexPaths.indexPath).toBe(join(configRoot, "LIFEOS", "PULSE", "state", "user-index.json"));

      const indexerPath = join(import.meta.dir, "user-index.ts");
      const childEnv = { ...process.env, ...runtimeEnv };
      delete childEnv.CLAUDE_CONFIG_DIR;
      delete childEnv.LIFEOS_DIR;
      delete childEnv.LIFEOS_CONFIG_PATH;
      const startModule = `import(${JSON.stringify(indexerPath)}).then(async (indexer) => { await indexer.start(); await indexer.stop(); }).catch((error) => { console.error(error); process.exit(1); });`;
      const child = spawnSync(process.execPath, ["-e", startModule], {
        cwd: home,
        env: childEnv,
        encoding: "utf8",
        windowsHide: true,
      });

      expect(child.status).toBe(0);
      expect(child.stderr).toBe("");
      expect(child.stdout).toContain("Initial scan: 1 files");
      expect(indexPaths.indexPath).toBeTruthy();
      const index = JSON.parse(readFileSync(indexPaths.indexPath, "utf8"));
      expect(index.user_dir).toBe(userDir);
      expect(index.files.map((file: { path: string }) => file.path)).toContain("PROJECTS.md");
      expect(index.files.map((file: { path: string }) => file.path)).not.toContain("WRONG-ROOT.md");
      expect(readFileSync(indexPaths.indexPath, "utf8")).not.toContain("Must not be indexed");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
