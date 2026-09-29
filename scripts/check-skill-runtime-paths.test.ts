import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkillRuntimePaths } from "./check-skill-runtime-paths";

describe("skill runtime path audit", () => {
  test("flags executable fenced and inline commands but ignores prose and non-executable examples", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-runtime-paths-"));
    try {
      mkdirSync(join(root, "LifeOS/install/skills", "Sample"), { recursive: true });
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "scripts/exceptions.json"), JSON.stringify({ exceptions: [] }));
      writeFileSync(join(root, "LifeOS/install/skills/Sample/SKILL.md"), [
        "Descriptive text may mention ~/.claude/LIFEOS without being a command.",
        "```bash",
        "bun ~/.claude/LIFEOS/TOOLS/Cortex.ts status",
        "```",
        "```text",
        "~/.claude/skills/Foo/ is an example path",
        "```",
        "Run `bun ~/.claude/skills/Foo/Tool.ts` now.",
        "PATTERN_PATH=\"$HOME/.claude/skills/Foo/Patterns/example.md\"",
        "bun \"%USERPROFILE%\\.claude\\LIFEOS\\TOOLS\\Cortex.ts\" status",
        "bun ~/.codex/LIFEOS/TOOLS/Cortex.ts status",
        "bun /home/alice/.codex/LIFEOS/TOOLS/Cortex.ts status",
        "bun \"C:\\Users\\Test User\\.claude\\LIFEOS\\TOOLS\\Cortex.ts\" status",
      ].join("\n"));
      const result = checkSkillRuntimePaths({ root, exceptionsFile: "scripts/exceptions.json" });
      expect(result.violations.map(item => item.line)).toEqual([3, 8, 9, 10, 11, 12, 13]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("permits only exact, explicitly Claude-only exceptions", () => {
    const root = mkdtempSync(join(tmpdir(), "skill-runtime-paths-"));
    try {
      mkdirSync(join(root, "LifeOS/install/skills", "ClaudeSpecific"), { recursive: true });
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(join(root, "LifeOS/install/skills/ClaudeSpecific/SKILL.md"), "```bash\ncat ~/.claude/LIFEOS/CLAUDE.md\n```\n");
      writeFileSync(join(root, "scripts/exceptions.json"), JSON.stringify({ exceptions: [{
        file: "LifeOS/install/skills/ClaudeSpecific/SKILL.md",
        literal: "~/.claude/LIFEOS/",
        reason: "Claude-only: this command reads Claude Code's harness-specific configuration file.",
      }] }));
      const result = checkSkillRuntimePaths({ root, exceptionsFile: "scripts/exceptions.json" });
      expect(result.violations).toHaveLength(0);
      expect(result.exceptionsUsed).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
