import { describe, expect, test } from "bun:test";
import { validateWindowsPulseLifecycleResult, type WindowsPulseLifecycleResult } from "./Services.ts";

const runtimeRoot = "C:\\Users\\Example\\.codex\\LIFEOS";
const configPath = "D:\\External Config\\LIFEOS_CONFIG.toml";

function healthy(): WindowsPulseLifecycleResult {
  return {
    ok: true,
    runtimeRoot,
    configPath,
    taskOwned: true,
    taskRunning: true,
    taskConfigured: true,
    lockOwned: true,
    responding: true,
    dashboardAvailable: true,
    identityAgreement: true,
    processOwned: true,
    instanceId: "instance-a",
  };
}

describe("Windows Pulse lifecycle evidence", () => {
  test("accepts complete matching lifecycle evidence", () => {
    expect(validateWindowsPulseLifecycleResult("install", healthy(), runtimeRoot.toLowerCase(), configPath).ok).toBe(true);
  });

  test("rejects a zero-exit-shaped result with inconsistent identity", () => {
    const result = healthy();
    result.identityAgreement = false;
    expect(validateWindowsPulseLifecycleResult("install", result, runtimeRoot, configPath)).toEqual({
      ok: false,
      reason: "Pulse lifecycle evidence failed: identityAgreement",
    });
  });

  test("rejects a missing dashboard even when everything else responds", () => {
    const result = healthy();
    result.dashboardAvailable = false;
    expect(validateWindowsPulseLifecycleResult("install", result, runtimeRoot, configPath).ok).toBe(false);
  });

  test("rejects a mismatched explicit config path", () => {
    expect(validateWindowsPulseLifecycleResult("install", healthy(), runtimeRoot, "D:\\Other\\config.toml").ok).toBe(false);
  });
});
