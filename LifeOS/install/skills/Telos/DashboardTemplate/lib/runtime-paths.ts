import os from "node:os";
import path from "node:path";

export interface DashboardRuntimePaths {
  configRoot: string;
  lifeosDir: string;
  userDir: string;
  toolsDir: string;
  skillsDir: string;
}

/** Resolve the active harness root while ignoring stale Claude values in Codex. */
export function getDashboardRuntimePaths(): DashboardRuntimePaths {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const codexActive = Boolean(
    process.env.CODEX_HOME || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID || process.env.CODEX_SANDBOX,
  );
  const configRoot = path.resolve(
    home,
    process.env.CODEX_HOME || (codexActive
      ? ".codex"
      : process.env.CLAUDE_CONFIG_DIR || ".claude"),
  );
  const configuredLifeos = process.env.LIFEOS_DIR;
  const staleClaudeLifeos = codexActive && configuredLifeos && path.resolve(configuredLifeos).toLowerCase()
    === path.resolve(home, ".claude", "LIFEOS").toLowerCase();
  const lifeosDir = configuredLifeos && !staleClaudeLifeos
    ? path.resolve(home, configuredLifeos)
    : path.join(configRoot, "LIFEOS");

  return {
    configRoot,
    lifeosDir,
    userDir: path.join(lifeosDir, "USER"),
    toolsDir: path.join(lifeosDir, "TOOLS"),
    skillsDir: path.join(configRoot, "skills"),
  };
}
