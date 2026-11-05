// local change: the viewer's "Page" mode: the HTML file as Chromium draws it. A headless Chrome / Edge / Chromium on
// this computer (shot.mjs, through node, finds it) takes the whole page as one picture; the viewer shows it in the app's cache.
// The page comes from serve.js's server for its folder (and its tunnel, on another machine), as "Open in browser";
// file:// only when there's no server to be had here.
import { exec, appHome } from "herdr";
import * as fs from "fs/promises";
import { ensure, pageUrl } from "./serve.js";

export const PAGE_WIDTH = 778; // the viewer window's body, in CSS pixels: the picture shows 1:1

const slashes = (s) => String(s).replace(/\\/g, "/");
const fileUrl = (full) => {
  const f = slashes(full);
  return "file://" + (f.startsWith("/") ? "" : "/") + encodeURI(f).replace(/#/g, "%23").replace(/\?/g, "%3F");
};

// Resolves with { image (a path for image()), width, height, cut }, or throws what went wrong.
export async function shoot(root, path, on, cx) {
  // Through the folder's server here too: file:// pages can't fetch(). Without python here, file:// all the same.
  const url = on ? pageUrl(await ensure(root, on, cx), path)
    : await ensure(root, on, cx).then((port) => pageUrl(port, path), () => fileUrl(`${root}/${path}`));
  return shootUrl(url);
}

// Any address this computer's browser can reach (a web page, a dev server on localhost).
export async function shootUrl(url) {
  const b = "auto"; // shot.mjs looks: a mod's fs can't see outside the home folder (Program Files)
  const dir = slashes(`${appHome()}/cache/t3-files`), id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await fs.mkdir(dir, { recursive: true });
  // Pictures a viewer left behind (a reload doesn't call close): gone after a day.
  for (const n of await fs.readdir(dir).catch(() => [])) {
    const t = /^page-([0-9a-z]+?)[0-9a-z]{4}\.png$/.exec(n);
    if (t && Date.now() - parseInt(t[1], 36) > 864e5) await fs.rm(`${dir}/${n}`, { force: true }).catch(() => null);
  }
  const r = await exec("node", [slashes(`${appHome()}/mods/t3-files/shot.mjs`), b, `${dir}/chrome-${id}`, url, `${dir}/page-${id}.png`, String(PAGE_WIDTH)])
    .catch((e) => ({ code: -1, stdout: "", stderr: /ENOENT|not found/i.test(String(e)) ? "Page needs node 22 or later on this computer" : String(e?.message ?? e) }));
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Chromium didn't draw the page").trim().split(/\r?\n/).pop());
  const [w, h, cut] = r.stdout.trim().split(/\s+/);
  return { image: `cache/t3-files/page-${id}.png`, width: Number(w), height: Number(h), cut: cut === "cut" };
}

// The picture of a page no viewer shows any more.
export const dropShot = (image) => image && fs.rm(`${appHome()}/${image}`, { force: true }).catch(() => null);
