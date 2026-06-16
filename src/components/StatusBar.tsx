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

interface Props {
  /** Whether the project sidebar is hidden, and a toggle for it. Null hides the
   *  control entirely (tabs without a sidebar). */
  sidebar?: { hidden: boolean; onToggle: () => void } | null;
  /** Files ⇄ History toggle, shown only on the workspace tab. */
  workspace?: { historyOn: boolean; onToggle: () => void } | null;
}

export default function StatusBar({ sidebar = null, workspace = null }: Props) {
  const st = useEditorStatus();
  const zoomLevel = useZoomLevel();

  return (
    <div className="statusbar app-statusbar">
      {sidebar && (
        <button
          type="button"
          className={`sb-icon${sidebar.hidden ? "" : " on"}`}
          title={sidebar.hidden ? "Show project tree" : "Hide project tree"}
          onClick={sidebar.onToggle}
        >
          <SidebarIcon />
        </button>
      )}
      {workspace && (
        <button
          type="button"
          className={`sb-toggle${workspace.historyOn ? " on" : ""}`}
          title={workspace.historyOn ? "Show the project files tree" : "Show history (timeline & changed files)"}
          onClick={workspace.onToggle}
        >
          {workspace.historyOn ? "Files" : "History"}
        </button>
      )}
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
