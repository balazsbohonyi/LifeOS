import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pulseLifecycleFailure, unsupportedWindowsJobs, type PulseLifecycleStatus } from "./PulseDoctor.ts";
import { loadConfig, type Job } from "../PULSE/lib.ts";

const expected = {
  configRoot: "C:\\Users\\Test User\\.codex",
  runtimeRoot: "C:\\Users\\Test User\\.codex\\LIFEOS",
  configPath: "D:\\LifeOS Config\\LIFEOS_CONFIG.toml",
};

function healthyStatus(): PulseLifecycleStatus {
  return {
    ok: true,
    configRoot: expected.configRoot,
    runtimeRoot: expected.runtimeRoot,
    configPath: expected.configPath,
    taskOwned: true,
    taskRunning: true,
    taskConfigured: true,
    lockOwned: true,
    responding: true,
    dashboardAvailable: true,
    identityAgreement: true,
    processOwned: true,
    instanceId: "instance-123",
    httpStatus: 200,
  };
}

function job(overrides: Partial<Job>): Job {
  return {
    name: "fixture",
    schedule: "* * * * *",
    type: "script",
    output: "log",
    enabled: true,
    ...overrides,
  };
}

describe("Pulse Doctor helpers", () => {
  test("accepts the complete strict lifecycle result with case-insensitive Windows paths", () => {
    const status = healthyStatus();
    status.configRoot = expected.configRoot.toUpperCase();
    expect(pulseLifecycleFailure(status, expected)).toBeUndefined();
  });

  test("rejects each missing or false strict lifecycle signal", () => {
    for (const field of [
      "ok", "taskOwned", "taskRunning", "taskConfigured", "lockOwned", "responding",
      "dashboardAvailable", "identityAgreement", "processOwned",
    ] as const) {
      const status = healthyStatus();
      status[field] = false;
      expect(pulseLifecycleFailure(status, expected)).toContain(field);
    }
  });

  test("rejects missing identity, non-200 dashboard health, and mismatched explicit paths", () => {
    const noInstance = healthyStatus();
    noInstance.instanceId = "";
    expect(pulseLifecycleFailure(noInstance, expected)).toContain("instanceId");

    const unavailable = healthyStatus();
    unavailable.httpStatus = 503;
    expect(pulseLifecycleFailure(unavailable, expected)).toContain("503");

    const wrongConfig = healthyStatus();
    wrongConfig.configPath = "C:\\wrong\\LIFEOS_CONFIG.toml";
    expect(pulseLifecycleFailure(wrongConfig, expected)).toContain("configPath");
    expect(pulseLifecycleFailure(null, expected)).toContain("invalid JSON");
  });

  test("uses the shared scheduler policy and ignores disabled unsupported jobs", () => {
    const unsupported = unsupportedWindowsJobs([
      job({ name: "structured", program: "bun", args: ["run", "job.ts"], platforms: ["windows"] }),
      job({ name: "wrong-platform", program: "bun", platforms: ["darwin"] }),
      job({ name: "ambiguous-command", command: "echo hello" }),
      job({ name: "powershell-command", command: "Write-Output hello", shell: "powershell" }),
      job({ name: "disabled-legacy", enabled: false, command: "echo hello" }),
      job({ name: "missing-invocation" }),
    ]);

    expect(unsupported.map(({ name }) => name)).toEqual(["wrong-platform", "ambiguous-command", "missing-invocation"]);
    expect(unsupported[0].reason).toContain("current platform is windows");
    expect(unsupported[1].reason).toContain('shell = "powershell"');
  });

  test("checks the merged effective jobs after a user override replaces a system job", async () => {
    const root = mkdtempSync(join(tmpdir(), "pulse-doctor-config-"));
    const userPath = join(root, "PULSE.user.toml");
    try {
      writeFileSync(join(root, "PULSE.toml"), `[[job]]
name = "shared-job"
schedule = "* * * * *"
type = "script"
command = "echo legacy system command"
output = "log"
enabled = true
`, "utf8");
      writeFileSync(userPath, `[[job]]
name = "shared-job"
schedule = "* * * * *"
type = "script"
program = "bun"
args = ["run", "safe.ts"]
platforms = ["windows"]
output = "log"
enabled = true

[[job]]
name = "user-only-job"
schedule = "* * * * *"
type = "script"
command = "echo unsupported on windows"
output = "log"
enabled = true
`, "utf8");

      const config = await loadConfig(root, userPath);
      expect(config.jobs.map(({ name }) => name)).toEqual(["shared-job", "user-only-job"]);
      expect(config.jobs[0].program).toBe("bun");
      expect(unsupportedWindowsJobs(config.jobs).map(({ name }) => name)).toEqual(["user-only-job"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
