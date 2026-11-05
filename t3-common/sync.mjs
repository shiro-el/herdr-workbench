// A mod can import only its own files, so each mod that uses this code gets a copy in its common/ folder.
//   node t3-common/sync.mjs           copies, and writes common/where.js (which mod it is in)
//   node t3-common/sync.mjs --check   says which copies differ from here; exit 1 if any do
// Edit the files here, never a mod's copy.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), mods = join(here, "..", "mods");
const FILES = ["platform.js", "fsx.js", "paths.js", "fsq.mjs"];
const MODS = ["t3-files", "t3-spotlight"];
const HEAD = "// Copied from ~/.config/herdr-app/t3-common by sync.mjs: edit it there.\n";
const check = process.argv.includes("--check");

let off = 0;
for (const mod of MODS) {
  const dir = join(mods, mod, "common");
  const want = new Map(FILES.map((f) => [f, HEAD + readFileSync(join(here, f), "utf8")]));
  want.set("where.js", `${HEAD}export const MOD = ${JSON.stringify(mod)};\n`);
  for (const [f, text] of want) {
    const to = join(dir, f), has = existsSync(to) ? readFileSync(to, "utf8") : null;
    if (has === text) continue;
    if (check) { off++; console.log(`${has === null ? "missing" : "differs"}: mods/${mod}/common/${f}`); continue; }
    mkdirSync(dir, { recursive: true });
    writeFileSync(to, text);
    console.log(`wrote mods/${mod}/common/${f}`);
  }
}
if (check) { console.log(off ? `${off} out of date: run node t3-common/sync.mjs` : "all copies match"); process.exit(off ? 1 : 0); }
