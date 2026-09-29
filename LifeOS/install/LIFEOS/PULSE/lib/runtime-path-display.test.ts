import { describe, expect, test } from "bun:test";
import { appendRuntimePath, getRuntimePathText, type RuntimePathDisplay } from "../Observability/src/lib/runtime-path-display";

describe("runtime path display", () => {
  test("joins Windows Codex paths without introducing POSIX separators", () => {
    const paths: RuntimePathDisplay = {
      configRoot: "~\\.codex",
      lifeosDir: "~\\.codex\\LIFEOS",
      userDir: "~\\.codex\\LIFEOS\\USER",
      memoryDir: "~\\.codex\\LIFEOS\\MEMORY",
      pulseDir: "~\\.codex\\LIFEOS\\PULSE",
      toolsDir: "~\\.codex\\LIFEOS\\TOOLS",
      skillsDir: "~\\.codex\\skills",
      envPath: "~\\.codex\\.env",
      settingsPath: "~\\.codex\\settings.json",
    };

    expect(getRuntimePathText(paths, "userDir", ["CONFIG", "PULSE.user.toml"], "LIFEOS/USER"))
      .toBe("~\\.codex\\LIFEOS\\USER\\CONFIG\\PULSE.user.toml");
    expect(appendRuntimePath("~\\.codex\\LIFEOS", "PULSE", "checks/airgradient-poll.ts"))
      .toBe("~\\.codex\\LIFEOS\\PULSE\\checks\\airgradient-poll.ts");
  });

  test("uses a relative LifeOS hint rather than a stale Claude path until the API responds", () => {
    expect(getRuntimePathText(null, "userDir", ["TELOS"], "LIFEOS/USER"))
      .toBe("LIFEOS/USER/TELOS");
  });

  test("preserves POSIX path display for existing Linux and macOS installs", () => {
    const paths: RuntimePathDisplay = {
      configRoot: "~/.claude",
      lifeosDir: "~/.claude/LIFEOS",
      userDir: "~/.claude/LIFEOS/USER",
      memoryDir: "~/.claude/LIFEOS/MEMORY",
      pulseDir: "~/.claude/LIFEOS/PULSE",
      toolsDir: "~/.claude/LIFEOS/TOOLS",
      skillsDir: "~/.claude/skills",
      envPath: "~/.claude/.env",
      settingsPath: "~/.claude/settings.json",
    };

    expect(getRuntimePathText(paths, "userDir", ["TELOS", "TELOS.md"], "LIFEOS/USER"))
      .toBe("~/.claude/LIFEOS/USER/TELOS/TELOS.md");
  });
});
