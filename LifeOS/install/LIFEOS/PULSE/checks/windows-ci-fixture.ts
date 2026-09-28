import { writeFile } from "node:fs/promises";

const markerPath = process.argv.at(-1);
if (!markerPath) throw new Error("expected marker path as the first argument");
await writeFile(markerPath, `scheduled fixture ran at ${new Date().toISOString()}\n`, "utf8");
