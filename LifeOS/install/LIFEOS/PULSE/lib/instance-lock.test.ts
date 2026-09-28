import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireInstanceLock, INSTANCE_LOCK_SCHEMA_VERSION, InstanceLockConflictError, type InstanceLockMetadata } from "./instance-lock";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): { root: string; path: string; metadata: InstanceLockMetadata } {
  const root = mkdtempSync(join(tmpdir(), "pulse-lock-"));
  roots.push(root);
  return {
    root,
    path: join(root, "pulse.lock.json"),
    metadata: {
      schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION,
      pid: 101,
      instanceId: "owner-a",
      runtimeRoot: join(root, "LIFEOS"),
      configPath: join(root, "external", "LIFEOS_CONFIG.toml"),
      executablePath: process.execPath,
      scriptPath: join(root, "LIFEOS", "PULSE", "pulse.ts"),
      processStartedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:00.000Z",
    },
  };
}

describe("Pulse instance lock", () => {
  test("acquires atomically and releases only its own lock", () => {
    const { path, metadata } = fixture();
    const handle = acquireInstanceLock(path, metadata, () => false);
    expect(JSON.parse(readFileSync(path, "utf8")).instanceId).toBe("owner-a");
    writeFileSync(path, JSON.stringify({ ...metadata, instanceId: "owner-b" }));
    handle.release();
    expect(existsSync(path)).toBe(true);
  });

  test("refuses to replace a live owner on POSIX-compatible PID semantics", () => {
    const { path, metadata } = fixture();
    const handle = acquireInstanceLock(path, metadata, () => false);
    expect(() => acquireInstanceLock(path, { ...metadata, pid: 202, instanceId: "owner-b" }, (pid) => pid === 101))
      .toThrow(InstanceLockConflictError);
    expect(JSON.parse(readFileSync(path, "utf8")).instanceId).toBe("owner-a");
    handle.release();
  });

  test("reclaims a stale owner", () => {
    const { path, metadata } = fixture();
    writeFileSync(path, JSON.stringify({ ...metadata, pid: 99, instanceId: "stale" }));
    const handle = acquireInstanceLock(path, metadata, () => false);
    expect(JSON.parse(readFileSync(path, "utf8")).instanceId).toBe("owner-a");
    handle.release();
    expect(existsSync(path)).toBe(false);
  });

  test("recovers from a malformed stale lock", () => {
    const { path, metadata } = fixture();
    writeFileSync(path, "not-json");
    const handle = acquireInstanceLock(path, metadata, () => false);
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(101);
    handle.release();
  });

  test("publishes only complete JSON to a competing starter", () => {
    const { path, metadata } = fixture();
    const handle = acquireInstanceLock(path, metadata, () => false);
    expect(() => acquireInstanceLock(path, { ...metadata, pid: 202, instanceId: "owner-b" }, (pid) => pid === 101))
      .toThrow(InstanceLockConflictError);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(metadata);
    handle.release();
  });

  test("waits through a grace period before reclaiming a legacy incomplete lock", () => {
    const { path, metadata } = fixture();
    writeFileSync(path, "");
    const started = Date.now();
    const handle = acquireInstanceLock(path, metadata, () => false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(metadata);
    handle.release();
  });

  test("allows exactly one of two simultaneous real processes to own the lock", async () => {
    const { root, path } = fixture();
    const runner = join(root, "contender.ts");
    const moduleUrl = pathToFileURL(join(import.meta.dir, "instance-lock.ts")).href;
    writeFileSync(runner, `
      import { acquireInstanceLock, INSTANCE_LOCK_SCHEMA_VERSION, InstanceLockConflictError } from ${JSON.stringify(moduleUrl)};
      const [lockPath, id] = process.argv.slice(2);
      try {
        const handle = acquireInstanceLock(lockPath, {
          schemaVersion: INSTANCE_LOCK_SCHEMA_VERSION,
          pid: process.pid,
          instanceId: id,
          runtimeRoot: ${JSON.stringify(root)},
          configPath: ${JSON.stringify(join(root, "config.toml"))},
          executablePath: process.execPath,
          scriptPath: import.meta.path,
          processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
          startedAt: new Date().toISOString(),
        });
        console.log("acquired:" + id);
        await Bun.sleep(750);
        handle.release();
      } catch (error) {
        if (error instanceof InstanceLockConflictError) console.log("conflict:" + id);
        else throw error;
      }
    `);
    const contenders = ["a", "b"].map((id) => Bun.spawn(
      [process.execPath, "run", runner, path, id],
      { stdout: "pipe", stderr: "pipe" },
    ));
    const outputs = await Promise.all(contenders.map(async (child) => {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      return stdout.trim();
    }));
    expect(outputs.filter((line) => line.startsWith("acquired:"))).toHaveLength(1);
    expect(outputs.filter((line) => line.startsWith("conflict:"))).toHaveLength(1);
  });
});
