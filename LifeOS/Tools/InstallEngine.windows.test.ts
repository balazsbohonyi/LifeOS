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

  test("an explicit Claude config root wins when Codex is merely installed", () => {
    const home = normalize("C:/Users/Test User");
    const claudeRoot = join(home, ".claude-custom");
    const result = detectHarness(home, { CLAUDE_CONFIG_DIR: claudeRoot }, (name) => (
      name === "codex" ? join(home, ".local", "bin", "codex.exe") : undefined
    ));
    expect(result.name).toBe("claude-code");
    expect(result.configRoot).toBe(claudeRoot);
    expect(result.confidence).toBe("detected");
  });
});
