import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { resolveRuntimePaths } from "../../TOOLS/RuntimePaths.ts";
import { renderPulseServiceTemplate } from "./service-template.ts";

const PULSE_DIR = normalize(join(import.meta.dir, ".."));

describe("Pulse POSIX service templates", () => {
  const home = normalize("C:/Users/Test User");
  const runtime = resolveRuntimePaths({
    home,
    env: {
      HOME: home,
      CLAUDE_CONFIG_DIR: "Profiles/Selected & % Root",
      LIFEOS_CONFIG_PATH: "Private/LIFEOS_CONFIG.toml",
    },
    toolDir: normalize("C:/payload/tools"),
  });
  const bunPath = normalize("C:/Applications/Bun Runtime/bin/bun.exe");

  test("launchd output contains absolute selected roots and XML-safe values", () => {
    const rendered = renderPulseServiceTemplate(
      readFileSync(join(PULSE_DIR, "com.lifeos.pulse.plist"), "utf8"),
      "launchd",
      { runtime, bunPath },
    );

    expect(rendered).not.toMatch(/__[A-Z0-9_]+__/u);
    expect(rendered).toContain("Selected &amp; % Root");
    expect(rendered).toContain(`<key>CLAUDE_CONFIG_DIR</key>\n        <string>${runtime.configRoot.replace("&", "&amp;")}</string>`);
    expect(rendered).toContain(runtime.configPath);
    expect(rendered).toContain(join(runtime.pulseDir, "pulse.ts").replace("&", "&amp;"));
  });

  test("systemd output quotes every path-bearing directive", () => {
    const rendered = renderPulseServiceTemplate(
      readFileSync(join(PULSE_DIR, "com.lifeos.pulse.service"), "utf8"),
      "systemd",
      { runtime, bunPath },
    );

    expect(rendered).not.toMatch(/__[A-Z0-9_]+__/u);
    const escaped = (value: string) => value.replaceAll("%", "%%").replaceAll("\\", "\\\\");
    expect(rendered).toContain(`ExecStart="${escaped(bunPath)}" run "${escaped(join(runtime.pulseDir, "pulse.ts"))}"`);
    expect(rendered).toContain(`Environment="CLAUDE_CONFIG_DIR=${escaped(runtime.configRoot)}"`);
    expect(rendered).toContain(`Environment="LIFEOS_CONFIG_PATH=${escaped(runtime.configPath)}"`);
    expect(rendered).toContain(`Environment="PULSE_DIR=${escaped(runtime.pulseDir)}"`);
    expect(rendered).toContain("Selected & %% Root");
  });

  test("manager has no broad process kill and verifies lock, root, script, and command identity", () => {
    const manager = readFileSync(join(PULSE_DIR, "manage.sh"), "utf8");
    expect(manager).not.toContain("pkill");
    expect(manager).toContain("owned_pid()");
    expect(manager).toContain('"$BUN_PATH" run "$IDENTITY_HELPER" owned-pid');
    expect(manager).toContain('"$BUN_PATH" run "$IDENTITY_HELPER" health');
    expect(manager).toContain("registered_service_owned()");
    expect(manager).toContain("refusing to stop or replace an unowned");
  });
});
