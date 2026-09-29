#!/usr/bin/env bun
/**
 * Find executable skill examples that pin LifeOS or skill paths to a specific
 * harness config root. Descriptive prose is intentionally outside this check.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface RuntimePathViolation {
  file: string;
  line: number;
  path: string;
  text: string;
}

interface Exception {
  file: string;
  literal: string;
  reason: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HARDCODED_PATH = /(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|%HOME%)[/\\]+\.(?:claude|codex)[/\\]+(?:LIFEOS|skills)(?:[/\\]|\b)|(?:[A-Z]:[/\\](?:Users|Documents and Settings)[/\\]|\/(?:Users|home)\/)[^/\\\r\n"'`]+[/\\]+\.(?:claude|codex)[/\\]+(?:LIFEOS|skills)(?:[/\\]|\b)/giu;
const INLINE_COMMAND = /(?:^|[;|&\s`])(?:[A-Z_][A-Z0-9_]*=|bun(?:\s+run)?|node|npm|pnpm|yarn|python(?:3)?|cat|less|ls|cd|cp|mv|tee|jq|Read|Edit|Write|curl|Invoke-WebRequest)\s*/iu;
const NON_EXECUTABLE_FENCES = new Set(["text", "txt", "plaintext", "markdown", "md", "json", "jsonc", "yaml", "yml", "diff", "xml", "html", "csv", "output"]);
const EXECUTABLE_FENCES = new Set(["bash", "sh", "shell", "zsh", "powershell", "pwsh", "ps1", "cmd", "bat", "typescript", "ts", "javascript", "js", "python", "py"]);

function walkMarkdown(directory: string): string[] {
  const result: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) result.push(...walkMarkdown(path));
    else if (name.toLowerCase().endsWith(".md")) result.push(path);
  }
  return result;
}

function scanMarkdown(text: string, file: string): RuntimePathViolation[] {
  const violations: RuntimePathViolation[] = [];
  let inFence = false;
  let fenceLanguage = "";
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const fence = line.match(/^\s*(```+|~~~+)\s*([^\s`]*)/u);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceLanguage = (fence[2] ?? "").toLowerCase();
      } else {
        inFence = false;
        fenceLanguage = "";
      }
      continue;
    }

    const executable = inFence
      ? EXECUTABLE_FENCES.has(fenceLanguage)
        ? !/^\s*(?:#|\/\/|\*|$)/u.test(line)
        : !NON_EXECUTABLE_FENCES.has(fenceLanguage) && INLINE_COMMAND.test(line)
      : INLINE_COMMAND.test(line);
    if (!executable) continue;
    HARDCODED_PATH.lastIndex = 0;
    for (const match of line.matchAll(HARDCODED_PATH)) {
      violations.push({ file, line: index + 1, path: match[0], text: line.trim() });
    }
  }
  return violations;
}

function loadExceptions(path: string): Exception[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { exceptions?: Exception[] };
  return parsed.exceptions ?? [];
}

export function checkSkillRuntimePaths(options: {
  root: string;
  skillsDir?: string;
  exceptionsFile?: string;
}): { violations: RuntimePathViolation[]; exceptionsUsed: RuntimePathViolation[] } {
  const root = resolve(options.root);
  const skillDir = resolve(root, options.skillsDir ?? "LifeOS/install/skills");
  const exceptions = loadExceptions(resolve(root, options.exceptionsFile ?? "scripts/skill-runtime-path-exceptions.json"));
  const violations = walkMarkdown(skillDir).flatMap(path =>
    scanMarkdown(readFileSync(path, "utf8"), relative(root, path).replaceAll("\\", "/")),
  );

  const remaining: RuntimePathViolation[] = [];
  const exceptionsUsed: RuntimePathViolation[] = [];
  for (const violation of violations) {
    const exception = exceptions.find(candidate =>
      candidate.file === violation.file &&
      violation.path.toLowerCase() === candidate.literal.toLowerCase() &&
      candidate.reason.startsWith("Claude-only:") && candidate.reason.trim().length > "Claude-only:".length,
    );
    (exception ? exceptionsUsed : remaining).push(violation);
  }
  return { violations: remaining, exceptionsUsed };
}

if (import.meta.main) {
  const result = checkSkillRuntimePaths({ root: ROOT });
  for (const violation of result.violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.path} — ${violation.text}`);
  }
  console.log(`Checked shipped skill commands: ${result.violations.length} violation(s), ${result.exceptionsUsed.length} documented Claude-only exception(s).`);
  process.exitCode = result.violations.length ? 1 : 0;
}
