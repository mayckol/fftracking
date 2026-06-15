## Why

Markdown files open as raw source in the Monaco editor with no rendered view. JetBrains IDEs let you read and edit a `.md` in the same pane and toggle between source, split, and rendered preview from a small top-right toolbar — no extra tab. We want that, plus Mermaid diagram rendering, so docs are readable without leaving the editor.

## What Changes

- Add a per-file **view-mode toolbar** in the top-right of the editor pane, shown only for Markdown files.
- Three view modes:
  - **Raw** — Monaco source editor only (current behavior).
  - **Both** — split pane: Monaco source on the left, live rendered preview on the right.
  - **Read** — rendered preview only (full-width reading view).
- Render Markdown to sanitized HTML in the preview, styled to match the editor theme.
- Render **Mermaid** fenced code blocks (` ```mermaid `) as diagrams inside the preview.
- Preview updates live as the source is edited; the active mode persists per session.
- Non-Markdown files are unaffected — no toolbar, no behavior change.

## Capabilities

### New Capabilities
- `markdown-preview`: Markdown view modes (raw / both / read) with a top-right toolbar, live HTML preview, and Mermaid diagram rendering, scoped to Markdown files in the editor pane.

### Modified Capabilities
<!-- none — no existing specs -->

## Impact

- **Code**: `src/components/FileView.tsx` (toolbar + mode state + split layout), a new preview component, `src/styles.css` (toolbar, split, preview, Mermaid styling). Markdown detection already exists via `langOf` in `src/lib/util.ts`.
- **Dependencies**: add a Markdown→HTML renderer, an HTML sanitizer, and `mermaid` (new npm deps; Mermaid adds notable bundle weight — load lazily).
- **Surface**: editor pane in `HistoryView.tsx` (renders `FileView`); no tab-model changes.
- **No breaking changes**: defaults to Raw, identical to today for every file type.
