import { describe, expect, test } from "bun:test";
import { statuslineSpec } from "./statusline";

describe("statuslineSpec", () => {
  test("Windows deploys the Node port and runs it through bun with forward slashes", () => {
    const spec = statuslineSpec("win32", "C:\\Users\\Test User\\.claude\\LIFEOS", "C:\\Users\\Test User");
    expect(spec.script).toBe("LIFEOS_StatusLine.mjs");
    expect(spec.scriptPath).toBe("C:/Users/Test User/.claude/LIFEOS/LIFEOS_StatusLine.mjs");
    expect(spec.command).toBe('bun "C:/Users/Test User/.claude/LIFEOS/LIFEOS_StatusLine.mjs"');
    expect(spec.executable).toBe(false);
  });

  test("Windows accepts forward-slash and trailing-slash runtime dirs", () => {
    const spec = statuslineSpec("win32", "C:/Users/Test/.claude/LIFEOS/", "C:/Users/Test");
    expect(spec.command).toBe('bun "C:/Users/Test/.claude/LIFEOS/LIFEOS_StatusLine.mjs"');
  });

  test("macOS and Linux keep the bash script with a $HOME-relative command", () => {
    for (const platform of ["darwin", "linux"]) {
      const spec = statuslineSpec(platform, "/home/test/.claude/LIFEOS", "/home/test");
      expect(spec.script).toBe("LIFEOS_StatusLine.sh");
      expect(spec.command).toBe("$HOME/.claude/LIFEOS/LIFEOS_StatusLine.sh");
      expect(spec.executable).toBe(true);
    }
  });

  test("a custom config root outside home keeps its absolute path", () => {
    const spec = statuslineSpec("linux", "/opt/lifeos/LIFEOS", "/home/test");
    expect(spec.command).toBe("/opt/lifeos/LIFEOS/LIFEOS_StatusLine.sh");
  });

  test("a home path that only shares a prefix is not rewritten", () => {
    const spec = statuslineSpec("linux", "/home/tester/.claude/LIFEOS", "/home/test");
    expect(spec.command).toBe("/home/tester/.claude/LIFEOS/LIFEOS_StatusLine.sh");
  });
});
