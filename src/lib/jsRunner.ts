// Run-command builders for the JS/TS ecosystem: package.json scripts, plain
// file execution (node / bash), and the popular test runners. Backs the run
// glyphs FileView paints on package.json, .sh/.js files and test files. The Rust
// run layer resolves node-ecosystem programs against the system Node install
// (GUI apps inherit a stripped PATH) — see src-tauri/src/run.rs.

import { api } from "./ipc";
import type { RunSpec } from "./run";

export type Pm = "npm" | "pnpm" | "yarn" | "bun";
export type TestFramework = "vitest" | "jest" | "mocha" | "node";

// The Run panel pipes stdout (not a TTY), so vitest/jest/chalk auto-disable
// color and the output renders flat. FORCE_COLOR=1 makes them emit 16-color
// ANSI — the range lib/ansi.ts renders (it ignores 256/truecolor), so level 1,
// not 3, is deliberate.
const COLOR_ENV: Record<string, string> = { FORCE_COLOR: "1" };

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}
function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(i + 1) : path;
}
async function exists(path: string): Promise<boolean> {
  return (await api.readTextFile(path).catch(() => null)) != null;
}
async function readJson(path: string): Promise<any | null> {
  try {
    const t = await api.readTextFile(path);
    return t == null ? null : JSON.parse(t);
  } catch {
    return null;
  }
}

/** Nearest ancestor directory containing a package.json (the project root where
 *  node_modules lives), bounded by `stopAt`; falls back to the file's own dir. */
export async function nearestPackageDir(fileAbsPath: string, stopAt: string | null): Promise<string> {
  const fileDir = dirOf(fileAbsPath);
  const stop = stopAt ? stopAt.replace(/\/+$/, "") : null;
  let dir = fileDir;
  for (let i = 0; i < 40; i++) {
    if (await exists(`${dir}/package.json`)) return dir;
    if (stop && dir === stop) break;
    const parent = dir.slice(0, dir.lastIndexOf("/"));
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return fileDir;
}

/** The package manager a project uses: corepack `packageManager` field first,
 *  then the lockfile, defaulting to npm. */
export async function detectPm(dir: string): Promise<Pm> {
  const pkg = await readJson(`${dir}/package.json`);
  const field: string | undefined = pkg?.packageManager;
  if (typeof field === "string") {
    if (field.startsWith("pnpm")) return "pnpm";
    if (field.startsWith("yarn")) return "yarn";
    if (field.startsWith("bun")) return "bun";
    if (field.startsWith("npm")) return "npm";
  }
  for (const [file, pm] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
  ] as [string, Pm][]) {
    if (await exists(`${dir}/${file}`)) return pm;
  }
  return "npm";
}

/** The test framework a project uses, from its (dev)dependencies. */
export async function detectTestFramework(dir: string): Promise<TestFramework | null> {
  const pkg = await readJson(`${dir}/package.json`);
  if (!pkg) return null;
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.vitest) return "vitest";
  if (deps.jest || deps["@jest/core"]) return "jest";
  if (deps.mocha) return "mocha";
  return null;
}

// The package manager's "run an installed bin" launcher. All of these live in
// (or beside) the Node install, which run.rs splices onto the child PATH.
function execLauncher(pm: Pm): { program: string; pre: string[] } {
  switch (pm) {
    case "pnpm": return { program: "pnpm", pre: ["exec"] };
    case "yarn": return { program: "yarn", pre: [] };
    case "bun": return { program: "bunx", pre: [] };
    default: return { program: "npx", pre: ["--yes"] };
  }
}

export function pkgScriptSpec(dir: string, pm: Pm, name: string): RunSpec {
  return { cwd: dir, label: `${pm} run ${name}`, program: pm, args: ["run", name], env: COLOR_ENV };
}

/** Run a standalone file: bash for shell scripts, node for plain JS. */
export function fileRunSpec(path: string, cwd: string): RunSpec | null {
  const b = baseOf(path);
  if (/\.(sh|bash)$/i.test(b)) return { cwd, label: `bash ${b}`, program: "bash", args: [b], env: COLOR_ENV };
  if (/\.(js|mjs|cjs)$/i.test(b)) return { cwd, label: `node ${b}`, program: "node", args: [b], env: COLOR_ENV };
  return null;
}

interface TestSpecArgs {
  projectDir: string;
  /** Test file path relative to projectDir. */
  relFile: string;
  pm: Pm;
  framework: TestFramework | null;
  /** A specific test/describe name to filter to; whole file when omitted. */
  testName?: string;
}

/** Build a run command for the detected framework, scoped to a file and (when
 *  given) a single test name. Falls back to the package.json `test` script when
 *  no framework is detected. */
export function testRunSpec({ projectDir, relFile, pm, framework, testName }: TestSpecArgs): RunSpec {
  if (!framework) {
    // No known runner — defer to the project's own test script.
    return { cwd: projectDir, label: `${pm} test`, program: pm, args: ["test"], env: COLOR_ENV };
  }
  const { program, pre } = execLauncher(pm);
  const scope = testName ? `"${testName}"` : "(file)";
  let args: string[];
  if (framework === "vitest") {
    args = [...pre, "vitest", "run", relFile, ...(testName ? ["-t", testName] : [])];
  } else if (framework === "jest") {
    args = [...pre, "jest", relFile, ...(testName ? ["-t", testName] : [])];
  } else if (framework === "mocha") {
    args = [...pre, "mocha", relFile, ...(testName ? ["--grep", testName] : [])];
  } else {
    // node:test — name filtering via --test-name-pattern (Node 18.17+).
    return {
      cwd: projectDir,
      label: `node --test ${scope}`,
      program: "node",
      args: ["--test", ...(testName ? ["--test-name-pattern", testName] : []), relFile],
      env: COLOR_ENV,
    };
  }
  return { cwd: projectDir, label: `${framework} ${relFile} ${scope}`, program, args, env: COLOR_ENV };
}

export function isShellOrJsFile(path: string): boolean {
  return /\.(sh|bash|js|mjs|cjs)$/i.test(baseOf(path));
}

// *.test.ts / *.spec.tsx / *.test.js … across the JS/TS extensions.
export function isJsTsTestFile(path: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(baseOf(path));
}
