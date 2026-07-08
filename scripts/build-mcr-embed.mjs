// Builds the sibling MCR UI (../mcr/ui) with base=/mcr/ and drops the bundle into
// public/mcr/, so fftracking can load it in the embedded diff child-webview
// (src-tauri/src/mcr_embed.rs) at /mcr/index.html — served by Vite in dev and
// copied into dist/ for release. Skipped (with a warning) when the MCR sibling
// checkout is absent, so fftracking still builds without it.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mcrUi = join(root, "..", "mcr", "ui");
const dest = join(root, "public", "mcr");
const destIndex = join(dest, "index.html");

if (!existsSync(mcrUi)) {
  console.warn(`[mcr-embed] sibling MCR UI not found at ${mcrUi} — skipping.`);
  console.warn("[mcr-embed] the embedded Git-tab diff will not load until it is built.");
  process.exit(0);
}

// Newest mtime under the MCR UI sources (skip node_modules/dist).
function newestSource(dir) {
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const s = statSync(p);
    newest = Math.max(newest, s.isDirectory() ? newestSource(p) : s.mtimeMs);
  }
  return newest;
}

if (existsSync(destIndex) && newestSource(mcrUi) <= statSync(destIndex).mtimeMs) {
  console.log("[mcr-embed] public/mcr is up to date — skipping rebuild.");
  process.exit(0);
}

const run = (args) =>
  execFileSync("npm", args, { cwd: mcrUi, stdio: "inherit", env: { ...process.env, MCR_BASE: "/mcr/" } });

if (!existsSync(join(mcrUi, "node_modules"))) {
  console.log("[mcr-embed] installing MCR UI dependencies…");
  run(["install"]);
}

console.log("[mcr-embed] building MCR UI (base=/mcr/)…");
run(["run", "build"]);

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(mcrUi, "dist"), dest, { recursive: true });
console.log(`[mcr-embed] copied MCR UI → ${dest}`);
