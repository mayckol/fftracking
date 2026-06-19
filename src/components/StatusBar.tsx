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
  typescriptreact: "TypeScript React",
  javascriptreact: "JavaScript React",
  vue: "Vue",
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
const LSP_SERVER: Record<string, string> = {
  go: "gopls",
  typescript: "vtsls",
  javascript: "vtsls",
  typescriptreact: "vtsls",
  javascriptreact: "vtsls",
};
function lspServerName(language: string): string {
  return LSP_SERVER[language] ?? "LSP";
}
function lspLabel(phase: LspPhase, language: string): string {
  if (phase === "off") return "";
  const s = lspServerName(language);
  return phase === "starting" ? `${s} starting…` : phase === "ready" ? `${s} ready` : `${s} unavailable`;
}

function SidebarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.4" />
      <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

const TAB_ICONS: Record<string, ReactNode> = {
  files: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.5 2.5h5L12 6v7.5H3.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M8.5 2.5V6H12" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  ),
  git: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="4" cy="3.5" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="4" cy="12.5" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <circle cx="12" cy="6" r="1.7" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 5.2v5.6M4 8h4a2.3 2.3 0 0 0 2.3-2.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  plugins: (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M6 2.5a1.3 1.3 0 0 1 2.6 0v.9H11v2.4h.9a1.3 1.3 0 0 1 0 2.6H11v2.6H8.4v-.9a1.3 1.3 0 0 0-2.6 0v.9H3.2V8.4h.9a1.3 1.3 0 0 0 0-2.6h-.9V2.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  ),
  settings: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="2" />
    </svg>
  ),
};

function HistoryIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 3v5h5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3.5 4.5 6.5 8l-3 3.5" />
      <path d="M8 11.5h4.5" />
    </svg>
  );
}
const TAB_LABEL: Record<string, string> = {
  files: "Files",
  git: "Git",
  plugins: "Plugins",
  settings: "Settings",
};
// "files" is intentionally absent: the project-tree toggle (and ⌘-shortcut)
// already return to the Files view, so a dedicated Files tab is redundant.
const TAB_ORDER = ["git", "plugins", "settings"] as const;
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
  /** Terminal dock toggle, rendered as an icon button beside History. */
  terminal?: { on: boolean; onToggle: () => void } | null;
  /** Unresolved merge conflicts: > 0 marks the git icon danger. */
  conflicts?: number;
  /** Clicking the git icon while conflicts exist opens the conflicts list. */
  onShowConflicts?: () => void;
}

export default function StatusBar({ tabs = null, sidebar = null, workspace = null, terminal = null, conflicts = 0, onShowConflicts }: Props) {
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
        {terminal && (
          <button
            type="button"
            aria-pressed={terminal.on}
            className={`sb-tab sb-tgl${terminal.on ? " on" : ""}`}
            title={withCombo(terminal.on ? "Hide terminal" : "Show terminal", "terminal.toggle")}
            onClick={terminal.onToggle}
          >
            <TerminalIcon />
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
              title={`Click to restart ${lspServerName(st.language)}`}
              disabled={st.lsp === "starting" || !st.root}
              onClick={() => st.root && restartLsp(st.root)}
            >
              ● {lspLabel(st.lsp, st.language)}
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
