import { win32 } from "path";
import { jobUnsupportedReason, type Job } from "../PULSE/lib.ts";

export interface PulseLifecycleStatus {
  ok?: boolean;
  configRoot?: string;
  runtimeRoot?: string;
  configPath?: string;
  taskOwned?: boolean;
  taskRunning?: boolean;
  taskConfigured?: boolean;
  lockOwned?: boolean;
  responding?: boolean;
  dashboardAvailable?: boolean;
  identityAgreement?: boolean;
  processOwned?: boolean;
  instanceId?: string;
  httpStatus?: number | null;
}

export interface ExpectedPulsePaths {
  configRoot: string;
  runtimeRoot: string;
  configPath: string;
}

const REQUIRED_TRUE_FIELDS: Array<keyof PulseLifecycleStatus> = [
  "ok",
  "taskOwned",
  "taskRunning",
  "taskConfigured",
  "lockOwned",
  "responding",
  "dashboardAvailable",
  "identityAgreement",
  "processOwned",
];

function sameWindowsPath(actual: unknown, expected: string): boolean {
  if (typeof actual !== "string" || !actual.trim()) return false;
  return win32.normalize(actual).replace(/[\\/]+$/, "").toLowerCase()
    === win32.normalize(expected).replace(/[\\/]+$/, "").toLowerCase();
}

/** Return a concise failure reason unless status proves the exact installed instance is healthy. */
export function pulseLifecycleFailure(
  status: PulseLifecycleStatus | null,
  expected: ExpectedPulsePaths,
): string | undefined {
  if (!status) return "Pulse lifecycle manager returned invalid JSON";

  for (const field of REQUIRED_TRUE_FIELDS) {
    if (status[field] !== true) return `Pulse lifecycle check failed: ${field} is not true`;
  }
  if (!status.instanceId?.trim()) return "Pulse lifecycle check failed: instanceId is missing";
  if (status.httpStatus !== 200) return `Pulse lifecycle check failed: health HTTP status is ${status.httpStatus ?? "missing"}`;
  if (!sameWindowsPath(status.configRoot, expected.configRoot)) return "Pulse lifecycle check failed: configRoot does not match this installation";
  if (!sameWindowsPath(status.runtimeRoot, expected.runtimeRoot)) return "Pulse lifecycle check failed: runtimeRoot does not match this installation";
  if (!sameWindowsPath(status.configPath, expected.configPath)) return "Pulse lifecycle check failed: configPath does not match this installation";
  return undefined;
}

/** Explain only enabled jobs that the shared scheduler explicitly rejects on Windows. */
export function unsupportedWindowsJobs(jobs: Job[]): Array<{ name: string; reason: string }> {
  return jobs.flatMap((job) => {
    if (!job.enabled) return [];
    const reason = jobUnsupportedReason(job, "win32");
    return reason ? [{ name: job.name, reason }] : [];
  });
}
