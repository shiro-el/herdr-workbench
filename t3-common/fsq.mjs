// What a mod's fs can't see on Windows here (outside the home folder), for fsx.js. Run with node:
//   node fsq.mjs stat <path>...                 one "d|f|-<TAB>path" line each
//   node fsq.mjs list <dir> [limit] [skipGit]   one "d|f<TAB>name" line per entry (a link counts as what it points to)
import { statSync, readdirSync } from "node:fs";

const [cmd, ...args] = process.argv.slice(2);
const out = [];
const kind = (p) => { try { return statSync(p).isDirectory() ? "d" : "f"; } catch { return "-"; } };
if (cmd === "stat") for (const p of args) out.push(`${kind(p)}\t${p}`);
else if (cmd === "list") {
  const [dir, limit = "3000", skipGit = "0"] = args;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (skipGit === "1" && e.name === ".git") continue;
      if (out.length >= Number(limit)) break;
      out.push(`${e.isSymbolicLink() ? (kind(`${dir}/${e.name}`) === "d" ? "d" : "f") : e.isDirectory() ? "d" : "f"}\t${e.name}`);
    }
  } catch (e) { process.stderr.write(String(e?.message ?? e)); process.exit(1); }
}
process.stdout.write(out.join("\n"));
