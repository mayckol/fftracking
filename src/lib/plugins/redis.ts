import type { FFPlugin } from "./types";

// Stable id the Redis view gates on (App shows the Redis tab only when this
// plugin is installed + enabled). The plugin carries no Monaco contribution —
// it's a marker manifest that surfaces a whole panel, not a language.
export const REDIS_PLUGIN_ID = "redis-cache";

export const redisPlugin: FFPlugin = {
  manifest: {
    id: REDIS_PLUGIN_ID,
    name: "Redis Cache",
    description: "Browse keys, view and edit values, set TTLs, and run commands against a Redis server.",
    version: "1.0.0",
    author: "fftracking",
    source: "bundled",
    // Off until the user opts in: it opens network connections and stores
    // credentials in the OS keychain, so it shouldn't run unannounced.
    defaultInstalled: false,
    note:
      "Connection passwords are stored in your OS keychain, which must be unlocked/allowed: " +
      "macOS prompts for Keychain access, Windows uses Credential Manager automatically, and " +
      "Linux needs a Secret Service daemon (GNOME Keyring or KWallet). Where no keychain is " +
      "available, fftracking falls back to asking for the password on each connect.",
  },
};
