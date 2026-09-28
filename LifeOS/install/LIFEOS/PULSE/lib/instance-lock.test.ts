import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, InstanceLockConflictError, type InstanceLockMetadata } from "./instance-lock";

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
    metadata: { pid: 101, instanceId: "owner-a", runtimeRoot: join(root, "LIFEOS"), startedAt: "2026-01-01T00:00:00.000Z" },
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
});
