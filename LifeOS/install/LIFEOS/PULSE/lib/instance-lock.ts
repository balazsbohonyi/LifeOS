import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const INSTANCE_LOCK_SCHEMA_VERSION = 2;

export interface InstanceLockMetadata {
  schemaVersion: typeof INSTANCE_LOCK_SCHEMA_VERSION;
  pid: number;
  instanceId: string;
  runtimeRoot: string;
  configPath: string;
  executablePath: string;
  scriptPath: string;
  processStartedAt: string;
  launcherPid?: number;
  launcherExecutablePath?: string;
  launcherScriptPath?: string;
  launcherStartedAt?: string;
  startedAt: string;
}

export interface InstanceLockHandle {
  metadata: InstanceLockMetadata;
  release(): void;
}

export class InstanceLockConflictError extends Error {
  constructor(public readonly existing: Partial<InstanceLockMetadata>) {
    super(`another Pulse instance owns this user session: ${JSON.stringify(existing)}`);
    this.name = "InstanceLockConflictError";
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(milliseconds: number): void {
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function readMetadata(path: string): Partial<InstanceLockMetadata> | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Partial<InstanceLockMetadata>;
  } catch {
    return null;
  }
}

function uniqueSibling(path: string, purpose: string): string {
  return join(dirname(path), `.${purpose}-${process.pid}-${crypto.randomUUID()}.tmp`);
}

function acquireMutationGuard(path: string): { fd: number; path: string } | null {
  const guardPath = `${path}.reclaim`;
  try {
    return { fd: openSync(guardPath, "wx"), path: guardPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A starter can die while holding this very short guard. Reclaim only a
    // guard old enough that no live link/rename operation should remain.
    try {
      if (Date.now() - statSync(guardPath).mtimeMs > 5_000) unlinkSync(guardPath);
    } catch { /* another starter cleaned it */ }
    return null;
  }
}

function releaseMutationGuard(guard: { fd: number; path: string }): void {
  closeSync(guard.fd);
  try { unlinkSync(guard.path); } catch { /* another cleanup already won */ }
}

/** Publish complete JSON in one namespace operation. */
function publish(path: string, metadata: InstanceLockMetadata): boolean {
  const temporary = uniqueSibling(path, "pulse-lock-publish");
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: "wx" });
  const guard = acquireMutationGuard(path);
  try {
    if (!guard) return false;
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    if (guard) releaseMutationGuard(guard);
    try { unlinkSync(temporary); } catch { /* best-effort temporary cleanup */ }
  }
}

/** Serialize stale reclamation and verify the identity immediately beforehand. */
function reclaim(path: string, expected: Partial<InstanceLockMetadata>, isAlive: (pid: number) => boolean): boolean {
  const guard = acquireMutationGuard(path);
  if (!guard) return false;

  const quarantine = uniqueSibling(path, "pulse-lock-stale");
  let removeQuarantine = true;
  try {
    const current = readMetadata(path);
    if ((current?.instanceId ?? null) !== (expected.instanceId ?? null)) return false;
    try {
      renameSync(path, quarantine);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const moved = readMetadata(quarantine);
    if (moved && typeof moved.pid === "number" && isAlive(moved.pid)) {
      // A legacy writer finished after our last read. Put its now-verifiable
      // live lock back instead of deleting it as stale.
      try { linkSync(quarantine, path); } catch { removeQuarantine = false; }
      return false;
    }
    return true;
  } finally {
    try { if (removeQuarantine && existsSync(quarantine)) unlinkSync(quarantine); } catch { /* best effort */ }
    releaseMutationGuard(guard);
  }
}

/**
 * Acquire the per-runtime Pulse lock. A complete temporary document is hard
 * linked into the public name, so readers never observe an empty lock. Stale
 * reclamation is serialized and identity-checked; release removes only this
 * instance, so an old process cannot delete a successor's lock.
 */
export function acquireInstanceLock(
  path: string,
  metadata: InstanceLockMetadata,
  isAlive: (pid: number) => boolean = processIsAlive,
): InstanceLockHandle {
  const malformedGraceMs = 500;
  const deadline = Date.now() + malformedGraceMs;

  for (let attempt = 0; attempt < 40; attempt++) {
    if (publish(path, metadata)) {
      return {
        metadata,
        release() {
          const current = readMetadata(path);
          if (current?.instanceId !== metadata.instanceId) return;
          const released = uniqueSibling(path, "pulse-lock-release");
          try {
            renameSync(path, released);
            const moved = readMetadata(released);
            if (moved?.instanceId !== metadata.instanceId) {
              try { linkSync(released, path); } catch { /* preserve successor */ }
            }
          } catch {
            return;
          } finally {
            try { if (existsSync(released)) unlinkSync(released); } catch { /* best effort */ }
          }
        },
      };
    }

    const existing = readMetadata(path);
    if (existing && typeof existing.pid === "number") {
      if (isAlive(existing.pid)) throw new InstanceLockConflictError(existing);
      if (reclaim(path, existing, isAlive)) continue;
    } else {
      // Legacy implementations exposed an empty file before writing it. Give
      // a fresh/incomplete lock a bounded grace period instead of deleting it.
      let fresh = true;
      try { fresh = Date.now() - statSync(path).mtimeMs < malformedGraceMs; } catch { fresh = false; }
      if (fresh && Date.now() < deadline) {
        sleepSync(25);
        continue;
      }
      if (reclaim(path, existing ?? {}, isAlive)) continue;
    }
    sleepSync(10);
  }
  throw new Error(`unable to acquire Pulse lock safely: ${path}`);
}
