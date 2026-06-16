import { dotenvPlugin } from "./dotenv";
import { goModPlugin } from "./gomod";
import type { FFPlugin } from "./types";

// The set of plugins the app knows about. Today these are all bundled; a
// marketplace would merge fetched manifests into this list at runtime.
export const CATALOG: FFPlugin[] = [dotenvPlugin, goModPlugin];

export function findPlugin(id: string): FFPlugin | undefined {
  return CATALOG.find((p) => p.manifest.id === id);
}
