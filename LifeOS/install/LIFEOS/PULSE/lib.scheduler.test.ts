import { describe, expect, test } from "bun:test";
import { normalize } from "node:path";
import type { Job } from "./lib";
import { collectProc, jobUnsupportedReason, parseConfigToml, resolveScriptInvocation, runScriptJob, UnsupportedJobError } from "./lib";

const baseJob: Job = {
  name: "fixture",
  schedule: "* * * * *",
  type: "script",
  output: "log",
  enabled: true,
};

describe("structured scheduler jobs", () => {
  test("spawns Bun with an argument array and a resolved working directory", () => {
    const bun = normalize("C:/Users/Test/.bun/bin/bun.exe");
    const pulse = normalize("D:/LifeOS Root/LIFEOS/PULSE");
    const invocation = resolveScriptInvocation({
      ...baseJob,
      program: "bun",
      args: ["run", "checks/health.ts"],
      working_dir: "checks/..",
      platforms: ["darwin", "linux", "windows"],
    }, pulse, {
      platform: "win32",
      processExecPath: bun,
      executableFinder: () => bun,
    });

    expect(invocation.argv).toEqual([bun, "run", "checks/health.ts"]);
    expect(invocation.cwd).toBe(pulse);
  });

  test("reports jobs filtered from Windows as unsupported", () => {
    expect(jobUnsupportedReason({ ...baseJob, program: "bun", platforms: ["darwin", "linux"] }, "win32"))
      .toContain("current platform is windows");
  });

  test("rejects ambiguous Windows string commands with a migration hint", () => {
    const job = { ...baseJob, command: "bun run first.ts && bun run second.ts" };
    expect(() => resolveScriptInvocation(job, normalize("C:/Pulse"), {
      platform: "win32",
      executableFinder: () => normalize("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"),
    })).toThrow(UnsupportedJobError);
    expect(jobUnsupportedReason(job, "win32")).toContain('shell = "powershell"');
  });

  test("allows an explicitly selected PowerShell legacy shell", () => {
    const powershell = normalize("C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
    const invocation = resolveScriptInvocation({ ...baseJob, command: "Write-Output ok", shell: "powershell" }, normalize("C:/Pulse"), {
      platform: "win32",
      executableFinder: () => powershell,
    });
    expect(invocation.argv).toEqual([powershell, "-NoProfile", "-NonInteractive", "-Command", "Write-Output ok"]);
  });

  test("expands environment variables inside structured argument arrays", () => {
    const previous = process.env.PULSE_FIXTURE_ROOT;
    process.env.PULSE_FIXTURE_ROOT = "C:/Root With Spaces";
    try {
      const parsed = parseConfigToml(`
        [[job]]
        name = "env-fixture"
        schedule = "* * * * *"
        type = "script"
        program = "bun"
        args = ["run", "${"${PULSE_FIXTURE_ROOT}"}/check.ts"]
      `) as { job: Array<{ args: string[] }> };
      expect(parsed.job[0].args[1]).toBe("C:/Root With Spaces/check.ts");
    } finally {
      if (previous === undefined) delete process.env.PULSE_FIXTURE_ROOT;
      else process.env.PULSE_FIXTURE_ROOT = previous;
    }
  });

  test("records a hard timeout without hanging on child pipes", async () => {
    let closeStdout!: () => void;
    let closeStderr!: () => void;
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { closeStdout = () => controller.close(); } });
    const stderr = new ReadableStream<Uint8Array>({ start(controller) { closeStderr = () => controller.close(); } });
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    let stopped = false;
    const result = await collectProc({
      stdout,
      stderr,
      exited,
      kill: () => {
        if (stopped) return;
        stopped = true;
        closeStdout();
        closeStderr();
        resolveExit(1);
      },
    }, 5);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test("surfaces a structured child-process failure", async () => {
    await expect(runScriptJob({
      ...baseJob,
      program: process.execPath,
      args: ["-e", "process.exit(7)"],
      timeout_ms: 5_000,
    })).rejects.toThrow("Script exited 7");
  });
});
