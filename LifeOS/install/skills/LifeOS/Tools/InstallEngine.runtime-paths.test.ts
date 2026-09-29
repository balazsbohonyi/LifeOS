import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSetupConfigRoot, setupRuntimeEnvironment } from "./InstallEngine.ts";

describe("resolveSetupConfigRoot", () => {
  test("active Codex markers override stale Claude config and LIFEOS paths", () => {
    const home = join(tmpdir(), "lifeos-setup-codex");
    const codexRoot = join(home, ".codex");

    expect(resolveSetupConfigRoot(home, {
      CODEX_THREAD_ID: "thread-1",
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      LIFEOS_DIR: join(home, ".claude", "LIFEOS"),
    })).toBe(codexRoot);
  });

  test("honors a custom CODEX_HOME when Codex markers are present", () => {
    const home = join(tmpdir(), "lifeos-setup-custom-codex");
    const codexRoot = join(home, "profiles", "primary");

    expect(resolveSetupConfigRoot(home, {
      CODEX_HOME: codexRoot,
      CODEX_SESSION_ID: "session-1",
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      LIFEOS_DIR: join(home, ".claude", "LIFEOS"),
    })).toBe(codexRoot);
  });

  test("uses an explicit Claude config root outside Codex sessions", () => {
    const home = join(tmpdir(), "lifeos-setup-claude");
    const claudeRoot = join(home, "profiles", "claude");

    expect(resolveSetupConfigRoot(home, {
      CLAUDE_CONFIG_DIR: claudeRoot,
    })).toBe(claudeRoot);
  });

  test("derives the config root from an explicit LifeOS directory", () => {
    const home = join(tmpdir(), "lifeos-setup-explicit-lifeos");
    const configRoot = join(home, "portable", "profile");

    expect(resolveSetupConfigRoot(home, {
      LIFEOS_DIR: join(configRoot, "LIFEOS"),
    })).toBe(configRoot);
  });

  test("propagates the chosen Codex root to child runtime tools", () => {
    const configRoot = join(tmpdir(), "lifeos-setup-child-codex");
    const childEnv = setupRuntimeEnvironment(configRoot, {
      CODEX_THREAD_ID: "thread-1",
      CLAUDE_CONFIG_DIR: join(tmpdir(), "stale-claude"),
      LIFEOS_DIR: join(tmpdir(), "stale-claude", "LIFEOS"),
    });

    expect(childEnv.CODEX_HOME).toBe(configRoot);
    expect(childEnv.CLAUDE_CONFIG_DIR).toBe(configRoot);
    expect(childEnv.LIFEOS_DIR).toBe(join(configRoot, "LIFEOS"));
  });

  test("does not mark Claude child processes as Codex", () => {
    const configRoot = join(tmpdir(), "lifeos-setup-child-claude");
    const childEnv = setupRuntimeEnvironment(configRoot, {
      CLAUDE_CONFIG_DIR: join(tmpdir(), "stale-claude"),
    });

    expect(childEnv.CODEX_HOME).toBeUndefined();
    expect(childEnv.CLAUDE_CONFIG_DIR).toBe(configRoot);
    expect(childEnv.LIFEOS_DIR).toBe(join(configRoot, "LIFEOS"));
  });
});
