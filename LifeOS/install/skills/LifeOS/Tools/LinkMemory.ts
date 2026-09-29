#!/usr/bin/env bun
/**
 * LinkMemory — explicitly migrate runtime-visible archives into the private
 * USER_DATA store, then link LIFEOS/MEMORY to that store.
 *
 * Preview is read-only. Applying requires both --apply and
 * --confirm-migration. Sources are retained; differing files block the apply.
 * Use --runtime-only to migrate only the active runtime tree while reporting,
 * but leaving untouched, any legacy Claude archive.
 */

import {
  closeSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveRuntimePaths } from "../../../LIFEOS/TOOLS/RuntimePaths.ts";

export interface MemoryLinkOptions {
  home: string;
  configRoot: string;
  /** The canonical private config root, normally <home>/.config/LIFEOS. */
  configDir: string;
  /** Defaults to true. False excludes the legacy Claude archive from migration. */
  includeLegacyArchive?: boolean;
  platform?: NodeJS.Platform;
}

export interface MemoryLinkPreview {
  action: "would-link" | "already-linked" | "linked" | "blocked";
  runtimeMemory: string;
  privateMemory: string;
  sources: Array<{ label: string; path: string; files: number }>;
  excludedSources: Array<{ label: string; path: string }>;
  filesToCopy: string[];
  identicalFiles: string[];
  conflicts: string[];
  skippedLinks: string[];
  errors: string[];
  requiresConfirmation: boolean;
}

interface SourceFile { source: string; label: string; relativePath: string }
const COPY_ONLY = 1; // COPYFILE_EXCL: never replace a destination file.

function samePath(a: string, b: string, platform = process.platform): boolean {
  const left = resolve(a), right = resolve(b);
  return platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function lstatOrNull(path: string) {
  try { return lstatSync(path); } catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
}

function hashFile(path: string): string {
  const fd = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally { closeSync(fd); }
  return hash.digest("hex");
}

function filesEqual(a: string, b: string): boolean {
  const aStat = statSync(a), bStat = statSync(b);
  return aStat.isFile() && bStat.isFile() && aStat.size === bStat.size && hashFile(a) === hashFile(b);
}

function inside(root: string, path: string, platform = process.platform): boolean {
  const rel = relative(root, path);
  if (rel === "") return true;
  const normalized = platform === "win32" ? rel.toLowerCase() : rel;
  return normalized !== ".." && !normalized.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function scanSource(root: string, label: string, files: SourceFile[], skippedLinks: string[], errors: string[]): number {
  const rootStat = lstatOrNull(root);
  if (!rootStat) return 0;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    errors.push(`${label}: source must be a real directory; found ${root}`);
    return 0;
  }
  let count = 0;
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = join(directory, entry.name);
      const rel = prefix ? join(prefix, entry.name) : entry.name;
      if (entry.isSymbolicLink()) { skippedLinks.push(`${label}:${rel}`); continue; }
      if (entry.isDirectory()) { walk(source, rel); continue; }
      if (!entry.isFile()) { errors.push(`${label}:${rel}: unsupported filesystem entry`); continue; }
      files.push({ source, label, relativePath: rel.split(sep).join("/") });
      count++;
    }
  };
  try { walk(root, ""); }
  catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`); }
  return count;
}

function checkDestinationAncestors(privateMemory: string, relativePath: string, platform: NodeJS.Platform, errors: string[]): void {
  let current = privateMemory;
  const rootStat = lstatOrNull(current);
  if (rootStat?.isSymbolicLink()) errors.push(`private MEMORY destination is a symlink: ${current}`);
  if (rootStat && !rootStat.isDirectory()) errors.push(`private MEMORY destination is not a directory: ${current}`);
  const parentParts = relativePath.split(/[\\/]/u).slice(0, -1);
  for (const part of parentParts) {
    current = join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) continue;
    if (stat.isSymbolicLink()) errors.push(`destination path contains a symlink: ${current}`);
    else if (!stat.isDirectory()) errors.push(`destination parent is not a directory: ${current}`);
  }
  void platform;
}

function isCorrectMemoryLink(runtimeMemory: string, privateMemory: string): boolean {
  const linkStat = lstatOrNull(runtimeMemory);
  if (!linkStat?.isSymbolicLink()) return false;
  try { return samePath(realpathSync(runtimeMemory), realpathSync(privateMemory)); }
  catch { return false; }
}

export function previewMemoryLink(options: MemoryLinkOptions): MemoryLinkPreview {
  const platform = options.platform ?? process.platform;
  const home = resolve(options.home);
  const configRoot = resolve(options.configRoot);
  const canonicalConfigDir = resolve(options.configDir);
  const runtimeMemory = join(configRoot, "LIFEOS", "MEMORY");
  const privateMemory = join(canonicalConfigDir, "USER", "MEMORY");
  const preview: MemoryLinkPreview = {
    action: "would-link", runtimeMemory, privateMemory, sources: [], excludedSources: [], filesToCopy: [],
    identicalFiles: [], conflicts: [], skippedLinks: [], errors: [], requiresConfirmation: true,
  };

  // ForeignDataCheck's fail-closed writer boundary is intentionally rooted at
  // ~/.config/LIFEOS/USER. Refuse custom targets instead of creating a link the
  // writer would later reject (or, worse, weakening that boundary implicitly).
  const expectedConfigDir = join(home, ".config", "LIFEOS");
  if (!samePath(canonicalConfigDir, expectedConfigDir, platform)) {
    preview.errors.push(`private config root must remain ${expectedConfigDir}; refusing an alternate data boundary`);
  }

  const dataRoot = join(canonicalConfigDir, "USER");
  for (const path of [join(home, ".config"), canonicalConfigDir, dataRoot]) {
    const stat = lstatOrNull(path);
    if (stat?.isSymbolicLink()) preview.errors.push(`private data path contains a symlink: ${path}`);
    else if (stat && !stat.isDirectory()) preview.errors.push(`private data path is not a directory: ${path}`);
  }
  const privateStat = lstatOrNull(privateMemory);
  if (privateStat?.isSymbolicLink()) preview.errors.push(`private MEMORY store must be a real directory: ${privateMemory}`);
  else if (privateStat && !privateStat.isDirectory()) preview.errors.push(`private MEMORY store is not a directory: ${privateMemory}`);

  const runtimeStat = lstatOrNull(runtimeMemory);
  if (inside(runtimeMemory, privateMemory, platform) || inside(privateMemory, runtimeMemory, platform)) {
    preview.errors.push("runtime and private MEMORY paths overlap; refusing a self-link or recursive migration");
  }
  let alreadyLinked = false;
  if (runtimeStat?.isSymbolicLink()) {
    if (isCorrectMemoryLink(runtimeMemory, privateMemory)) {
      alreadyLinked = true;
    } else {
      preview.errors.push(`runtime MEMORY is a broken or incorrectly targeted link: ${runtimeMemory}`);
    }
  } else if (runtimeStat && !runtimeStat.isDirectory()) {
    preview.errors.push(`runtime MEMORY exists but is not a directory: ${runtimeMemory}`);
  }
  if (options.includeLegacyArchive === false && !runtimeStat && !alreadyLinked) {
    preview.errors.push("active runtime MEMORY is missing; runtime-only mode has no source to migrate");
  }

  const sources: Array<{ label: string; path: string }> = [];
  if (runtimeStat?.isDirectory()) sources.push({ label: "active-runtime", path: runtimeMemory });
  const legacyMemory = join(home, ".claude", "LIFEOS", "MEMORY");
  if (!samePath(legacyMemory, runtimeMemory, platform)) {
    const legacyStat = lstatOrNull(legacyMemory);
    if (legacyStat && options.includeLegacyArchive === false) {
      preview.excludedSources.push({ label: "legacy-claude", path: legacyMemory });
    } else if (legacyStat?.isSymbolicLink()) preview.errors.push(`legacy Claude archive is a link; inspect it manually before migration: ${legacyMemory}`);
    else if (legacyStat) {
      try {
        const legacyReal = realpathSync(legacyMemory);
        if (!inside(realpathSync(home), legacyReal, platform)) preview.errors.push(`legacy Claude archive resolves outside the home directory: ${legacyMemory}`);
        else sources.push({ label: "legacy-claude", path: legacyMemory });
      } catch (error) {
        preview.errors.push(`could not inspect legacy Claude archive: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const sourceFiles: SourceFile[] = [];
  for (const source of sources) {
    const fileCount = scanSource(source.path, source.label, sourceFiles, preview.skippedLinks, preview.errors);
    preview.sources.push({ ...source, files: fileCount });
  }

  const byRelativePath = new Map<string, SourceFile>();
  const byCollisionKey = new Map<string, SourceFile>();
  for (const candidate of sourceFiles) {
    const collisionKey = platform === "win32" ? candidate.relativePath.toLowerCase() : candidate.relativePath;
    const previous = byCollisionKey.get(collisionKey);
    if (previous) {
      if (previous.relativePath !== candidate.relativePath) {
        preview.conflicts.push(`${candidate.relativePath}: path collides with ${previous.relativePath} on Windows`);
      } else if (!filesEqual(previous.source, candidate.source)) {
        preview.conflicts.push(`${candidate.relativePath}: differing source copies (${previous.label}, ${candidate.label})`);
      }
      continue;
    }
    byCollisionKey.set(collisionKey, candidate);
    byRelativePath.set(candidate.relativePath, candidate);
  }

  for (const [relativePath, source] of byRelativePath) {
    const destination = join(privateMemory, relativePath);
    if (!inside(privateMemory, resolve(destination), platform)) {
      preview.errors.push(`destination path escapes private MEMORY: ${relativePath}`);
      continue;
    }
    checkDestinationAncestors(privateMemory, relativePath, platform, preview.errors);
    const destinationStat = lstatOrNull(destination);
    if (!destinationStat) preview.filesToCopy.push(relativePath);
    else if (destinationStat.isSymbolicLink() || !destinationStat.isFile()) preview.conflicts.push(`${relativePath}: destination exists and is not a regular file`);
    else if (destinationStat.nlink > 1) preview.conflicts.push(`${relativePath}: destination is hard-linked outside private MEMORY`);
    else if (filesEqual(source.source, destination)) preview.identicalFiles.push(relativePath);
    else preview.conflicts.push(`${relativePath}: destination content differs from ${source.label}`);
  }

  if (preview.errors.length || preview.conflicts.length) preview.action = "blocked";
  else if (alreadyLinked && preview.filesToCopy.length === 0) {
    preview.action = "already-linked";
    preview.requiresConfirmation = false;
  }
  return preview;
}

export function applyMemoryLink(options: MemoryLinkOptions): MemoryLinkPreview & { backup?: string; copied?: number; linked?: boolean } {
  const preview = previewMemoryLink(options);
  if (preview.action === "already-linked") return { ...preview, copied: 0, linked: true };
  if (preview.errors.length || preview.conflicts.length) {
    return { ...preview, action: "blocked", errors: [...preview.errors, ...(preview.conflicts.length ? ["resolve all reported file conflicts, then preview again"] : [])], linked: false };
  }

  const platform = options.platform ?? process.platform;
  const sourceFiles: SourceFile[] = [];
  const skipped: string[] = [];
  const scanErrors: string[] = [];
  for (const source of preview.sources) scanSource(source.path, source.label, sourceFiles, skipped, scanErrors);
  if (scanErrors.length || skipped.length !== preview.skippedLinks.length) {
    return { ...preview, action: "blocked", errors: [...scanErrors, "source tree changed since preview; preview again"], linked: false };
  }
  const selected = new Map<string, SourceFile>();
  for (const file of sourceFiles) if (!selected.has(file.relativePath)) selected.set(file.relativePath, file);

  mkdirSync(dirname(preview.privateMemory), { recursive: true });
  mkdirSync(preview.privateMemory, { recursive: true });
  let copied = 0;
  try {
    for (const relativePath of preview.filesToCopy) {
      const source = selected.get(relativePath);
      if (!source) throw new Error(`source file disappeared after preview: ${relativePath}`);
      const destination = join(preview.privateMemory, relativePath);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(source.source, destination, COPY_ONLY);
      copied++;
    }
  } catch (error) {
    return { ...preview, action: "blocked", errors: [`copy stopped without replacing existing files: ${error instanceof Error ? error.message : String(error)}`], copied, linked: false };
  }

  const runtimeMemory = preview.runtimeMemory;
  if (isCorrectMemoryLink(runtimeMemory, preview.privateMemory)) {
    return { ...preview, action: "linked", requiresConfirmation: false, copied, linked: true };
  }
  const runtimeStat = lstatOrNull(runtimeMemory);
  let backup: string | undefined;
  if (runtimeStat?.isDirectory()) {
    const stamp = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID()}`;
    backup = `${runtimeMemory}.pre-private-link-${stamp}`;
    try { renameSync(runtimeMemory, backup); }
    catch (error) {
      return { ...preview, action: "blocked", errors: [`copied files to private storage but could not preserve the runtime source for linking: ${error instanceof Error ? error.message : String(error)}`], backup: undefined, copied, linked: false };
    }
  } else {
    mkdirSync(dirname(runtimeMemory), { recursive: true });
  }

  try {
    symlinkSync(preview.privateMemory, runtimeMemory, platform === "win32" ? "junction" : "dir");
    if (!isCorrectMemoryLink(runtimeMemory, preview.privateMemory)) throw new Error("created link failed target validation");
  } catch (error) {
    if (backup) {
      try { renameSync(backup, runtimeMemory); backup = undefined; }
      catch { /* report backup path; source remains recoverable there */ }
    }
    return { ...preview, action: "blocked", errors: [`could not establish the runtime MEMORY link: ${error instanceof Error ? error.message : String(error)}`], backup, copied, linked: false };
  }

  return { ...preview, action: "linked", requiresConfirmation: false, backup, copied, linked: true };
}

function main(): void {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const runtimePaths = resolveRuntimePaths({ home });
  const options: MemoryLinkOptions = {
    home,
    configRoot: value("--config-root") || runtimePaths.configRoot,
    configDir: join(home, ".config", "LIFEOS"),
    includeLegacyArchive: !args.includes("--runtime-only"),
  };
  const apply = args.includes("--apply");
  if (apply && !args.includes("--confirm-migration")) {
    console.log(JSON.stringify({ ok: false, refused: "explicit-confirmation-required", detail: "Review the preview, then rerun with --apply --confirm-migration after approval." }, null, 2));
    process.exit(2);
  }
  const result = apply ? applyMemoryLink(options) : previewMemoryLink(options);
  const ok = result.action !== "blocked" && result.errors.length === 0 && result.conflicts.length === 0;
  console.log(JSON.stringify({ ok, dryRun: !apply, ...result }, null, 2));
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) main();
