import { describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("assertInsideUserData", () => {
  test("rejects a hard-linked append target before it can mutate an outside alias", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-foreign-hardlink-"));
    const userData = join(home, ".config", "LIFEOS", "USER");
    const observability = join(userData, "MEMORY", "OBSERVABILITY");
    const systemFile = join(home, ".claude", "LIFEOS", "tracked.md");
    const targetPath = join(observability, "pending-proposals.jsonl");
    try {
      mkdirSync(observability, { recursive: true });
      mkdirSync(join(home, ".claude", "LIFEOS"), { recursive: true });
      writeFileSync(systemFile, "tracked system content\n", "utf8");
      linkSync(systemFile, targetPath);

      const modulePath = join(import.meta.dir, "ForeignDataCheck.ts").replaceAll("\\", "/");
      const probe = [
        `import { assertInsideUserData } from ${JSON.stringify(modulePath)};`,
        `import { appendFileSync } from "node:fs";`,
        `const result = assertInsideUserData(${JSON.stringify(targetPath)});`,
        `let escapedWrite = false;`,
        `if (result.ok) { appendFileSync(${JSON.stringify(targetPath)}, "personal proposal\\n"); escapedWrite = true; }`,
        `process.stdout.write(JSON.stringify({ result, escapedWrite }));`,
      ].join("\n");
      const child = spawnSync(process.execPath, ["-e", probe], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });

      expect(child.status).toBe(0);
      const output = JSON.parse(child.stdout) as { result: { ok: boolean; reason?: string }; escapedWrite: boolean };
      expect(output.result.ok).toBe(false);
      expect(output.result.reason).toContain("multiple hard links");
      expect(output.escapedWrite).toBe(false);
      expect(readFileSync(systemFile, "utf8")).toBe("tracked system content\n");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test.skipIf(process.platform === "win32")("rejects a leaf symlink to an in-root hard link before appending", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-foreign-hardlink-symlink-"));
    const userData = join(home, ".config", "LIFEOS", "USER");
    const observability = join(userData, "MEMORY", "OBSERVABILITY");
    const internalAlias = join(observability, "queue-target.jsonl");
    const systemFile = join(home, ".claude", "LIFEOS", "tracked.md");
    const targetPath = join(observability, "pending-proposals.jsonl");
    try {
      mkdirSync(observability, { recursive: true });
      mkdirSync(join(home, ".claude", "LIFEOS"), { recursive: true });
      writeFileSync(systemFile, "tracked system content\n", "utf8");
      linkSync(systemFile, internalAlias);
      symlinkSync(internalAlias, targetPath);

      const modulePath = join(import.meta.dir, "ForeignDataCheck.ts").replaceAll("\\", "/");
      const probe = [
        `import { assertInsideUserData } from ${JSON.stringify(modulePath)};`,
        `import { appendFileSync } from "node:fs";`,
        `const result = assertInsideUserData(${JSON.stringify(targetPath)});`,
        `let escapedWrite = false;`,
        `if (result.ok) { appendFileSync(${JSON.stringify(targetPath)}, "personal proposal\\n"); escapedWrite = true; }`,
        `process.stdout.write(JSON.stringify({ result, escapedWrite }));`,
      ].join("\n");
      const child = spawnSync(process.execPath, ["-e", probe], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });

      expect(child.status).toBe(0);
      const output = JSON.parse(child.stdout) as { result: { ok: boolean; reason?: string }; escapedWrite: boolean };
      expect(output.result.ok).toBe(false);
      expect(output.result.reason).toContain("multiple hard links");
      expect(output.escapedWrite).toBe(false);
      expect(readFileSync(systemFile, "utf8")).toBe("tracked system content\n");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("rejects a dangling junction before an append can escape USER_DATA", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-foreign-boundary-"));
    const userData = join(home, ".config", "LIFEOS", "USER");
    const observability = join(userData, "MEMORY", "OBSERVABILITY");
    const outside = join(home, "outside");
    const lateDirectory = join(outside, "late");
    const escapedFile = join(lateDirectory, "pending-proposals.jsonl");
    try {
      mkdirSync(join(userData, "MEMORY"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(lateDirectory, observability, process.platform === "win32" ? "junction" : "dir");

      const modulePath = join(import.meta.dir, "ForeignDataCheck.ts").replaceAll("\\", "/");
      const targetPath = join(observability, "pending-proposals.jsonl");
      const probe = [
        `import { assertInsideUserData } from ${JSON.stringify(modulePath)};`,
        `import { appendFileSync, mkdirSync } from "node:fs";`,
        `process.env.HOME = ${JSON.stringify(home)};`,
        `process.env.USERPROFILE = ${JSON.stringify(home)};`,
        `const result = assertInsideUserData(${JSON.stringify(targetPath)});`,
        `let escapedWrite = false;`,
        `if (result.ok) { mkdirSync(${JSON.stringify(lateDirectory)}, { recursive: true }); appendFileSync(${JSON.stringify(targetPath)}, "escaped\\n"); escapedWrite = true; }`,
        `process.stdout.write(JSON.stringify({ result, escapedWrite }));`,
      ].join("\n");
      const child = spawnSync(process.execPath, ["-e", probe], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });

      expect(child.status).toBe(0);
      const output = JSON.parse(child.stdout) as { result: { ok: boolean; reason?: string }; escapedWrite: boolean };
      expect(output.result.ok).toBe(false);
      expect(output.result.reason).toContain("cannot resolve");
      expect(output.escapedWrite).toBe(false);
      expect(existsSync(escapedFile)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("rejects a symlinked USER_DATA root instead of trusting its destination", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-foreign-root-"));
    const configDir = join(home, ".config");
    const lifeosConfigDir = join(configDir, "LIFEOS");
    const userData = join(lifeosConfigDir, "USER");
    const systemTree = join(home, ".claude", "LIFEOS");
    const systemMemory = join(systemTree, "MEMORY");
    const targetPath = join(userData, "MEMORY", "note.jsonl");
    try {
      mkdirSync(lifeosConfigDir, { recursive: true });
      mkdirSync(systemMemory, { recursive: true });
      symlinkSync(systemTree, userData, process.platform === "win32" ? "junction" : "dir");

      const modulePath = join(import.meta.dir, "ForeignDataCheck.ts").replaceAll("\\", "/");
      const probe = [
        `import { assertInsideUserData } from ${JSON.stringify(modulePath)};`,
        `process.stdout.write(JSON.stringify(assertInsideUserData(${JSON.stringify(targetPath)})));`,
      ].join("\n");
      const child = spawnSync(process.execPath, ["-e", probe], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });

      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout) as { ok: boolean; reason?: string };
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("USER_DATA path contains a symlink");
      expect(existsSync(join(systemMemory, "note.jsonl"))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
