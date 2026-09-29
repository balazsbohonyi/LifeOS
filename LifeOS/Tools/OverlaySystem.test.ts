import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("OverlaySystem Pulse dashboard export", () => {
  test("overlays Pulse Observability/out but continues skipping unrelated out directories", () => {
    const root = mkdtempSync(join(tmpdir(), "lifeos-overlay-pulse-out-"));
    const configRoot = join(root, "config");
    const skillRoot = join(root, "skill");
    const installRoot = join(skillRoot, "install");
    const dashboardSource = join(installRoot, "LIFEOS", "PULSE", "Observability", "out");
    const otherOutputSource = join(installRoot, "LIFEOS", "PULSE", "Other", "out");
    const dashboardTarget = join(configRoot, "LIFEOS", "PULSE", "Observability", "out", "index.html");
    const otherOutputTarget = join(configRoot, "LIFEOS", "PULSE", "Other", "out", "private.txt");

    try {
      for (const directory of [
        "hooks",
        "skills",
        "agents",
        "LIFEOS/TOOLS",
        "LIFEOS/DOCUMENTATION",
        "LIFEOS/ALGORITHM",
        "LIFEOS/RULES",
        "LIFEOS/PULSE",
      ]) {
        mkdirSync(join(installRoot, directory), { recursive: true });
      }
      mkdirSync(dashboardSource, { recursive: true });
      mkdirSync(otherOutputSource, { recursive: true });
      mkdirSync(join(configRoot, "LIFEOS", "PULSE", "Observability", "out"), { recursive: true });
      writeFileSync(join(dashboardSource, "index.html"), "new dashboard bundle");
      writeFileSync(join(otherOutputSource, "private.txt"), "must remain excluded");
      writeFileSync(dashboardTarget, "old dashboard bundle");

      const overlayScript = join(import.meta.dir, "OverlaySystem.ts");
      const child = spawnSync(process.execPath, [
        overlayScript,
        "--config-root", configRoot,
        "--skill-root", skillRoot,
        "--apply",
        "--allow-dev",
      ], { encoding: "utf8", windowsHide: true });

      expect(child.status).toBe(0);
      const result = JSON.parse(child.stdout);
      expect(result.ok).toBe(true);
      expect(readFileSync(dashboardTarget, "utf8")).toBe("new dashboard bundle");
      expect(() => readFileSync(otherOutputTarget, "utf8")).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
