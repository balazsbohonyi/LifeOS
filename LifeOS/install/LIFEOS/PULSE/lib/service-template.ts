import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { publishRuntimeEnvironment, resolveRuntimePaths, type RuntimePaths } from "../../TOOLS/RuntimePaths.ts";

export type PulseServiceTemplateFormat = "launchd" | "systemd";

export interface PulseServiceTemplateValues {
  runtime: RuntimePaths;
  bunPath: string;
}

function xmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n")}"`;
}

function replaceTokens(template: string, values: Record<string, string>): string {
  let rendered = template;
  for (const [token, value] of Object.entries(values)) rendered = rendered.replaceAll(`__${token}__`, value);
  const unresolved = rendered.match(/__[A-Z0-9_]+__/gu);
  if (unresolved) throw new Error(`unresolved Pulse service template tokens: ${[...new Set(unresolved)].join(", ")}`);
  return rendered;
}

export function renderPulseServiceTemplate(
  template: string,
  format: PulseServiceTemplateFormat,
  values: PulseServiceTemplateValues,
): string {
  const { runtime, bunPath } = values;
  const pulseScript = join(runtime.pulseDir, "pulse.ts");
  const stdoutPath = join(runtime.pulseDir, "logs", "pulse-stdout.log");
  const stderrPath = join(runtime.pulseDir, "logs", "pulse-stderr.log");
  for (const [name, value] of Object.entries({
    HOME: runtime.home,
    CONFIG_ROOT: runtime.configRoot,
    LIFEOS_DIR: runtime.lifeosDir,
    LIFEOS_CONFIG_PATH: runtime.configPath,
    PULSE_DIR: runtime.pulseDir,
    PULSE_SCRIPT: pulseScript,
    BUN_PATH: bunPath,
  })) {
    if (!isAbsolute(value)) throw new Error(`${name} must be absolute: ${value}`);
  }

  if (format === "launchd") {
    return replaceTokens(template, {
      BUN_PATH_XML: xmlText(bunPath),
      HOME_XML: xmlText(runtime.home),
      CONFIG_ROOT_XML: xmlText(runtime.configRoot),
      LIFEOS_DIR_XML: xmlText(runtime.lifeosDir),
      LIFEOS_CONFIG_PATH_XML: xmlText(runtime.configPath),
      PULSE_DIR_XML: xmlText(runtime.pulseDir),
      PULSE_SCRIPT_XML: xmlText(pulseScript),
      STDOUT_PATH_XML: xmlText(stdoutPath),
      STDERR_PATH_XML: xmlText(stderrPath),
      PATH_XML: xmlText(`${join(runtime.home, ".bun", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`),
    });
  }

  return replaceTokens(template, {
    EXEC_START_SYSTEMD: `${systemdQuote(bunPath)} run ${systemdQuote(pulseScript)}`,
    WORKING_DIRECTORY_SYSTEMD: systemdQuote(runtime.pulseDir),
    ENV_HOME_SYSTEMD: systemdQuote(`HOME=${runtime.home}`),
    ENV_CONFIG_ROOT_SYSTEMD: systemdQuote(`CLAUDE_CONFIG_DIR=${runtime.configRoot}`),
    ENV_LIFEOS_DIR_SYSTEMD: systemdQuote(`LIFEOS_DIR=${runtime.lifeosDir}`),
    ENV_LIFEOS_CONFIG_PATH_SYSTEMD: systemdQuote(`LIFEOS_CONFIG_PATH=${runtime.configPath}`),
    ENV_PULSE_DIR_SYSTEMD: systemdQuote(`PULSE_DIR=${runtime.pulseDir}`),
    ENV_PATH_SYSTEMD: systemdQuote(`PATH=${join(runtime.home, ".bun", "bin")}:/usr/local/bin:/usr/bin:/bin`),
    STDOUT_SYSTEMD: systemdQuote(`append:${stdoutPath}`),
    STDERR_SYSTEMD: systemdQuote(`append:${stderrPath}`),
  });
}

if (import.meta.main) {
  const [templatePath, rawFormat] = Bun.argv.slice(2);
  if (!templatePath || (rawFormat !== "launchd" && rawFormat !== "systemd")) {
    console.error("usage: bun service-template.ts TEMPLATE {launchd|systemd}");
    process.exit(2);
  }
  const runtime = resolveRuntimePaths();
  publishRuntimeEnvironment(runtime);
  const bunPath = process.env.BUN_PATH;
  if (!bunPath) throw new Error("BUN_PATH is required");
  process.stdout.write(renderPulseServiceTemplate(readFileSync(templatePath, "utf8"), rawFormat, { runtime, bunPath }));
}
