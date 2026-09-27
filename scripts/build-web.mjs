// Builds a standalone static site in dist/ for hosting outside claude.ai (e.g. Vercel).
// claude.ai wraps app/paper-quest.html in a document skeleton at publish time; this does the same.
// Outside claude.ai there is no window.claude, so Pip can't think there: the app shows a banner saying so.
import { readFile, writeFile, mkdir, cp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const page = await readFile(path.join(root, "app", "paper-quest.html"), "utf8");
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head><body>${page}</body></html>`;
await writeFile(path.join(dist, "index.html"), html);
await cp(path.join(root, "app", "js"), path.join(dist, "js"), { recursive: true });
console.log("Built dist/ (index.html + js/)");
