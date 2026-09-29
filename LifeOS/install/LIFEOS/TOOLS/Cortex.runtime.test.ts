import { describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { hostname, tmpdir } from "node:os";
import { join, relative } from "node:path";

describe("Codex Cortex runtime integration", () => {
  test("writes a Blog through the Codex MEMORY junction and returns it from Pulse Cortex", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-cortex-codex-"));
    const codexRoot = join(home, ".codex");
    const claudeRoot = join(home, ".claude");
    const privateMemory = join(home, ".config", "LIFEOS", "USER", "MEMORY");
    const codexMemory = join(codexRoot, "LIFEOS", "MEMORY");
    const slug = "the-link-between-your-workplace-situation-and-your-mental-health";
    const decoyNote = join(claudeRoot, "LIFEOS", "MEMORY", "KNOWLEDGE", "Blogs", `${slug}.md`);
    try {
      mkdirSync(privateMemory, { recursive: true });
      mkdirSync(codexRoot, { recursive: true });
      mkdirSync(join(codexRoot, "LIFEOS"), { recursive: true });
      symlinkSync(privateMemory, codexMemory, "junction");
      mkdirSync(join(claudeRoot, "LIFEOS", "MEMORY", "KNOWLEDGE", "Blogs"), { recursive: true });
      writeFileSync(decoyNote, "decoy archive must remain unchanged\n", "utf8");

      const item = {
        type: "knowledge",
        entity_type: "blog",
        name: "The Link Between Your Workplace Situation and Your Mental Health",
        content: "The article connects workplace conditions with mental health and treats work as a meaningful health factor.",
        source_url: "https://newsletter.danielmiessler.com/p/the-link-between-your-workplace-situation-and-your-mental-health",
        source_name: "Daniel Miessler",
        source_author: "Daniel Miessler",
        source_date: "2026-08-31",
      };
      const helper = join(import.meta.dir, "CortexCodexIntegrationProbe.ts");
      const env = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CODEX_HOME: codexRoot,
        CODEX_THREAD_ID: "isolated-integration-test",
        CLAUDE_CONFIG_DIR: claudeRoot,
        LIFEOS_DIR: join(claudeRoot, "LIFEOS"),
      };
      delete env.CORTEX_MEMORY_ROOT;
      const result = spawnSync(process.execPath, [
        helper,
        "remember", "--adapter", "codex", "--allow-write", JSON.stringify(item),
      ], { cwd: process.cwd(), env, encoding: "utf8", windowsHide: true });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const output = JSON.parse(result.stdout.trim());
      expect(output.cortex.exitCode).toBe(0);
      expect(output.cortex.envelope.ok).toBe(true);
      expect(output.harvester.status).toBe(0);
      expect(output.harvester.stderr).toBe("");
      const savedPath = output.cortex.envelope.data.result.path as string;
      expect(savedPath.startsWith(codexMemory)).toBe(true);
      expect(relative(privateMemory, realpathSync(savedPath))).not.toMatch(/^\.\./);
      expect(readFileSync(decoyNote, "utf8")).toBe("decoy archive must remain unchanged\n");

      expect(output.wiki).not.toBeNull();
      expect(output.wiki.category).toBe("blog");
      expect(output.wiki.title).toBe(item.name);
      expect(output.wiki.author).toBe("Daniel Miessler");
      expect(output.wiki.postDate).toBe("2026-08-31");
      expect(output.wiki.sourceUrl).toBe(item.source_url);
      expect(output.wiki.related).toEqual([]);
      expect(output.wiki.content).toContain("related: []");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("rejects invalid Blog source metadata without creating a note", () => {
    const invalidItems = [
      { source_url: "https://example.com/article", source_date: "2026-08-31" },
      { source_url: "file:///private/article", source_author: "Author", source_date: "2026-08-31" },
      { source_url: "https://example.com/article", source_author: "Author", source_date: "2026-02-30" },
    ];

    for (const metadata of invalidItems) {
      const home = mkdtempSync(join(tmpdir(), "lifeos-cortex-invalid-blog-"));
      const codexRoot = join(home, ".codex");
      const claudeRoot = join(home, ".claude");
      const privateMemory = join(home, ".config", "LIFEOS", "USER", "MEMORY");
      const codexMemory = join(codexRoot, "LIFEOS", "MEMORY");
      const slug = "invalid-blog-metadata-must-not-write";
      try {
        mkdirSync(privateMemory, { recursive: true });
        mkdirSync(join(codexRoot, "LIFEOS"), { recursive: true });
        symlinkSync(privateMemory, codexMemory, "junction");
        const item = {
          type: "knowledge", entity_type: "blog", name: "Invalid Blog Metadata Must Not Write",
          content: "This item must fail validation before storage.",
          related: [], ...metadata,
        };
        const result = spawnSync(process.execPath, [
          join(import.meta.dir, "CortexCodexIntegrationProbe.ts"),
          "remember", "--adapter", "codex", "--allow-write", JSON.stringify(item),
        ], {
          cwd: process.cwd(), env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            CODEX_HOME: codexRoot,
            CODEX_THREAD_ID: "invalid-blog-metadata-test",
            CLAUDE_CONFIG_DIR: claudeRoot,
            LIFEOS_DIR: join(claudeRoot, "LIFEOS"),
          },
          encoding: "utf8", windowsHide: true,
        });

        expect(result.status).toBe(0);
        const output = JSON.parse(result.stdout.trim());
        expect(output.cortex.exitCode).toBe(5);
        expect(output.cortex.envelope.ok).toBe(false);
        expect(existsSync(join(privateMemory, "KNOWLEDGE", "Blogs", `${slug}.md`))).toBe(false);
        expect(output.wiki.error).toContain("not found");
      } finally { rmSync(home, { recursive: true, force: true }); }
    }
  });

  test("does not write Tier B audit metadata through a redirected OBSERVABILITY directory", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-cortex-audit-boundary-"));
    const codexRoot = join(home, ".codex");
    const claudeRoot = join(home, ".claude");
    const privateMemory = join(home, ".config", "LIFEOS", "USER", "MEMORY");
    const codexMemory = join(codexRoot, "LIFEOS", "MEMORY");
    const outsideObservability = join(home, "outside", "OBSERVABILITY");
    const externalAudit = join(outsideObservability, "tier-b-writes.jsonl");
    try {
      mkdirSync(privateMemory, { recursive: true });
      mkdirSync(join(codexRoot, "LIFEOS"), { recursive: true });
      mkdirSync(outsideObservability, { recursive: true });
      symlinkSync(privateMemory, codexMemory, "junction");
      symlinkSync(outsideObservability, join(privateMemory, "OBSERVABILITY"), "junction");
      const item = {
        type: "knowledge", entity_type: "blog", name: "Audited Blog With Redirected Log",
        content: "The note itself belongs inside the private store.",
        source_url: "https://example.com/audited-blog",
        source_author: "Example Author",
        source_date: "2026-08-31",
        related: [],
      };
      const result = spawnSync(process.execPath, [
        join(import.meta.dir, "CortexCodexIntegrationProbe.ts"),
        "remember", "--adapter", "codex", "--allow-write", JSON.stringify(item),
      ], {
        cwd: process.cwd(), env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codexRoot,
          CODEX_THREAD_ID: "audit-log-boundary-test",
          CLAUDE_CONFIG_DIR: claudeRoot,
          LIFEOS_DIR: join(claudeRoot, "LIFEOS"),
        },
        encoding: "utf8", windowsHide: true,
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.cortex.envelope.ok).toBe(true);
      expect(output.cortex.envelope.data.result.path.startsWith(codexMemory)).toBe(true);
      expect(existsSync(externalAudit)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("does not append Tier B audit metadata through a hard link into the Claude tree", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-cortex-audit-hardlink-"));
    const codexRoot = join(home, ".codex");
    const claudeRoot = join(home, ".claude");
    const privateMemory = join(home, ".config", "LIFEOS", "USER", "MEMORY");
    const codexMemory = join(codexRoot, "LIFEOS", "MEMORY");
    const observability = join(privateMemory, "OBSERVABILITY");
    const auditLog = join(observability, "tier-b-writes.jsonl");
    const trackedFile = join(claudeRoot, "LIFEOS", "tracked-audit.md");
    try {
      mkdirSync(join(codexRoot, "LIFEOS"), { recursive: true });
      mkdirSync(observability, { recursive: true });
      mkdirSync(join(claudeRoot, "LIFEOS"), { recursive: true });
      symlinkSync(privateMemory, codexMemory, "junction");
      writeFileSync(trackedFile, "tracked audit target\n", "utf8");
      linkSync(trackedFile, auditLog);
      const item = {
        type: "knowledge", entity_type: "blog", name: "Blog With Hard-Linked Audit Log",
        content: "The note itself belongs inside the private store.",
        source_url: "https://example.com/hard-linked-audit",
        source_author: "Example Author", source_date: "2026-08-31", related: [],
      };
      const result = spawnSync(process.execPath, [
        join(import.meta.dir, "CortexCodexIntegrationProbe.ts"),
        "remember", "--adapter", "codex", "--allow-write", JSON.stringify(item),
      ], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
        env: {
          ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexRoot,
          CODEX_THREAD_ID: "audit-hardlink-test", CLAUDE_CONFIG_DIR: claudeRoot,
          LIFEOS_DIR: join(claudeRoot, "LIFEOS"),
        },
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.cortex.envelope.ok).toBe(true);
      expect(readFileSync(trackedFile, "utf8")).toBe("tracked audit target\n");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("does not write lock metadata through a redirected OBSERVABILITY directory", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-cortex-lock-boundary-"));
    const codexRoot = join(home, ".codex");
    const claudeRoot = join(home, ".claude");
    const privateMemory = join(home, ".config", "LIFEOS", "USER", "MEMORY");
    const codexMemory = join(codexRoot, "LIFEOS", "MEMORY");
    const outsideObservability = join(home, "outside", "OBSERVABILITY");
    const externalLockLog = join(outsideObservability, "memory-locks.jsonl");
    const blogDir = join(privateMemory, "KNOWLEDGE", "Blogs");
    const slug = "locked-blog-with-redirected-lock-log";
    try {
      mkdirSync(blogDir, { recursive: true });
      mkdirSync(join(codexRoot, "LIFEOS"), { recursive: true });
      mkdirSync(outsideObservability, { recursive: true });
      symlinkSync(privateMemory, codexMemory, "junction");
      symlinkSync(outsideObservability, join(privateMemory, "OBSERVABILITY"), "junction");
      writeFileSync(join(blogDir, `${slug}.md.lock`), JSON.stringify({
        pid: process.pid,
        host: hostname(),
        ts: new Date().toISOString(),
      }), "utf8");
      const item = {
        type: "knowledge", entity_type: "blog", name: "Locked Blog With Redirected Lock Log",
        content: "The active lock should refuse this note without leaking metadata.",
        source_url: "https://example.com/locked-blog",
        source_author: "Example Author",
        source_date: "2026-08-31",
        related: [],
      };
      const result = spawnSync(process.execPath, [
        join(import.meta.dir, "CortexCodexIntegrationProbe.ts"),
        "remember", "--adapter", "codex", "--allow-write", JSON.stringify(item),
      ], {
        cwd: process.cwd(), env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codexRoot,
          CODEX_THREAD_ID: "lock-log-boundary-test",
          CLAUDE_CONFIG_DIR: claudeRoot,
          LIFEOS_DIR: join(claudeRoot, "LIFEOS"),
        },
        encoding: "utf8", windowsHide: true,
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.cortex.exitCode).toBe(5);
      expect(output.cortex.envelope.ok).toBe(false);
      expect(existsSync(externalLockLog)).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("does not append lock metadata through a hard link into the Claude tree", () => {
    const home = mkdtempSync(join(tmpdir(), "lifeos-cortex-lock-hardlink-"));
    const codexRoot = join(home, ".codex");
    const claudeRoot = join(home, ".claude");
    const privateMemory = join(home, ".config", "LIFEOS", "USER", "MEMORY");
    const codexMemory = join(codexRoot, "LIFEOS", "MEMORY");
    const observability = join(privateMemory, "OBSERVABILITY");
    const externalLock = join(claudeRoot, "LIFEOS", "tracked-lock.md");
    const lockLog = join(observability, "memory-locks.jsonl");
    const blogDir = join(privateMemory, "KNOWLEDGE", "Blogs");
    const slug = "locked-blog-with-hard-linked-lock-log";
    try {
      mkdirSync(blogDir, { recursive: true });
      mkdirSync(observability, { recursive: true });
      mkdirSync(join(codexRoot, "LIFEOS"), { recursive: true });
      mkdirSync(join(claudeRoot, "LIFEOS"), { recursive: true });
      symlinkSync(privateMemory, codexMemory, "junction");
      writeFileSync(externalLock, "tracked lock target\n", "utf8");
      linkSync(externalLock, lockLog);
      writeFileSync(join(blogDir, `${slug}.md.lock`), JSON.stringify({
        pid: process.pid, host: hostname(), ts: new Date().toISOString(),
      }), "utf8");
      const item = {
        type: "knowledge", entity_type: "blog", name: "Locked Blog With Hard-Linked Lock Log",
        content: "The active lock should refuse this note without leaking metadata.",
        source_url: "https://example.com/hard-linked-lock",
        source_author: "Example Author", source_date: "2026-08-31", related: [],
      };
      const result = spawnSync(process.execPath, [
        join(import.meta.dir, "CortexCodexIntegrationProbe.ts"),
        "remember", "--adapter", "codex", "--allow-write", JSON.stringify(item),
      ], {
        cwd: process.cwd(), encoding: "utf8", windowsHide: true,
        env: {
          ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexRoot,
          CODEX_THREAD_ID: "lock-hardlink-test", CLAUDE_CONFIG_DIR: claudeRoot,
          LIFEOS_DIR: join(claudeRoot, "LIFEOS"),
        },
      });

      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout.trim());
      expect(output.cortex.exitCode).toBe(5);
      expect(output.cortex.envelope.ok).toBe(false);
      expect(readFileSync(externalLock, "utf8")).toBe("tracked lock target\n");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
