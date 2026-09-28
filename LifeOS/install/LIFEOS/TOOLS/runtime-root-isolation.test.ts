import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { home: string; selected: string; decoy: string } {
  const root = mkdtempSync(join(tmpdir(), "lifeos-runtime-isolation-"));
  created.push(root);
  const home = join(root, "home");
  const selected = join(home, "selected config");
  const decoy = join(home, ".claude");
  mkdirSync(join(selected, "LIFEOS", "USER", "CONFIG"), { recursive: true });
  mkdirSync(join(decoy, "LIFEOS", "MEMORY", "LEARNING", "SIGNALS"), { recursive: true });
  return { home, selected, decoy };
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const relative = path.slice(root.length + 1);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative] = readFileSync(path, "utf8");
    }
  };
  walk(root);
  return out;
}

async function runTool(script: string, args: string[], roots: { home: string; selected: string }): Promise<{ code: number; output: string }> {
  const {
    LIFEOS_DIR: _lifeosDir,
    LIFEOS_CONFIG_PATH: _configPath,
    CLAUDE_CONFIG_DIR: _configRoot,
    CODEX_HOME: _codexHome,
    PULSE_DIR: _pulseDir,
    ...baseEnv
  } = process.env;
  const proc = Bun.spawn([process.execPath, "run", join(import.meta.dir, script), ...args], {
    env: {
      ...baseEnv,
      HOME: roots.home,
      USERPROFILE: roots.home,
      CLAUDE_CONFIG_DIR: roots.selected,
      LIFEOS_CONFIG_PATH: join(roots.selected, "LIFEOS", "USER", "CONFIG", "LIFEOS_CONFIG.toml"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code, output: `${stdout}\n${stderr}` };
}

describe("selected runtime root isolation", () => {
  test("SessionHarvester discovers only the selected root and never mutates the .claude decoy", async () => {
    const roots = fixture();
    const decoyProjects = join(roots.decoy, "projects", roots.decoy.replace(/[\\/.:]/g, "-"));
    mkdirSync(decoyProjects, { recursive: true });
    writeFileSync(join(decoyProjects, "decoy.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { content: "Key insight: this transcript belongs only to the decoy root." },
    }) + "\n");
    const before = snapshot(roots.decoy);

    const empty = await runTool("SessionHarvester.ts", ["--recent", "10", "--dry-run"], roots);
    expect(empty.code).toBe(0);
    expect(empty.output).toContain("No sessions found to harvest");
    expect(empty.output).not.toContain("decoy");

    const selectedProjects = join(roots.selected, "projects", roots.selected.replace(/[\\/.:]/g, "-"));
    mkdirSync(selectedProjects, { recursive: true });
    writeFileSync(join(selectedProjects, "selected.jsonl"), JSON.stringify({
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: { content: "Key insight: this transcript belongs to the selected installation." },
    }) + "\n");
    const selected = await runTool("SessionHarvester.ts", ["--recent", "10", "--dry-run"], roots);
    expect(selected.code).toBe(0);
    expect(selected.output).toContain("Found 1 learning(s)");
    expect(snapshot(roots.decoy)).toEqual(before);
  });

  test("LearningPatternSynthesis ignores populated decoy signals and writes dry-run state only under the selected root", async () => {
    const roots = fixture();
    const ratingsPath = join(roots.decoy, "LIFEOS", "MEMORY", "LEARNING", "SIGNALS", "ratings.jsonl");
    const now = new Date().toISOString();
    const ratings = Array.from({ length: 6 }, (_, index) => JSON.stringify({
      timestamp: now,
      rating: 2,
      session_id: `decoy-${index}`,
      source: "explicit",
      sentiment_summary: "The same tool failure happened again and remains broken",
      confidence: 1,
    })).join("\n") + "\n";
    writeFileSync(ratingsPath, ratings);
    const before = snapshot(roots.decoy);

    const result = await runTool(
      "LearningPatternSynthesis.ts",
      ["--hypothesize", "--dry-run", "--no-inference"],
      roots,
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("emitted=0");
    expect(snapshot(roots.decoy)).toEqual(before);
    expect(statSync(join(roots.selected, "LIFEOS", "MEMORY", "WISDOM", "FRAMES", "_hypotheses")).isDirectory()).toBe(true);
  });
});
