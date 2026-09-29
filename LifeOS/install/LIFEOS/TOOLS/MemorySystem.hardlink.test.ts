import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { appendToTierBFile } from "./MemorySystem";

describe("MemorySystem hard-link boundary", () => {
  test("Tier B atomic replacement detaches a hard-linked note before appending", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-tier-b-hardlink-"));
    const note = join(home, "note.md");
    const outsideAlias = join(home, "tracked.md");
    try {
      writeFileSync(note, "existing private content\n", "utf8");
      linkSync(note, outsideAlias);

      const result = appendToTierBFile(note, "new private content\n");

      expect(result.ok).toBe(true);
      expect(readFileSync(note, "utf8")).toBe("existing private content\nnew private content\n");
      expect(readFileSync(outsideAlias, "utf8")).toBe("existing private content\n");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("refuses to append a proposal through a hard link into the Claude system tree", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-memory-proposal-hardlink-"));
    const codexRoot = join(home, ".codex");
    const claudeRoot = join(home, ".claude");
    const privateUser = join(home, ".config", "LIFEOS", "USER");
    const privateMemory = join(privateUser, "MEMORY");
    const codexLifeos = join(codexRoot, "LIFEOS");
    const pendingQueue = join(privateMemory, "OBSERVABILITY", "pending-proposals.jsonl");
    const trackedFile = join(claudeRoot, "LIFEOS", "tracked.md");
    try {
      mkdirSync(join(privateMemory, "OBSERVABILITY"), { recursive: true });
      mkdirSync(privateUser, { recursive: true });
      mkdirSync(codexLifeos, { recursive: true });
      mkdirSync(join(claudeRoot, "LIFEOS"), { recursive: true });
      symlinkSync(privateUser, join(codexLifeos, "USER"), "junction");
      symlinkSync(privateMemory, join(codexLifeos, "MEMORY"), "junction");
      writeFileSync(trackedFile, "tracked system content\n", "utf8");
      linkSync(trackedFile, pendingQueue);

      const memorySystemUrl = pathToFileURL(join(import.meta.dir, "MemorySystem.ts")).href;
      const memoryTypesUrl = pathToFileURL(join(import.meta.dir, "MemoryTypes.ts")).href;
      const probe = [
        `import { add } from ${JSON.stringify(memorySystemUrl)};`,
        `import { PROJECTS_PATH } from ${JSON.stringify(memoryTypesUrl)};`,
        `const result = add({ type: "proposal", target_kind: "projects", target_file: PROJECTS_PATH, edit: "Add one project summary row.", confidence: 0.8, rationale: "hard-link boundary regression" });`,
        `process.stdout.write(JSON.stringify(result));`,
      ].join("\n");
      const result = spawnSync(process.execPath, ["-e", probe], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codexRoot,
          CODEX_THREAD_ID: "proposal-hardlink-test",
          CLAUDE_CONFIG_DIR: claudeRoot,
          LIFEOS_DIR: join(claudeRoot, "LIFEOS"),
        },
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { ok: boolean; message?: string };
      expect(output.ok).toBe(false);
      expect(output.message).toContain("multiple hard links");
      expect(readFileSync(trackedFile, "utf8")).toBe("tracked system content\n");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
