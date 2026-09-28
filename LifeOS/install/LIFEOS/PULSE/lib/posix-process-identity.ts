import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync, realpathSync } from "node:fs";
import { basename, isAbsolute, normalize } from "node:path";

export const PROCESS_START_TOLERANCE_MS = 5_000;

export interface PulseIdentityDocument {
  pid: number;
  instanceId: string;
  runtimeRoot: string;
  configPath: string;
  executablePath: string;
  scriptPath: string;
  processStartedAt: string;
}

export interface ExpectedPulseIdentity {
  runtimeRoot: string;
  configPath: string;
  scriptPath: string;
  executablePath: string;
}

export interface LiveProcessIdentity {
  pid: number;
  executablePath: string;
  command: string;
  startedAt: string;
}

export interface IdentityCheck {
  ok: boolean;
  reason?: string;
}

function canonicalExistingPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return normalize(path);
  }
}

function samePath(left: string, right: string): boolean {
  return canonicalExistingPath(left) === canonicalExistingPath(right);
}

function validDate(value: string): number | null {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function validateOwnedProcessIdentity(
  lock: Partial<PulseIdentityDocument>,
  expected: ExpectedPulseIdentity,
  live: LiveProcessIdentity,
  toleranceMs = PROCESS_START_TOLERANCE_MS,
): IdentityCheck {
  if (!Number.isSafeInteger(lock.pid) || Number(lock.pid) < 1 || lock.pid !== live.pid) return { ok: false, reason: "pid mismatch" };
  if (!lock.instanceId) return { ok: false, reason: "missing instance identity" };
  if (!lock.runtimeRoot || !samePath(lock.runtimeRoot, expected.runtimeRoot)) return { ok: false, reason: "runtime root mismatch" };
  if (!lock.configPath || !samePath(lock.configPath, expected.configPath)) return { ok: false, reason: "config path mismatch" };
  if (!lock.scriptPath || !samePath(lock.scriptPath, expected.scriptPath)) return { ok: false, reason: "script path mismatch" };
  if (!lock.executablePath || !samePath(lock.executablePath, expected.executablePath)) return { ok: false, reason: "expected executable mismatch" };
  if (!isAbsolute(lock.executablePath ?? "") || !samePath(lock.executablePath!, live.executablePath)) return { ok: false, reason: "live executable mismatch" };
  if (!live.command.includes(lock.scriptPath!)) return { ok: false, reason: "live command does not identify the Pulse script" };

  const lockedStart = validDate(lock.processStartedAt ?? "");
  const liveStart = validDate(live.startedAt);
  if (lockedStart === null || liveStart === null) return { ok: false, reason: "invalid process start identity" };
  if (Math.abs(lockedStart - liveStart) > toleranceMs) return { ok: false, reason: "process start identity mismatch" };
  return { ok: true };
}

export function validateHealthIdentity(
  health: Partial<PulseIdentityDocument> & { service?: string; subsystems?: { dashboard?: { status?: string } } },
  lock: Partial<PulseIdentityDocument>,
  expected: ExpectedPulseIdentity,
  live: LiveProcessIdentity,
): IdentityCheck {
  if (health.service !== "pulse") return { ok: false, reason: "wrong health service" };
  if (health.subsystems?.dashboard?.status !== "ok") return { ok: false, reason: "dashboard is not served" };

  for (const field of [
    "pid",
    "instanceId",
    "runtimeRoot",
    "configPath",
    "scriptPath",
    "executablePath",
    "processStartedAt",
  ] as const) {
    if (health[field] !== lock[field]) return { ok: false, reason: `health/lock ${field} mismatch` };
  }
  if (health.runtimeRoot !== expected.runtimeRoot) return { ok: false, reason: "unexpected health runtime root" };
  if (health.configPath !== expected.configPath) return { ok: false, reason: "unexpected health config path" };
  if (health.scriptPath !== expected.scriptPath) return { ok: false, reason: "unexpected health script path" };
  if (!health.executablePath || !samePath(health.executablePath, expected.executablePath)) return { ok: false, reason: "unexpected health executable path" };
  return validateOwnedProcessIdentity(lock, expected, live);
}

function run(name: string, args: string[]): string {
  return execFileSync(name, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function linuxProcessIdentity(pid: number): LiveProcessIdentity {
  const executablePath = realpathSync.native(readlinkSync(`/proc/${pid}/exe`));
  const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const afterName = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
  const startTicks = Number(afterName[19]); // field 22 after removing pid + comm
  const ticksPerSecond = Number(run("getconf", ["CLK_TCK"]));
  const bootSeconds = Number(readFileSync("/proc/stat", "utf8").match(/^btime\s+(\d+)$/mu)?.[1]);
  if (!Number.isFinite(startTicks) || !Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0 || !Number.isFinite(bootSeconds)) {
    throw new Error("Linux process start identity is unavailable");
  }
  return {
    pid,
    executablePath,
    command,
    startedAt: new Date((bootSeconds + startTicks / ticksPerSecond) * 1000).toISOString(),
  };
}

function darwinProcessIdentity(pid: number, lockedExecutablePath: string): LiveProcessIdentity {
  const command = run("ps", ["-ww", "-p", String(pid), "-o", "command="]);
  const comm = run("ps", ["-ww", "-p", String(pid), "-o", "comm="]);
  const rawStart = run("ps", ["-ww", "-p", String(pid), "-o", "lstart="]);
  const startMs = Date.parse(rawStart);
  if (!command || !comm || !Number.isFinite(startMs)) throw new Error("macOS process identity is unavailable");

  let executablePath: string;
  if (isAbsolute(comm)) {
    executablePath = canonicalExistingPath(comm);
  } else {
    // BSD ps can expose only the executable basename in `comm`. In that case,
    // require both the exact basename and the locked absolute path at argv[0].
    const locked = canonicalExistingPath(lockedExecutablePath);
    const commandStartsWithLockedPath = command === lockedExecutablePath || command.startsWith(`${lockedExecutablePath} `)
      || command === locked || command.startsWith(`${locked} `);
    if (basename(lockedExecutablePath) !== comm || !commandStartsWithLockedPath) {
      throw new Error("macOS live executable path cannot be established");
    }
    executablePath = locked;
  }
  return { pid, executablePath, command, startedAt: new Date(startMs).toISOString() };
}

export function readLiveProcessIdentity(
  pid: number,
  lockedExecutablePath: string,
  platform: NodeJS.Platform = process.platform,
): LiveProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("invalid PID");
  if (platform === "linux") return linuxProcessIdentity(pid);
  if (platform === "darwin") return darwinProcessIdentity(pid, lockedExecutablePath);
  throw new Error(`unsupported platform for POSIX process identity: ${platform}`);
}

function loadJson<T>(value: string | undefined, label: string): T {
  if (!value) throw new Error(`${label} is required`);
  return JSON.parse(value) as T;
}

if (import.meta.main) {
  try {
    const mode = Bun.argv[2];
    const lock = JSON.parse(readFileSync(process.env.LOCK_FILE!, "utf8")) as PulseIdentityDocument;
    const expected: ExpectedPulseIdentity = {
      runtimeRoot: process.env.EXPECTED_RUNTIME_ROOT!,
      configPath: process.env.EXPECTED_CONFIG_PATH!,
      scriptPath: process.env.EXPECTED_SCRIPT_PATH!,
      executablePath: process.env.EXPECTED_EXECUTABLE_PATH!,
    };
    if (!expected.runtimeRoot || !expected.configPath || !expected.scriptPath || !expected.executablePath) throw new Error("expected identity paths are required");
    const live = readLiveProcessIdentity(lock.pid, lock.executablePath);
    const result = mode === "health"
      ? validateHealthIdentity(loadJson(process.env.HEALTH_JSON, "HEALTH_JSON"), lock, expected, live)
      : mode === "owned-pid"
        ? validateOwnedProcessIdentity(lock, expected, live)
        : { ok: false, reason: `unknown mode: ${mode}` };
    if (!result.ok) throw new Error(result.reason);
    process.stdout.write(String(lock.pid));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
