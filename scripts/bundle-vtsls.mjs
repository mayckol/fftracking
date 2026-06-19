// Stages the vtsls language server (and its pinned TypeScript) into a
// self-contained node_modules tree under src-tauri/resources/vtsls so Tauri
// bundles it as an app resource. Runs before `dev` and `build` (see
// package.json); idempotent via a version stamp so incremental builds skip the
// ~30s reinstall. The server is plain JS run with the user's system Node at
// runtime — see find_node()/vtsls_entry() in src-tauri/src/lsp.rs.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const DEST = join(REPO, "src-tauri", "resources", "vtsls");
const STAMP = join(DEST, ".vtsls-version");

// The pinned version lives in the repo package.json (single source of truth).
const rootPkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const version = rootPkg.devDependencies?.["@vtsls/language-server"];
if (!version) {
  throw new Error("@vtsls/language-server missing from devDependencies — cannot pin the bundle version.");
}

const ENTRY = join(DEST, "node_modules", "@vtsls", "language-server", "bin", "vtsls.js");
const TSSERVER = join(DEST, "node_modules", "typescript", "lib", "tsserver.js");
const SCHEMA = join(DEST, "node_modules", "@vtsls", "language-service", "configuration.schema.json");

if (existsSync(ENTRY) && existsSync(STAMP) && readFileSync(STAMP, "utf8").trim() === version) {
  process.exit(0);
}

console.log(`[bundle-vtsls] staging @vtsls/language-server@${version} → ${DEST}`);
rmSync(DEST, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

// Isolated install: its own package.json keeps the shipped tree independent of
// the repo's typescript devDep (vtsls pins its own tsserver). Let
// @vtsls/language-service pull its matching typescript — never list it here.
writeFileSync(
  join(DEST, "package.json"),
  JSON.stringify({ name: "vtsls-bundle", private: true, dependencies: { "@vtsls/language-server": version } }, null, 2),
);
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"], {
  cwd: DEST,
  stdio: "inherit",
});

for (const [label, p] of [["vtsls entry", ENTRY], ["tsserver", TSSERVER], ["config schema", SCHEMA]]) {
  if (!existsSync(p)) throw new Error(`[bundle-vtsls] expected ${label} missing after install: ${p}`);
}

writeFileSync(STAMP, version + "\n");
console.log("[bundle-vtsls] done.");
