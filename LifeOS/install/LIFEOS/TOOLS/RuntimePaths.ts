/**
 * Canonical runtime and executable discovery for a deployed LifeOS install.
 *
 * Runtime code must not assume ~/.claude: LifeOS can be deployed under Codex,
 * Claude, or an explicitly selected config root.  This module lives inside the
 * deployed LIFEOS/TOOLS directory, so its own location is the most reliable
 * fallback when no override was supplied.
 */

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimePathEnvironment {
  LIFEOS_DIR?: string;
  LIFEOS_CONFIG_PATH?: string;
  CLAUDE_CONFIG_DIR?: string;
  CODEX_HOME?: string;
  HOME?: string;
  USERPROFILE?: string;
  PATH?: string;
  Path?: string;
  LOCALAPPDATA?: string;
  ProgramFiles?: string;
  PULSE_DIR?: string;
  [key: string]: string | undefined;
}

export interface ResolveRuntimePathOptions {
  configRoot?: string;
  lifeosDir?: string;
  toolDir?: string;
  home?: string;
  env?: RuntimePathEnvironment;
}

export interface RuntimePaths {
  home: string;
  configRoot: string;
  lifeosDir: string;
  toolsDir: string;
  pulseDir: string;
  userDir: string;
  memoryDir: string;
  envPath: string;
  configPath: string;
}

export interface RuntimePathDisplay {
  configRoot: string;
  lifeosDir: string;
  userDir: string;
  memoryDir: string;
  pulseDir: string;
  toolsDir: string;
  skillsDir: string;
  envPath: string;
  settingsPath: string;
}

export type RuntimeEnvironmentTarget = Pick<
  RuntimePathEnvironment,
  "HOME" | "CLAUDE_CONFIG_DIR" | "LIFEOS_DIR" | "LIFEOS_CONFIG_PATH" | "PULSE_DIR"
>;

function absolute(path: string, base: string): string {
  return normalize(isAbsolute(path) ? path : resolve(base, path));
}

function deployedLifeosDir(toolDir: string): string | undefined {
  const normalizedToolDir = normalize(toolDir);
  if (basename(normalizedToolDir).toLowerCase() !== "tools") return undefined;
  const candidate = dirname(normalizedToolDir);
  return basename(candidate).toLowerCase() === "lifeos" ? candidate : undefined;
}

function defaultToolDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Resolution precedence:
 *   1. explicit arguments
 *   2. LIFEOS_DIR / CLAUDE_CONFIG_DIR / CODEX_HOME environment overrides
 *   3. the deployed location of this module
 *   4. legacy ~/.claude/LIFEOS
 */
export function resolveRuntimePaths(options: ResolveRuntimePathOptions = {}): RuntimePaths {
  const env = options.env ?? process.env;
  const home = absolute(options.home ?? env.HOME ?? env.USERPROFILE ?? homedir(), process.cwd());
  const toolDir = absolute(options.toolDir ?? defaultToolDir(), home);
  const deployed = deployedLifeosDir(toolDir);

  const explicitConfigRoot = options.configRoot ?? env.CLAUDE_CONFIG_DIR ?? env.CODEX_HOME;
  const explicitLifeosDir = options.lifeosDir ?? env.LIFEOS_DIR;

  let lifeosDir: string;
  let configRoot: string;

  if (explicitLifeosDir) {
    lifeosDir = absolute(explicitLifeosDir, home);
    configRoot = explicitConfigRoot
      ? absolute(explicitConfigRoot, home)
      : dirname(lifeosDir);
  } else if (explicitConfigRoot) {
    configRoot = absolute(explicitConfigRoot, home);
    lifeosDir = join(configRoot, "LIFEOS");
  } else if (deployed) {
    lifeosDir = deployed;
    configRoot = dirname(lifeosDir);
  } else {
    configRoot = join(home, ".claude");
    lifeosDir = join(configRoot, "LIFEOS");
  }

  const configPath = env.LIFEOS_CONFIG_PATH
    ? absolute(env.LIFEOS_CONFIG_PATH, home)
    : join(lifeosDir, "USER", "CONFIG", "LIFEOS_CONFIG.toml");

  return {
    home,
    configRoot,
    lifeosDir,
    toolsDir: join(lifeosDir, "TOOLS"),
    pulseDir: join(lifeosDir, "PULSE"),
    userDir: join(lifeosDir, "USER"),
    memoryDir: join(lifeosDir, "MEMORY"),
    envPath: join(configRoot, ".env"),
    configPath,
  };
}

function displayFromHome(path: string, home: string): string {
  const relativePath = relative(home, path);
  if (!relativePath) return "~";
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return normalize(path);
  }
  return join("~", relativePath);
}

/** Runtime-owned paths safe for display in Pulse's local dashboard. */
export function toRuntimePathDisplay(paths: RuntimePaths): RuntimePathDisplay {
  const show = (path: string) => displayFromHome(path, paths.home);
  return {
    configRoot: show(paths.configRoot),
    lifeosDir: show(paths.lifeosDir),
    userDir: show(paths.userDir),
    memoryDir: show(paths.memoryDir),
    pulseDir: show(paths.pulseDir),
    toolsDir: show(paths.toolsDir),
    skillsDir: show(join(paths.configRoot, "skills")),
    envPath: show(paths.envPath),
    settingsPath: show(join(paths.configRoot, "settings.json")),
  };
}

/**
 * Publish one canonical path set for all modules and child processes.
 *
 * Assignment is deliberately unconditional: a relative/raw override may have
 * selected the runtime, but downstream consumers must never resolve that raw
 * value a second time from a different working directory.
 */
export function publishRuntimeEnvironment(
  paths: RuntimePaths,
  env: RuntimeEnvironmentTarget = process.env as RuntimeEnvironmentTarget,
): RuntimeEnvironmentTarget {
  env.HOME = paths.home;
  env.CLAUDE_CONFIG_DIR = paths.configRoot;
  env.LIFEOS_DIR = paths.lifeosDir;
  env.LIFEOS_CONFIG_PATH = paths.configPath;
  env.PULSE_DIR = paths.pulseDir;
  return env;
}

export interface FindExecutableOptions {
  env?: RuntimePathEnvironment;
  platform?: NodeJS.Platform;
  processExecPath?: string;
  exists?: (path: string) => boolean;
  lookup?: (name: string) => string[];
  extraCandidates?: string[];
}

function platformLookup(name: string, platform: NodeJS.Platform, env: RuntimePathEnvironment): string[] {
  try {
    const command = platform === "win32" ? "where.exe" : "which";
    const output = execFileSync(command, [name], {
      encoding: "utf8",
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    return output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function standardCandidates(name: string, env: RuntimePathEnvironment, platform: NodeJS.Platform): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (platform !== "win32") {
    return [join(home, ".bun", "bin", name), `/usr/local/bin/${name}`, `/usr/bin/${name}`];
  }

  const executable = name.toLowerCase().endsWith(".exe") ? name : `${name}.exe`;
  const candidates = [join(home, ".bun", "bin", executable)];
  if (env.LOCALAPPDATA) {
    candidates.push(
      join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", executable),
      join(env.LOCALAPPDATA, "bun", "bin", executable),
    );
  }
  if (env.ProgramFiles && name.toLowerCase() === "git") {
    candidates.push(join(env.ProgramFiles, "Git", "cmd", executable));
  }
  return candidates;
}

/** Return a verified absolute executable path, or undefined when unavailable. */
export function findExecutable(name: string, options: FindExecutableOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const processExecPath = options.processExecPath ?? process.execPath;
  const lookup = options.lookup ?? ((candidate: string) => platformLookup(candidate, platform, env));
  const bareName = name.replace(/\.exe$/iu, "");
  const candidates: string[] = [];

  if (basename(processExecPath).replace(/\.exe$/iu, "").toLowerCase() === bareName.toLowerCase()) {
    candidates.push(processExecPath);
  }
  if (isAbsolute(name)) candidates.push(name);
  candidates.push(...lookup(name), ...standardCandidates(bareName, env, platform), ...(options.extraCandidates ?? []));

  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || !exists(candidate)) continue;
    try {
      return realpathSync.native(candidate);
    } catch {
      return normalize(candidate);
    }
  }
  return undefined;
}
