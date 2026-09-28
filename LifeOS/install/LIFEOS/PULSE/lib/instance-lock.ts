import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";

export interface InstanceLockMetadata {
  pid: number;
  instanceId: string;
  runtimeRoot: string;
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

/**
 * Atomically acquire the per-runtime Pulse lock. A dead or malformed owner is
 * reclaimed once; a live owner is never replaced. Release removes only the
 * caller's own instance, so an old process cannot delete a successor's lock.
 */
export function acquireInstanceLock(
  path: string,
  metadata: InstanceLockMetadata,
  isAlive: (pid: number) => boolean = processIsAlive,
): InstanceLockHandle {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeFileSync(fd, `${JSON.stringify(metadata, null, 2)}\n`);
      } finally {
        closeSync(fd);
      }
      return {
        metadata,
        release() {
          try {
            const current = JSON.parse(readFileSync(path, "utf8")) as Partial<InstanceLockMetadata>;
            if (current.instanceId === metadata.instanceId) unlinkSync(path);
          } catch {
            // Missing, malformed, or already replaced: this process no longer owns it.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: Partial<InstanceLockMetadata> = {};
      try {
        existing = JSON.parse(readFileSync(path, "utf8")) as Partial<InstanceLockMetadata>;
      } catch {
        // A malformed lock has no verifiable live owner and is treated as stale.
      }
      if (typeof existing.pid === "number" && isAlive(existing.pid)) {
        throw new InstanceLockConflictError(existing);
      }
      try {
        unlinkSync(path);
      } catch {
        // Another starter may have reclaimed or replaced it; the second attempt
        // will either acquire the path or report that live owner.
      }
    }
  }
  throw new Error(`unable to acquire Pulse lock: ${path}`);
}
