import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMemoryLink, previewMemoryLink, type MemoryLinkOptions } from "./LinkMemory";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "lifeos-memory-link-"));
  const configRoot = join(home, ".codex");
  const configDir = join(home, ".config", "LIFEOS");
  const options: MemoryLinkOptions = { home, configRoot, configDir };
  const runtimeMemory = join(configRoot, "LIFEOS", "MEMORY");
  const privateMemory = join(configDir, "USER", "MEMORY");
  const legacyMemory = join(home, ".claude", "LIFEOS", "MEMORY");
  mkdirSync(runtimeMemory, { recursive: true });
  mkdirSync(legacyMemory, { recursive: true });
  mkdirSync(join(configDir, "USER"), { recursive: true });
  return { home, options, runtimeMemory, privateMemory, legacyMemory, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

describe("LinkMemory explicit migration", () => {
  test("previews both runtime and Claude archive sources without writing", () => {
    const f = fixture();
    try {
      const activeFile = join(f.runtimeMemory, "WORK", "active.md");
      const legacyFile = join(f.legacyMemory, "KNOWLEDGE", "legacy.md");
      mkdirSync(join(f.runtimeMemory, "WORK"), { recursive: true });
      mkdirSync(join(f.legacyMemory, "KNOWLEDGE"), { recursive: true });
      writeFileSync(activeFile, "active", "utf8");
      writeFileSync(legacyFile, "legacy", "utf8");

      const preview = previewMemoryLink(f.options);
      expect(preview.action).toBe("would-link");
      expect(preview.filesToCopy.sort()).toEqual(["KNOWLEDGE/legacy.md", "WORK/active.md"]);
      expect(existsSync(f.privateMemory)).toBe(false);
      expect(readFileSync(activeFile, "utf8")).toBe("active");
      expect(readFileSync(legacyFile, "utf8")).toBe("legacy");
    } finally { f.dispose(); }
  });

  test("requires CLI confirmation before touching either source or destination", () => {
    const f = fixture();
    try {
      const source = join(f.runtimeMemory, "WORK", "keep.md");
      mkdirSync(join(f.runtimeMemory, "WORK"), { recursive: true });
      writeFileSync(source, "preserve me", "utf8");

      const result = spawnSync(process.execPath, [
        join(import.meta.dir, "LinkMemory.ts"), "--config-root", f.options.configRoot, "--apply",
      ], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
        env: {
          ...process.env,
          HOME: f.home,
          USERPROFILE: f.home,
          CODEX_HOME: f.options.configRoot,
          CODEX_THREAD_ID: "migration-confirmation-test",
        },
      });

      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout).refused).toBe("explicit-confirmation-required");
      expect(readFileSync(source, "utf8")).toBe("preserve me");
      expect(existsSync(f.privateMemory)).toBe(false);
      expect(lstatSync(f.runtimeMemory).isSymbolicLink()).toBe(false);
    } finally { f.dispose(); }
  });

  test("applies a reviewed migration through the confirmed CLI path", () => {
    const f = fixture();
    try {
      const source = join(f.runtimeMemory, "WORK", "cli.md");
      mkdirSync(join(f.runtimeMemory, "WORK"), { recursive: true });
      writeFileSync(source, "retain through backup", "utf8");

      const result = spawnSync(process.execPath, [
        join(import.meta.dir, "LinkMemory.ts"), "--config-root", f.options.configRoot,
        "--apply", "--confirm-migration",
      ], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
        env: {
          ...process.env,
          HOME: f.home,
          USERPROFILE: f.home,
          CODEX_HOME: f.options.configRoot,
          CODEX_THREAD_ID: "confirmed-migration-test",
        },
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout) as { ok: boolean; linked: boolean; copied: number; backup: string };
      expect(output.ok).toBe(true);
      expect(output.linked).toBe(true);
      expect(output.copied).toBe(1);
      expect(readFileSync(join(f.privateMemory, "WORK", "cli.md"), "utf8")).toBe("retain through backup");
      expect(readFileSync(join(output.backup, "WORK", "cli.md"), "utf8")).toBe("retain through backup");
      expect(lstatSync(f.runtimeMemory).isSymbolicLink()).toBe(true);
    } finally { f.dispose(); }
  });

  test("copies missing files, preserves both source trees, and links runtime MEMORY", () => {
    const f = fixture();
    try {
      const activeFile = join(f.runtimeMemory, "KNOWLEDGE", "Blogs", "active.md");
      const legacyFile = join(f.legacyMemory, "WORK", "legacy.md");
      mkdirSync(join(f.runtimeMemory, "KNOWLEDGE", "Blogs"), { recursive: true });
      mkdirSync(join(f.legacyMemory, "WORK"), { recursive: true });
      writeFileSync(activeFile, "active content", "utf8");
      writeFileSync(legacyFile, "legacy content", "utf8");

      const result = applyMemoryLink(f.options);
      expect(result.linked).toBe(true);
      expect(result.copied).toBe(2);
      expect(result.backup).toBeDefined();
      expect(readFileSync(join(f.privateMemory, "KNOWLEDGE", "Blogs", "active.md"), "utf8")).toBe("active content");
      expect(readFileSync(join(f.privateMemory, "WORK", "legacy.md"), "utf8")).toBe("legacy content");
      expect(readFileSync(join(result.backup!, "KNOWLEDGE", "Blogs", "active.md"), "utf8")).toBe("active content");
      expect(readFileSync(legacyFile, "utf8")).toBe("legacy content");
      expect(readFileSync(join(f.runtimeMemory, "WORK", "legacy.md"), "utf8")).toBe("legacy content");
      expect(previewMemoryLink(f.options).action).toBe("already-linked");
    } finally { f.dispose(); }
  });

  test("detects a legacy Claude archive after the active runtime is already linked", () => {
    const f = fixture();
    try {
      const initial = applyMemoryLink(f.options);
      expect(initial.linked).toBe(true);
      const legacyFile = join(f.legacyMemory, "KNOWLEDGE", "from-claude.md");
      mkdirSync(join(f.legacyMemory, "KNOWLEDGE"), { recursive: true });
      writeFileSync(legacyFile, "legacy-only content", "utf8");

      const preview = previewMemoryLink(f.options);
      expect(preview.action).toBe("would-link");
      expect(preview.sources.map(source => source.label)).toEqual(["legacy-claude"]);
      expect(preview.filesToCopy).toEqual(["KNOWLEDGE/from-claude.md"]);

      const result = applyMemoryLink(f.options);
      expect(result.linked).toBe(true);
      expect(result.copied).toBe(1);
      expect(readFileSync(join(f.privateMemory, "KNOWLEDGE", "from-claude.md"), "utf8")).toBe("legacy-only content");
      expect(readFileSync(legacyFile, "utf8")).toBe("legacy-only content");
      expect(previewMemoryLink(f.options).action).toBe("already-linked");
    } finally { f.dispose(); }
  });

  test("conflicting destination files block migration without overwriting either copy", () => {
    const f = fixture();
    try {
      const source = join(f.runtimeMemory, "WORK", "conflict.md");
      const destination = join(f.privateMemory, "WORK", "conflict.md");
      mkdirSync(join(f.runtimeMemory, "WORK"), { recursive: true });
      mkdirSync(join(f.privateMemory, "WORK"), { recursive: true });
      writeFileSync(source, "source bytes", "utf8");
      writeFileSync(destination, "private bytes", "utf8");

      const result = applyMemoryLink(f.options);
      expect(result.linked).toBe(false);
      expect(result.conflicts).toContain("WORK/conflict.md: destination content differs from active-runtime");
      expect(readFileSync(source, "utf8")).toBe("source bytes");
      expect(readFileSync(destination, "utf8")).toBe("private bytes");
      expect(existsSync(join(f.runtimeMemory, "WORK", "legacy.md"))).toBe(false);
    } finally { f.dispose(); }
  });

  test("blocks hard-linked destination files without changing their outside alias", () => {
    const f = fixture();
    try {
      const source = join(f.runtimeMemory, "WORK", "linked.md");
      const destination = join(f.privateMemory, "WORK", "linked.md");
      const outsideAlias = join(f.home, ".claude", "LIFEOS", "tracked.md");
      mkdirSync(join(f.runtimeMemory, "WORK"), { recursive: true });
      mkdirSync(join(f.home, ".claude", "LIFEOS"), { recursive: true });
      mkdirSync(join(f.privateMemory, "WORK"), { recursive: true });
      writeFileSync(source, "identical tracked content", "utf8");
      writeFileSync(outsideAlias, "identical tracked content", "utf8");
      linkSync(outsideAlias, destination);

      const result = applyMemoryLink(f.options);
      expect(result.action).toBe("blocked");
      expect(result.linked).toBe(false);
      expect(result.conflicts).toContain("WORK/linked.md: destination is hard-linked outside private MEMORY");
      expect(lstatSync(f.runtimeMemory).isSymbolicLink()).toBe(false);
      expect(readFileSync(outsideAlias, "utf8")).toBe("identical tracked content");
      expect(readFileSync(source, "utf8")).toBe("identical tracked content");
    } finally { f.dispose(); }
  });

  test("blocks migration through a symlinked private USER ancestor", () => {
    const f = fixture();
    try {
      const source = join(f.runtimeMemory, "WORK", "keep.md");
      const external = join(f.home, "external-private-target");
      const userDir = join(f.options.configDir, "USER");
      mkdirSync(join(f.runtimeMemory, "WORK"), { recursive: true });
      writeFileSync(source, "preserve me", "utf8");
      rmSync(userDir, { recursive: true, force: true });
      mkdirSync(external, { recursive: true });
      symlinkSync(external, userDir, process.platform === "win32" ? "junction" : "dir");

      const result = applyMemoryLink(f.options);
      expect(result.action).toBe("blocked");
      expect(result.errors.join(" ")).toContain("private data path contains a symlink");
      expect(readFileSync(source, "utf8")).toBe("preserve me");
      expect(existsSync(join(external, "MEMORY"))).toBe(false);
      expect(lstatSync(f.runtimeMemory).isSymbolicLink()).toBe(false);
    } finally { f.dispose(); }
  });

  test("reports source paths that collide on Windows before copying", () => {
    const f = fixture();
    try {
      const activeFile = join(f.runtimeMemory, "WORK", "Note.md");
      const legacyFile = join(f.legacyMemory, "WORK", "note.md");
      mkdirSync(join(f.runtimeMemory, "WORK"), { recursive: true });
      mkdirSync(join(f.legacyMemory, "WORK"), { recursive: true });
      writeFileSync(activeFile, "active", "utf8");
      writeFileSync(legacyFile, "legacy", "utf8");

      const preview = previewMemoryLink({ ...f.options, platform: "win32" });
      expect(preview.action).toBe("blocked");
      expect(preview.conflicts).toContain("WORK/note.md: path collides with WORK/Note.md on Windows");
      expect(existsSync(f.privateMemory)).toBe(false);
    } finally { f.dispose(); }
  });

  test("refuses a wrong runtime link and leaves it untouched", () => {
    const f = fixture();
    try {
      const wrongTarget = join(f.home, "wrong-target");
      mkdirSync(wrongTarget, { recursive: true });
      writeFileSync(join(wrongTarget, "marker.md"), "still here", "utf8");
      rmSync(f.runtimeMemory, { recursive: true, force: true });
      symlinkSync(wrongTarget, f.runtimeMemory, process.platform === "win32" ? "junction" : "dir");
      const preview = previewMemoryLink(f.options);
      expect(preview.action).toBe("blocked");
      expect(preview.errors.join(" ")).toContain("incorrectly targeted link");
      expect(readFileSync(join(wrongTarget, "marker.md"), "utf8")).toBe("still here");
      expect(existsSync(f.runtimeMemory)).toBe(true);
    } finally { f.dispose(); }
  });

  test("refuses a broken runtime link without replacing it", () => {
    const f = fixture();
    try {
      const target = join(f.home, "link-target");
      mkdirSync(target, { recursive: true });
      rmSync(f.runtimeMemory, { recursive: true, force: true });
      symlinkSync(target, f.runtimeMemory, process.platform === "win32" ? "junction" : "dir");
      rmSync(target, { recursive: true, force: true });

      const preview = previewMemoryLink(f.options);
      expect(preview.action).toBe("blocked");
      expect(preview.errors.join(" ")).toContain("broken or incorrectly targeted link");
      expect(lstatSync(f.runtimeMemory).isSymbolicLink()).toBe(true);
    } finally { f.dispose(); }
  });
});
