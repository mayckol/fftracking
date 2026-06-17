import type { ReactNode } from "react";
import { restartLsp } from "../lib/lsp";
import { useEditorStatus, type LspPhase } from "../lib/editorStatus";
import { resetZoom, useZoomLevel, zoomPercent } from "../lib/editorZoom";
import { comboFor, formatCombo } from "../lib/shortcuts";

const LANG_LABEL: Record<string, string> = {
  go: "Go",
  rust: "Rust",
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  ruby: "Ruby",
  java: "Java",
  kotlin: "Kotlin",
  json: "JSON",
  yaml: "YAML",
  markdown: "Markdown",
  html: "HTML",
  css: "CSS",
  shell: "Shell",
  sql: "SQL",
  toml: "TOML",
};
function langLabel(id: string): string {
  return LANG_LABEL[id] ?? (id ? id[0].toUpperCase() + id.slice(1) : "Plain Text");
}
const LSP_LABEL: Record<LspPhase, string> = {
  off: "",
  starting: "gopls starting…",
  ready: "gopls ready",
  error: "gopls unavailable",
};

function SidebarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

const TAB_ICONS: Record<string, ReactNode> = {
  files: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 2.5h5L12 6v7.5H3.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8.5 2.5V6H12" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  ),
  git: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="4" cy="3.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="6" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.2v5.6M4 8h4a2.3 2.3 0 0 0 2.3-2.3" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  ),
  plugins: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 2.5a1.3 1.3 0 0 1 2.6 0v.9H11v2.4h.9a1.3 1.3 0 0 1 0 2.6H11v2.6H8.4v-.9a1.3 1.3 0 0 0-2.6 0v.9H3.2V8.4h.9a1.3 1.3 0 0 0 0-2.6h-.9V2.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  ),
  settings: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  ),
};

function HistoryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 3v5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
const TAB_LABEL: Record<string, string> = {
  files: "Files",
  git: "Git",
  plugins: "Plugins",
  settings: "Settings",
};
const TAB_ORDER = ["files", "git", "plugins", "settings"] as const;
const TAB_ACTION: Record<string, string> = {
  files: "nav.files",
  git: "nav.git",
  plugins: "nav.plugins",
  settings: "nav.settings",
};
function withCombo(label: string, action: string): string {
  const combo = formatCombo(comboFor(action));
  return combo ? `${label} (${combo})` : label;
}
function tabTitle(t: string): string {
  const action = TAB_ACTION[t];
  const combo = action ? formatCombo(comboFor(action)) : "";
  return combo ? `${TAB_LABEL[t]} (${combo})` : TAB_LABEL[t];
}

interface Props {
  /** Primary view nav (files/git/plugins/settings), rendered as icon buttons. */
  tabs?: { active: string; onSelect: (tab: string) => void } | null;
  /** Whether the project sidebar is hidden, and a toggle for it. Null hides the
   *  control entirely (tabs without a sidebar). */
  sidebar?: { hidden: boolean; onToggle: () => void } | null;
  /** Files ⇄ History toggle, shown only on the workspace tab. */
  workspace?: { historyOn: boolean; onToggle: () => void } | null;
  /** Unresolved merge conflicts: > 0 marks the git icon danger. */
  conflicts?: number;
  /** Clicking the git icon while conflicts exist opens the conflicts list. */
  onShowConflicts?: () => void;
}

export default function StatusBar({ tabs = null, sidebar = null, workspace = null, conflicts = 0, onShowConflicts }: Props) {
  const st = useEditorStatus();
  const zoomLevel = useZoomLevel();

  return (
    <div className="statusbar app-statusbar">
      <div className="sb-nav">
        {sidebar && (
          <button
            type="button"
            aria-pressed={!sidebar.hidden}
            className={`sb-tab sb-tgl${sidebar.hidden ? "" : " on"}`}
            title={withCombo(sidebar.hidden ? "Show project tree" : "Hide project tree", "nav.toggleTree")}
            onClick={sidebar.onToggle}
          >
            <SidebarIcon />
          </button>
        )}
        {sidebar && tabs && <span className="sb-div" />}
        {tabs && (
          <div className="sb-tabs" role="tablist">
            {TAB_ORDER.map((t) => {
              const danger = t === "git" && conflicts > 0;
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={tabs.active === t}
                  className={`sb-tab${tabs.active === t ? " on" : ""}${danger ? " danger" : ""}`}
                  title={danger ? `Git — ${conflicts} conflict${conflicts === 1 ? "" : "s"} to resolve` : tabTitle(t)}
                  onClick={() => {
                    tabs.onSelect(t);
                    if (danger) onShowConflicts?.();
                  }}
                >
                  {TAB_ICONS[t]}
                  {danger && <span className="sb-tab-badge">{conflicts}</span>}
                </button>
              );
            })}
          </div>
        )}
        {workspace && <span className="sb-div" />}
        {workspace && (
          <button
            type="button"
            aria-pressed={workspace.historyOn}
            className={`sb-tab sb-tgl${workspace.historyOn ? " on" : ""}`}
            title={withCombo(
              workspace.historyOn ? "Show the project files tree" : "Show history (timeline & changed files)",
              workspace.historyOn ? "nav.files" : "nav.history",
            )}
            onClick={workspace.onToggle}
          >
            <HistoryIcon />
          </button>
        )}
      </div>
      <span className="sb-spacer" />
      {st && (
        <>
          <span className="sb-lang">{langLabel(st.language)}</span>
          <span className="sb-diag" title={`${st.errors} errors, ${st.warnings} warnings`}>
            <span className={`sb-err${st.errors > 0 ? " on" : ""}`}>⊘ {st.errors}</span>
            <span className={`sb-warn${st.warnings > 0 ? " on" : ""}`}>△ {st.warnings}</span>
          </span>
          {st.lsp !== "off" && (
            <button
              type="button"
              className={`sb-lsp ${st.lsp}`}
              title="Click to restart gopls"
              disabled={st.lsp === "starting" || !st.root}
              onClick={() => st.root && restartLsp(st.root)}
            >
              ● {LSP_LABEL[st.lsp]}
            </button>
          )}
          {zoomLevel !== 0 && (
            <button
              type="button"
              className="sb-zoom"
              title={`Editor zoom ${zoomPercent(zoomLevel)}% — click to reset to 100% (${formatCombo(comboFor("editor.zoomReset"))})`}
              onClick={() => resetZoom()}
            >
              🔍 {zoomPercent(zoomLevel)}% ⟲
            </button>
          )}
          <span className="sb-pos">
            Ln {st.line}, Col {st.col}
          </span>
        </>
      )}
    </div>
  );
}
