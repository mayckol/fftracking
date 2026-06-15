## 1. Dependencies

- [x] 1.1 Add `markdown-it`, `dompurify`, and `mermaid` (plus their type packages) to `package.json` and install
- [x] 1.2 Confirm `mermaid` is excluded from the eager bundle (only reached via dynamic `import()`)

## 2. Markdown rendering core

- [x] 2.1 Create a `renderMarkdown(source)` helper (`src/lib/markdown.ts`) using `markdown-it` configured with a custom fence rule that emits a `mermaid-block` placeholder (carrying the raw diagram source) for ` ```mermaid ` blocks and normal `<pre><code>` for other fences
- [x] 2.2 Sanitize the rendered HTML with `dompurify` before returning, allowing the `mermaid-block` placeholder element/attributes
- [x] 2.3 Add a lazy `renderMermaidBlocks(container)` that dynamic-imports `mermaid`, initializes it once (`startOnLoad:false`, dark theme), renders each placeholder to SVG, and replaces parse failures with an inline error node

## 3. Preview component

- [x] 3.1 Create `MarkdownPreview` (`src/components/MarkdownPreview.tsx`) taking `source: string`, rendering sanitized HTML via `dangerouslySetInnerHTML`
- [x] 3.2 In an effect, call `renderMermaidBlocks` after each render so Mermaid placeholders become diagrams; re-run on source change
- [x] 3.3 Debounce source-driven re-render (~300ms) to match existing recompute patterns in `FileView`

## 4. View-mode state

- [x] 4.1 Add a session-scoped mode store (`src/lib/mdViewMode.ts`) holding the last selected mode (`raw` | `both` | `read`, default `raw`) with get/set + subscribe, mirroring `editorZoom`/`uiPrefs`
- [x] 4.2 Wire `FileView` to read/write this store so the mode persists across file switches within the session

## 5. FileView integration

- [x] 5.1 In `FileView`, compute `isMarkdown = language === "markdown"`; render the view-mode toolbar (Raw / Both / Read icon buttons, active one highlighted) in the top-right of `editor-shell` only when `isMarkdown`
- [x] 5.2 Subscribe to the editor model's `onDidChangeContent` (debounced) to feed live source into `MarkdownPreview` while a preview is visible
- [x] 5.3 Lay out the pane per mode: Raw = editor only; Both = editor + preview side by side (50/50 flex); Read = preview full width with the editor hidden via CSS (never unmount the editor — preserve `keepCurrentModel` / undo stack)
- [x] 5.4 Trigger a Monaco relayout when switching back to a mode that shows the editor, in case `automaticLayout` leaves stale sizing after `display:none`
- [x] 5.5 Wrap the Monaco `<Editor>` in the `editor-wrap` flex child (the Editor's own outer element is inline `width:100%` and would otherwise eat the whole row, collapsing the preview to ~1px)
- [x] 5.6 Add a draggable divider (reuse `Splitter`) in Both mode with a session-persisted editor/preview width ratio (clamped 0.2–0.8), relayout Monaco on drag

## 6. Styling

- [x] 6.1 Add `styles.css` rules for the toolbar (top-right placement, button states), the Both-mode split, and full-width Read mode
- [x] 6.2 Add `.md-preview` typography/code/table styles using existing theme CSS variables so the preview tracks the editor theme; style Mermaid block container and inline error
- [x] 6.3 Click-to-copy: a hover "Copy" button on fenced code blocks (with "Copied" feedback) and click-anywhere copy on inline `code`

## 7. Verification

- [x] 7.1 Open a `.md` file: toolbar appears top-right; open a non-`.md` file: no toolbar, behavior unchanged
- [x] 7.2 Verify Raw / Both / Read switching, live preview updates while editing in Both, and mode persistence across file switches within the session
- [x] 7.3 Verify a valid `mermaid` block renders as a diagram and an invalid one shows an inline error without breaking the rest of the document
- [x] 7.4 Verify a `<script>`/event-handler in the source is stripped and does not execute
- [x] 7.5 Run `npm run build` (tsc + vite) clean
