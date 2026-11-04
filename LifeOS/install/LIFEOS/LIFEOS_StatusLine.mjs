#!/usr/bin/env node
// LifeOS Status Line (Node port). Written for Windows, where bash and jq cannot be
// assumed, but it runs anywhere bun or Node does. Dependency-free: no bash or jq.
// Same colors and data sources as LIFEOS_StatusLine.sh, minus the interview-due and
// background-agent lines.
//
// Output:
//   LifeOS <ver> | ALGO <ver> | <model> | <effort> | <flag CITY, REGION> | <time> <weather>
//   CONTEXT: <bar> <pct>%  |  5H <pct>%  7D <pct>%   (usage only when the harness sends it)
//   <dir> on <branch> (<n> changed)
//   STATE: HEALTH n% | CREATIVITY n% | FREEDOM n% | RELS n% | FIN n%
//   <doctor warning>   (only when the Doctor sidecar has content)
//   🧠 <memory loop status>
//   "<quote>" —<author>
//
// Network: only the weather and location refresh, and never on the render path. The
// render reads cached files; when they are stale it starts a detached copy of this
// script with --refresh (hidden window, own lock, 2-minute retry gap) and keeps going.
// A location set in settings.json (.location.city/.lat/.lon/...) is used as is and
// skips the IP lookup; without one, ip-api.com is asked, as in the bash version.
// Temperature unit: settings.json preferences.temperatureUnit ("celsius" | "fahrenheit"),
// else chosen from the location's country (Fahrenheit only in the US and a few others).
// Caches live in the same folder as the bash version, so the two share them.

import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync, rmSync,
  openSync, readSync, closeSync, fstatSync,
} from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { dirname, join, basename } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const LIFEOS_DIR = dirname(SCRIPT);
const CLAUDE_HOME = dirname(LIFEOS_DIR);
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "lifeos-statusline");
const LOCATION_CACHE = join(CACHE_DIR, "location-cache.json");
const WEATHER_CACHE = join(CACHE_DIR, "weather-cache.json"); // plain text despite the name; same file as the bash version
const REFRESH_MARK = join(CACHE_DIR, "refresh-attempt");
const REFRESH_LOCK = join(CACHE_DIR, "locwx-refresh.lock");
const LOCATION_TTL_S = 3600;
const WEATHER_TTL_S = 900;
const RETRY_GAP_S = 120;

const readText = (p) => {
  try { return readFileSync(p, "utf8").trim(); } catch { return ""; }
};
const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
};
const ageSeconds = (p) => {
  try { return (Date.now() - statSync(p).mtimeMs) / 1000; } catch { return Infinity; }
};
const num = (v, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
// Strip terminal escapes from anything read from disk so a tampered file cannot inject them.
const clean = (s) => String(s).replace(/[\x00-\x1f\x7f]/g, "");

const settings = readJson(join(CLAUDE_HOME, "settings.json")) ?? {};

// Unit: an explicit settings.json preferences.temperatureUnit wins. Otherwise Fahrenheit
// only where it is in everyday use (by the location's country, else the system locale),
// and Celsius everywhere else. Unlike the bash version, which always defaults to Fahrenheit.
const FAHRENHEIT_COUNTRIES = new Set(["US", "LR", "BS", "BZ", "KY", "PW", "FM", "MH", "PR", "GU", "VI", "AS", "MP"]);
function systemRegion() {
  try { return new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).maximize().region ?? ""; } catch { return ""; }
}
function tempUnit() {
  const pref = settings.preferences?.temperatureUnit;
  if (pref === "celsius" || pref === "fahrenheit") return pref;
  const country = String(settings.location?.countryCode || readJson(LOCATION_CACHE)?.countryCode || systemRegion()).toUpperCase();
  return FAHRENHEIT_COUNTRIES.has(country) ? "fahrenheit" : "celsius";
}
const unitSuffix = (unit) => (unit === "celsius" ? "°C" : "°F");

// ── background refresh: location and weather (runs as `--refresh`, never on the render path)

const WEATHER_ICONS = (code, isDay) => {
  if (code === 0) return isDay ? "☀️" : "🌙";
  if (code === 1 || code === 2) return isDay ? "🌤️" : "☁️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "🌧️";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "🌨️";
  if ([95, 96, 99].includes(code)) return "⛈️";
  return "🌡️";
};

async function fetchJson(url, timeoutMs) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function refresh() {
  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    mkdirSync(REFRESH_LOCK);
  } catch {
    // Lock held: clear it only when stale (>30 s), else another refresh is running.
    if (ageSeconds(REFRESH_LOCK) <= 30) return;
    try { rmSync(REFRESH_LOCK, { recursive: true, force: true }); mkdirSync(REFRESH_LOCK); } catch { return; }
  }
  try {
    const configured = settings.location ?? {};
    if (configured.city) {
      // User-configured location is authoritative: no IP lookup.
      writeFileSync(LOCATION_CACHE, JSON.stringify({
        city: String(configured.city), regionName: String(configured.regionName ?? ""),
        countryCode: String(configured.countryCode ?? ""),
        lat: configured.lat ?? null, lon: configured.lon ?? null,
      }));
    } else if (ageSeconds(LOCATION_CACHE) > LOCATION_TTL_S) {
      const loc = await fetchJson("http://ip-api.com/json/?fields=city,region,regionName,country,countryCode,lat,lon", 3000);
      if (loc?.city) writeFileSync(LOCATION_CACHE, JSON.stringify(loc));
    }

    const unit = tempUnit(); // after the location cache is written: it carries the country
    const suffix = unitSuffix(unit);
    const cached = readText(WEATHER_CACHE);
    if (ageSeconds(WEATHER_CACHE) > WEATHER_TTL_S || (cached && !cached.endsWith(suffix))) {
      const loc = readJson(LOCATION_CACHE);
      if (loc && loc.lat != null && loc.lon != null) {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(loc.lat)}&longitude=${encodeURIComponent(loc.lon)}` +
          `&current=temperature_2m,weather_code,is_day&temperature_unit=${unit}`;
        const wx = await fetchJson(url, 4000);
        const cur = wx?.current;
        if (cur && typeof cur.temperature_2m === "number") {
          writeFileSync(WEATHER_CACHE, `${WEATHER_ICONS(cur.weather_code, cur.is_day === 1)} ${Math.trunc(cur.temperature_2m)}${suffix}`);
        }
      }
    }
  } finally {
    try { rmSync(REFRESH_LOCK, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

if (process.argv.includes("--refresh")) {
  await refresh();
  process.exit(0);
}

// ── render

const rgb = (r, g, b) => `\x1b[38;2;${r};${g};${b}m`;
const RESET = "\x1b[0m";
const C = {
  p: rgb(37, 99, 235),
  a: rgb(59, 130, 246),
  i: rgb(147, 197, 253),
  time: rgb(96, 165, 250),
  slate4: rgb(148, 163, 184),
  slate5: rgb(100, 116, 139),
  slate6: rgb(71, 85, 105),
  label: rgb(148, 163, 184),
  ctx: rgb(165, 180, 252),
  empty: rgb(75, 82, 95),
  green: rgb(74, 222, 128),
  amber: rgb(251, 191, 36),
  orange: rgb(251, 146, 60),
  red: rgb(239, 68, 68),
  region: rgb(125, 211, 252),
  weather: rgb(135, 206, 235),
  sage: rgb(167, 184, 148),
  author: rgb(180, 140, 60),
};
const SEP = ` ${C.slate6}│${RESET} `;

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* no stdin: render with defaults */ }

const cwd = input.workspace?.current_dir ?? input.cwd ?? process.cwd();
const model = input.model?.display_name ?? "unknown";
const effort = input.effort?.level ?? "";
const ctxMax = num(input.context_window?.context_window_size, 200000);
const ctxPct = Math.max(0, Math.min(100, num(input.context_window?.used_percentage)));
const rl = input.rate_limits ?? {};
const pctOf = (o) => o ? (o.used_percentage ?? o.utilization) : undefined;

const pctColor = (p) => (p >= 80 ? C.red : p >= 60 ? C.orange : p >= 40 ? C.amber : C.green);
const now = new Date();
const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

// Location + weather from cache; start a detached refresh when either is stale.
const locAge = ageSeconds(LOCATION_CACHE);
const wxAge = ageSeconds(WEATHER_CACHE);
const cachedWeather = readText(WEATHER_CACHE);
const weatherWrongUnit = cachedWeather !== "" && !cachedWeather.endsWith(unitSuffix(tempUnit()));
if ((locAge > LOCATION_TTL_S || wxAge > WEATHER_TTL_S || weatherWrongUnit) && ageSeconds(REFRESH_MARK) > RETRY_GAP_S) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(REFRESH_MARK, String(Date.now()));
    spawn(process.execPath, [SCRIPT, "--refresh"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch { /* cannot refresh: render from whatever is cached */ }
}
const loc = readJson(LOCATION_CACHE);
// Windows has no flag emoji glyphs (the two letters render as a stray symbol), so there the
// country code is printed instead of the flag.
const countryTag = (cc) => {
  const up = String(cc ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(up)) return "";
  if (process.platform === "win32") return `${C.slate5}${up}${RESET} `;
  return `${String.fromCodePoint(0x1f1e6 + up.charCodeAt(0) - 65, 0x1f1e6 + up.charCodeAt(1) - 65)} `;
};
const locPart = loc?.city
  ? `${countryTag(loc.countryCode)}${C.p}${clean(loc.city).toUpperCase()}${RESET}` +
    (loc.region || loc.regionName ? `${C.slate6}, ${RESET}${C.region}${clean(loc.region || loc.regionName).toUpperCase()}${RESET}` : "")
  : `🌐 ${C.p}UNKNOWN${RESET}`;
const weatherText = clean(cachedWeather && !weatherWrongUnit ? cachedWeather : "—");

// Line 1: header
const lifeosVer = readText(join(LIFEOS_DIR, "VERSION")) || "—";
const algoVer = readText(join(LIFEOS_DIR, "ALGORITHM", "LATEST")) || "—";
const header = [
  `${C.p}Li${C.a}fe${C.i}OS${RESET} ${C.label}${clean(lifeosVer)}${RESET}`,
  `${C.label}ALGO${RESET} ${C.a}${clean(algoVer)}${RESET}`,
  `${C.a}${clean(model)}${RESET}`,
  ...(effort ? [`${C.label}${clean(effort)}${RESET}`] : []),
  locPart,
  `${C.time}${hhmm}${RESET} ${C.weather}${weatherText}${RESET}`,
].join(SEP);

// Line 2: context bar + usage
const CELLS = 24;
const filled = Math.round((ctxPct / 100) * CELLS);
const bar = Array.from({ length: CELLS }, (_, i) =>
  `${i < filled ? pctColor(ctxPct) : C.empty}⛁`).join("") + RESET;
const usedTok = Math.round((ctxPct / 100) * ctxMax);
const tok = usedTok >= 1000 ? `${(usedTok / 1000).toFixed(0)}K` : String(usedTok);
let ctxLine = `${C.ctx}CONTEXT:${RESET} ${bar} ${pctColor(ctxPct)}${ctxPct.toFixed(0)}%${RESET} ${C.slate5}${tok}/${Math.round(ctxMax / 1000)}K${RESET}`;
const five = pctOf(rl.five_hour);
const seven = pctOf(rl.seven_day);
if (typeof five === "number") ctxLine += SEP + `${C.label}5H${RESET} ${pctColor(five)}${five.toFixed(0)}%${RESET}`;
if (typeof seven === "number") ctxLine += ` ${C.label}7D${RESET} ${pctColor(seven)}${seven.toFixed(0)}%${RESET}`;
const cost = num(input.cost?.total_cost_usd);
if (cost > 0) ctxLine += SEP + `${C.label}$${cost.toFixed(2)}${RESET}`;

// Line 3: directory + git
let gitPart = "";
try {
  const out = execFileSync("git", ["--no-optional-locks", "-C", cwd, "status", "--porcelain", "-b"], {
    encoding: "utf8", timeout: 1500, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  }).split("\n").filter(Boolean);
  const head = (out[0] ?? "").replace(/^## /, "").replace(/^No commits yet on /, "");
  const branch = head.split("...")[0];
  const changed = out.length - 1;
  if (branch) {
    gitPart = ` ${C.slate5}on${RESET} ${C.i}${clean(branch)}${RESET}` +
      (changed > 0 ? ` ${C.amber}(${changed} changed)${RESET}` : "");
  }
} catch { /* not a repo, git missing, or slow: skip */ }
const dirLine = `${C.label}${clean(basename(cwd) || cwd)}${RESET}${gitPart}`;

// Line 4: TELOS state
const state = readJson(join(LIFEOS_DIR, "USER", "TELOS", "LIFEOS_STATE.json"))?.dimensions ?? {};
const dims = [
  ["HEALTH", state.health?.pct],
  ["CREATIVITY", state.creative?.pct],
  ["FREEDOM", state.freedom?.pct],
  ["RELS", state.relationships?.pct],
  ["FIN", state.finances?.pct ?? state.money?.pct],
];
const stateLine = `${C.slate5}STATE:${RESET} ` + dims.map(([label, pct]) =>
  typeof pct === "number"
    ? `${C.ctx}${label}${RESET} ${pctColor(100 - pct)}${Math.floor(pct)}%${RESET}`
    : `${C.ctx}${label}${RESET} ${C.slate5}N/A${RESET}`).join(SEP);

const lines = [header, ctxLine, dirLine, stateLine];

// Doctor sidecar (written by LIFEOS/TOOLS/Doctor.ts; empty when healthy or acknowledged)
const doctor = readText(join(LIFEOS_DIR, "MEMORY", "STATE", "capabilities-statusline.txt"));
if (doctor) lines.push(`${C.amber}${clean(doctor)}${RESET}`);

// Memory loop: one plain-English line from the autonomic memory state files.
const OBS = join(LIFEOS_DIR, "MEMORY", "OBSERVABILITY");
const tailJson = (p, maxBytes = 262144) => {
  let fd;
  try {
    fd = openSync(p, "r");
    const { size } = fstatSync(fd);
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const rows = buf.toString("utf8").split("\n").filter((l) => l.trim());
    return rows.length ? JSON.parse(rows[rows.length - 1]) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
};
const shortAge = (s) => {
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d >= 1 ? `${d}d` : h >= 1 ? `${h}h` : `${m}m`;
};
const memoryChars = (p) => {
  // Bytes of body text after the second `---`, skipping blank lines and HTML-comment lines.
  let c = 0, bytes = 0;
  for (const line of readText(p).split("\n")) {
    if (line === "---") { c++; continue; }
    if (c === 2 && line.trim() && !line.startsWith("<!--") && !line.startsWith("-->")) bytes += Buffer.byteLength(line) + 1;
  }
  return bytes;
};
const review = readJson(join(OBS, "review-state.json"));
if (review) {
  const turns = num(review.turn_count_since_last_review);
  const pending = review.pending_review === true;
  const threshold = num(readJson(join(LIFEOS_DIR, "USER", "CONFIG", "memory-review.json"))?.turn_threshold, 8);
  const lastMs = review.last_review_at ? Date.parse(review.last_review_at) : NaN;
  const hasReview = Number.isFinite(lastMs);
  const ageSec = hasReview ? Math.max(0, Math.floor((Date.now() - lastMs) / 1000)) : 0;
  const age = hasReview ? shortAge(ageSec) : "never";

  const health = tailJson(join(OBS, "memory-health.jsonl"));
  const overall = health?.overall ?? "ok";
  const detail = health?.findings?.[0]?.message ?? "";
  const run = tailJson(join(OBS, "reviewer-runs.jsonl"));
  const dispatched = run?.ok === true ? num(run.dispatch_summary?.succeeded) : 0;
  const pct = Math.floor(((memoryChars(join(LIFEOS_DIR, "USER", "PRINCIPAL", "PRINCIPAL_MEMORY.md")) +
    memoryChars(join(LIFEOS_DIR, "USER", "DIGITAL_ASSISTANT", "DA_MEMORY.md"))) * 100) / 24576);

  let color = C.sage, text;
  if (overall === "critical") { color = C.red; text = `PROBLEM · ${detail || "RUN MEMORYHEALTHCHECK"}`; }
  else if (overall === "warn") { color = C.amber; text = `NEEDS ATTENTION · ${detail || "RUN MEMORYHEALTHCHECK"}`; }
  else if (hasReview && ageSec <= 30 && dispatched > 0) text = `SAVED ${dispatched} NEW MEMORIES JUST NOW · ${pct}% FULL`;
  else if (pending) text = `REVIEW QUEUED, RUNS AT NEXT PAUSE · LAST REVIEW ${age} AGO`;
  else if (turns >= threshold) text = `REVIEW DUE, WAITING FOR A QUIET MOMENT · LAST ${age} AGO`;
  else if (!hasReview) text = `NO REVIEWS YET · FIRST ONE AFTER ${threshold} TURNS`;
  else text = `OK · REVIEWED ${age} AGO · NEXT IN ${threshold - turns} TURNS · ${pct}% FULL`;
  text = clean(text).toUpperCase();
  if (text.length > 68) text = `${text.slice(0, 67)}…`;
  lines.push(`🧠  ${color}${text}${RESET}`);
}

// Quote: same line for a whole minute, picked from the curated corpus ("text|author" per line).
const quotes = readText(join(LIFEOS_DIR, "USER", "PRINCIPAL", "Quotes.txt")).split("\n").filter(Boolean);
if (quotes.length) {
  const line = quotes[Math.floor(Date.now() / 1000 / 60) % quotes.length];
  const sep = line.indexOf("|");
  if (sep > 0 && sep < line.length - 1) {
    lines.push(`${C.slate4}"${clean(line.slice(0, sep))}"${RESET} ${C.author}—${clean(line.slice(sep + 1))}${RESET}`);
  }
}

process.stdout.write(lines.join("\n") + "\n");
