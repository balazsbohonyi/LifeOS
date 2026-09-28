import { describe, expect, test } from "bun:test";
import { join, normalize } from "node:path";
import { detectHarness } from "./InstallEngine";

describe("Codex harness detection", () => {
  test("active Codex session wins without relying on PATH", () => {
    const home = normalize("C:/Users/Test User");
    const root = join(home, ".codex");
    const result = detectHarness(home, { CODEX_HOME: root, CODEX_THREAD_ID: "thread-1" }, () => undefined);
    expect(result.name).toBe("codex");
    expect(result.configRoot).toBe(root);
    expect(result.skillsDir).toBe(join(root, "skills"));
    expect(result.confidence).toBe("detected");
  });
});
