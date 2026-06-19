import { dotenvPlugin } from "./dotenv";
import { goModPlugin } from "./gomod";
import { jsxPlugin } from "./jsx";
import { makefilePlugin } from "./makefile";
import { spellPlugin } from "./spell";
import { vuePlugin } from "./vue";
import type { FFPlugin } from "./types";

// The set of plugins the app knows about. Today these are all bundled; a
// marketplace would merge fetched manifests into this list at runtime.
export const CATALOG: FFPlugin[] = [dotenvPlugin, goModPlugin, jsxPlugin, vuePlugin, makefilePlugin, spellPlugin];

export function findPlugin(id: string): FFPlugin | undefined {
  return CATALOG.find((p) => p.manifest.id === id);
}
