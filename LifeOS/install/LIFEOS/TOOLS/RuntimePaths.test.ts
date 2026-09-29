import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { findExecutable, publishRuntimeEnvironment, resolveRuntimePaths, toRuntimePathDisplay } from "./RuntimePaths";

describe("resolveRuntimePaths", () => {
  test("uses a deployed .codex runtime without HOME", () => {
    const root = normalize("C:/Users/Test User/.codex");
    const paths = resolveRuntimePaths({
      env: {},
      home: normalize("C:/Users/Test User"),
      toolDir: join(root, "LIFEOS", "TOOLS"),
    });

    expect(paths.configRoot).toBe(root);
    expect(paths.lifeosDir).toBe(join(root, "LIFEOS"));
    expect(paths.userDir).toBe(join(root, "LIFEOS", "USER"));
    expect(paths.envPath).toBe(join(root, ".env"));
    const display = toRuntimePathDisplay(paths);
    expect(display.configRoot).toBe(join("~", ".codex"));
    expect(display.userDir).toBe(join("~", ".codex", "LIFEOS", "USER"));
  });

  test("honors a custom config root containing spaces", () => {
    const root = normalize("D:/LifeOS Profiles/Balazs");
    const paths = resolveRuntimePaths({
      env: { CLAUDE_CONFIG_DIR: root },
      home: normalize("C:/Users/Balazs"),
      toolDir: normalize("D:/payload/LIFEOS/TOOLS"),
    });

    expect(paths.configRoot).toBe(root);
    expect(paths.pulseDir).toBe(join(root, "LIFEOS", "PULSE"));
  });

  test("prefers LIFEOS_DIR and supports an explicit config file", () => {
    const lifeosDir = normalize("E:/portable/LIFEOS");
    const configPath = normalize("E:/private/LIFEOS_CONFIG.toml");
    const paths = resolveRuntimePaths({
      env: { LIFEOS_DIR: lifeosDir, LIFEOS_CONFIG_PATH: configPath },
      home: normalize("C:/Users/Balazs"),
      toolDir: normalize("D:/payload/LIFEOS/TOOLS"),
    });

    expect(paths.lifeosDir).toBe(lifeosDir);
    expect(paths.configRoot).toBe(normalize("E:/portable"));
    expect(paths.configPath).toBe(configPath);
  });

  test("falls back to the legacy .claude root when not deployed", () => {
    const home = normalize("C:/Users/Legacy");
    const paths = resolveRuntimePaths({ env: {}, home, toolDir: normalize("D:/source/tools") });
    expect(paths.lifeosDir).toBe(join(home, ".claude", "LIFEOS"));
  });

  test("resolves relative overrides once and publishes only canonical absolute roots", () => {
    const home = normalize("C:/Users/Portable User");
    const paths = resolveRuntimePaths({
      env: {
        HOME: home,
        CLAUDE_CONFIG_DIR: "profiles/codex",
        LIFEOS_CONFIG_PATH: "private/LIFEOS_CONFIG.toml",
      },
      toolDir: normalize("D:/payload/tools"),
    });
    const inherited = {
      HOME: "stale-home",
      CLAUDE_CONFIG_DIR: "profiles/codex",
      LIFEOS_DIR: "stale-lifeos",
      LIFEOS_CONFIG_PATH: "private/LIFEOS_CONFIG.toml",
      PULSE_DIR: "stale-pulse",
    };

    publishRuntimeEnvironment(paths, inherited);

    expect(paths.configRoot).toBe(join(home, "profiles", "codex"));
    expect(paths.configPath).toBe(join(home, "private", "LIFEOS_CONFIG.toml"));
    expect(inherited).toEqual({
      HOME: home,
      CLAUDE_CONFIG_DIR: paths.configRoot,
      LIFEOS_DIR: paths.lifeosDir,
      LIFEOS_CONFIG_PATH: paths.configPath,
      PULSE_DIR: paths.pulseDir,
    });
    for (const value of Object.values(inherited)) expect(isAbsolute(value)).toBe(true);
  });

  test("keeps the canonical USER path usable through a Windows directory junction", () => {
    if (process.platform !== "win32") return;
    const temp = mkdtempSync(join(tmpdir(), "lifeos-paths-"));
    const target = join(temp, "runtime target", "LIFEOS");
    const configRoot = join(temp, "config root");
    const junction = join(configRoot, "LIFEOS");
    try {
      mkdirSync(join(target, "TOOLS"), { recursive: true });
      mkdirSync(configRoot, { recursive: true });
      symlinkSync(target, junction, "junction");
      const paths = resolveRuntimePaths({ env: {}, home: temp, toolDir: join(junction, "TOOLS") });
      expect(paths.lifeosDir).toBe(junction);
      expect(paths.userDir).toBe(join(junction, "USER"));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe("findExecutable", () => {
  test("uses the running Bun executable first", () => {
    const bun = normalize("C:/Runtime/bun.exe");
    expect(findExecutable("bun", {
      platform: "win32",
      env: {},
      processExecPath: bun,
      exists: (candidate) => candidate === bun,
      lookup: () => [],
    })).toBe(bun);
  });

  test("finds Bun in its standard Windows user location when PATH is stale", () => {
    const profile = normalize("C:/Users/Test User");
    const bun = join(profile, ".bun", "bin", "bun.exe");
    expect(findExecutable("bun", {
      platform: "win32",
      env: { USERPROFILE: profile },
      processExecPath: normalize("C:/Program Files/node/node.exe"),
      exists: (candidate) => candidate === bun,
      lookup: () => [],
    })).toBe(bun);
  });

  test("rejects lookup results that do not exist", () => {
    expect(findExecutable("git", {
      platform: "win32",
      env: {},
      processExecPath: normalize("C:/Program Files/node/node.exe"),
      exists: () => false,
      lookup: () => [normalize("C:/missing/git.exe")],
    })).toBeUndefined();
  });
});
