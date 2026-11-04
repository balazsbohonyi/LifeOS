/**
 * Statusline wiring: which script to deploy and the `settings.json` `statusLine`
 * command that runs it, per platform.
 *
 * macOS/Linux run the bash script (`LIFEOS_StatusLine.sh`) directly. Windows runs
 * the Node-compatible port (`LIFEOS_StatusLine.mjs`) through `bun`, because bash and
 * jq cannot be assumed there, and the bash script was measured at 10+ seconds per
 * render under Git Bash (too slow for the harness to show). That measurement is
 * Windows-only; nothing here claims the bash script is slow on macOS or Linux. Hook
 * commands on Windows already use a bare `bun`, so the statusline does the same.
 *
 * Pure and platform-injected so both branches are testable from any host.
 */
import { posix } from "node:path";

export interface StatuslineSpec {
  /** File name of the script inside the LIFEOS runtime dir. */
  script: string;
  /** Absolute path of the script in the live runtime dir (forward slashes on Windows). */
  scriptPath: string;
  /** Value for `settings.json` `statusLine.command`. */
  command: string;
  /** True when the script needs `chmod +x` (a directly executed shell script). */
  executable: boolean;
}

export function statuslineSpec(platform: string, lifeosDir: string, home: string): StatuslineSpec {
  if (platform === "win32") {
    const script = "LIFEOS_StatusLine.mjs";
    const scriptPath = `${lifeosDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${script}`;
    return { script, scriptPath, command: `bun "${scriptPath}"`, executable: false };
  }
  const script = "LIFEOS_StatusLine.sh";
  const scriptPath = posix.join(lifeosDir, script);
  // Build the command from the ACTUAL install root, not a hardcoded ~/.claude — a
  // custom --config-root (e.g. ~/.claude-fable) places the script under its own LIFEOS/.
  const command = scriptPath.startsWith(`${home}/`)
    ? `$HOME/${scriptPath.slice(home.length + 1)}`
    : scriptPath;
  return { script, scriptPath, command, executable: true };
}
