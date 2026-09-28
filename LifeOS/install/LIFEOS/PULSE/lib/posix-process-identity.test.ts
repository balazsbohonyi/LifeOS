import { describe, expect, test } from "bun:test";
import {
  PROCESS_START_TOLERANCE_MS,
  validateHealthIdentity,
  validateOwnedProcessIdentity,
  type ExpectedPulseIdentity,
  type LiveProcessIdentity,
  type PulseIdentityDocument,
} from "./posix-process-identity.ts";

const expected: ExpectedPulseIdentity = {
  runtimeRoot: "/srv/life os/LIFEOS",
  configPath: "/srv/life os/private/LIFEOS_CONFIG.toml",
  scriptPath: "/srv/life os/LIFEOS/PULSE/pulse.ts",
  executablePath: "/opt/bun/bin/bun",
};

const lock: PulseIdentityDocument = {
  pid: 4242,
  instanceId: "instance-one",
  ...expected,
  processStartedAt: "2026-09-29T08:00:00.000Z",
};

const live: LiveProcessIdentity = {
  pid: lock.pid,
  executablePath: lock.executablePath,
  command: `${lock.executablePath} run ${lock.scriptPath}`,
  startedAt: "2026-09-29T08:00:03.000Z",
};

describe("POSIX Pulse live identity", () => {
  test("accepts complete lock/live process ownership within the start-time tolerance", () => {
    expect(validateOwnedProcessIdentity(lock, expected, live)).toEqual({ ok: true });
  });

  test("rejects PID reuse when the live process start identity differs", () => {
    const reused = {
      ...live,
      startedAt: new Date(Date.parse(lock.processStartedAt) + PROCESS_START_TOLERANCE_MS + 1).toISOString(),
    };
    expect(validateOwnedProcessIdentity(lock, expected, reused)).toEqual({
      ok: false,
      reason: "process start identity mismatch",
    });
  });

  test("rejects a live executable or command that does not match the lock", () => {
    expect(validateOwnedProcessIdentity(lock, expected, { ...live, executablePath: "/usr/bin/other" }).ok).toBe(false);
    expect(validateOwnedProcessIdentity(lock, expected, { ...live, command: "/opt/bun/bin/bun run unrelated.ts" }).ok).toBe(false);
  });

  test("rejects a lock owned by a different executable than the selected service runtime", () => {
    expect(validateOwnedProcessIdentity(
      { ...lock, executablePath: "/other/bun" },
      expected,
      { ...live, executablePath: "/other/bun" },
    )).toEqual({ ok: false, reason: "expected executable mismatch" });
  });

  test("health requires every ownership field to agree with lock and live identity", () => {
    const health = { ...lock, service: "pulse", subsystems: { dashboard: { status: "ok" } } };
    expect(validateHealthIdentity(health, lock, expected, live)).toEqual({ ok: true });

    for (const field of ["configPath", "scriptPath", "executablePath", "processStartedAt"] as const) {
      const mismatched = { ...health, [field]: `${health[field]}-other` };
      expect(validateHealthIdentity(mismatched, lock, expected, live)).toEqual({
        ok: false,
        reason: `health/lock ${field} mismatch`,
      });
    }
    expect(validateHealthIdentity(health, lock, expected, {
      ...live,
      startedAt: "2026-09-29T09:00:00.000Z",
    })).toEqual({ ok: false, reason: "process start identity mismatch" });
  });
});
