// A stand-in agent for the preview: node fake-agent.mjs <claude|codex|pi> <working|blocked|done|idle> <title> [screen file]
// Reports its state as that program (OSC 7501), prints the screen file, and stays.
import { readFileSync } from "node:fs";

const [app, state, title, screen] = process.argv.slice(2);
const b64 = (s) => Buffer.from(s).toString("base64");
process.stdout.write(`\x1b]2;${title}\x07`);
if (screen) process.stdout.write(readFileSync(screen, "utf8").replace(/\r?\n/g, "\r\n"));
const kind = state === "blocked" ? "blocked:kind=permission" : state;
process.stdout.write(`\x1b]7501;state=${kind}:app=${app}:msg=${b64(title)}\x1b\\`);
setInterval(() => {}, 1 << 30);
