// Export / import of app settings. Backend settings (capture, retention, …)
// round-trip through the get_settings / set_setting commands; everything else
// lives in localStorage and is copied verbatim. The bundle is a plain JSON file
// the user picks sections of.

import { api } from "./ipc";
import type { Settings } from "./types";

export interface TransferSection {
  id: string;
  label: string;
  hint: string;
  /** localStorage keys this section owns (empty for the backend section). */
  keys: string[];
  backend?: boolean;
}

export const TRANSFER_SECTIONS: TransferSection[] = [
  { id: "capture", label: "Capture & retention", hint: "Snapshot interval, retention, disk cap, ignore globs", keys: [], backend: true },
  { id: "appearance", label: "Appearance & editor", hint: "Theme, icons, fonts, tabs, save & keymap style", keys: ["ff.uiPrefs"] },
  { id: "shortcuts", label: "Keyboard shortcuts", hint: "Custom keybindings", keys: ["ff.shortcuts"] },
  { id: "plugins", label: "Plugins", hint: "Installed & enabled plugins", keys: ["ff.plugins"] },
  { id: "confirms", label: "Suppressed confirmations", hint: "“Don’t ask again” choices", keys: ["ff.suppressedConfirms"] },
  { id: "breakpoints", label: "Breakpoints", hint: "Debugger breakpoints", keys: ["ff.breakpoints"] },
  { id: "history", label: "Recent runs & watches", hint: "Run/debug history, pins & watch expressions", keys: ["ff.exec.run", "ff.exec.debug", "ff.watches"] },
];

interface SectionPayload {
  backend?: Record<string, string>;
  local?: Record<string, string>;
}

export interface SettingsBundle {
  app: "fftracking";
  kind: "settings";
  version: 1;
  exportedAt: string;
  sections: Record<string, SectionPayload>;
}

function backendToStrings(s: Settings): Record<string, string> {
  return {
    max_disk_gb: String(s.max_disk_gb),
    retention_days: String(s.retention_days),
    snapshots_per_past_day: String(s.snapshots_per_past_day),
    default_interval_secs: String(s.default_interval_secs),
    event_min_gap_secs: String(s.event_min_gap_secs),
    ignore_globs: s.ignore_globs.join("\n"),
    respect_gitignore: s.respect_gitignore ? "1" : "0",
  };
}

export async function buildExport(ids: string[], exportedAt: string): Promise<SettingsBundle> {
  const sections: Record<string, SectionPayload> = {};
  for (const sec of TRANSFER_SECTIONS) {
    if (!ids.includes(sec.id)) continue;
    if (sec.backend) {
      sections[sec.id] = { backend: backendToStrings(await api.getSettings()) };
    } else {
      const local: Record<string, string> = {};
      for (const k of sec.keys) {
        const v = localStorage.getItem(k);
        if (v != null) local[k] = v;
      }
      sections[sec.id] = { local };
    }
  }
  return { app: "fftracking", kind: "settings", version: 1, exportedAt, sections };
}

export function parseBundle(text: string): SettingsBundle {
  const b = JSON.parse(text) as Partial<SettingsBundle>;
  if (!b || b.app !== "fftracking" || b.kind !== "settings" || typeof b.sections !== "object" || b.sections == null) {
    throw new Error("Not a fftracking settings file");
  }
  return b as SettingsBundle;
}

/** Section ids actually present (with a payload) in a bundle. */
export function sectionsInBundle(b: SettingsBundle): string[] {
  return TRANSFER_SECTIONS.filter((s) => b.sections[s.id]).map((s) => s.id);
}

export async function applyImport(b: SettingsBundle, ids: string[]): Promise<void> {
  for (const sec of TRANSFER_SECTIONS) {
    if (!ids.includes(sec.id)) continue;
    const payload = b.sections[sec.id];
    if (!payload) continue;
    if (sec.backend && payload.backend) {
      for (const [k, v] of Object.entries(payload.backend)) await api.setSetting(k, String(v));
    } else if (payload.local) {
      for (const [k, v] of Object.entries(payload.local)) localStorage.setItem(k, String(v));
    }
  }
}
