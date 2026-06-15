## Context

`FileView` (`src/components/FileView.tsx`) wraps a single Monaco `Editor` in an `editor-shell` container with a bottom `statusbar`. It is rendered by `HistoryView.tsx` with `language={langOf(file)}`; `langOf` (`src/lib/util.ts`) already maps `.md` → `markdown`. There is no per-file top toolbar today and no Markdown rendering — `.md` opens as raw source like any other file. The app is a Tauri + React webview bundled by Vite; no Markdown or Mermaid dependency exists yet.

The feature is local to the editor pane: a JetBrains-style mode switch (Raw / Both / Read) within the existing pane — explicitly no new tab per `.md`.

## Goals / Non-Goals

**Goals:**
- Top-right toolbar in the editor pane, shown only for Markdown files, switching Raw / Both / Read.
- Live, sanitized Markdown → HTML preview that matches the editor theme.
- Mermaid diagram rendering for ` ```mermaid ` fenced blocks.
- Zero behavior change for non-Markdown files; Raw is the default and equals today.

**Non-Goals:**
- No new tab, no separate window, no tab-model changes.
- No persistence to disk/settings (session-only mode memory is enough for v1).
- No scroll-sync between source and preview, no editing from the preview (WYSIWYG).
- No Markdown rendering anywhere outside `FileView` (e.g. diff/history previews).

## Decisions

**1. Mount the toolbar and preview inside `FileView`, gated on `language === "markdown"`.**
`FileView` already owns the pane (`editor-shell`) and receives `language` and `content`. Adding mode state here keeps the integration to one component and one CSS block; `HistoryView` needs no change. Alternative — a wrapper component around `FileView` in `HistoryView` — was rejected: it would duplicate path/content plumbing and the statusbar already lives inside `FileView`.

**2. Mode state is local `useState` in `FileView`, lifted to a tiny session-scoped store for persistence.**
A module-level variable (like the existing `editorZoom`/`uiPrefs` libs use) holds the last-selected mode so reopening a `.md` restores it within the session. Default `raw`. No disk write — keeps scope small and matches the "session" wording in the spec. Can later promote to `uiPrefs` if durable persistence is wanted.

**3. Layout: keep the single Monaco `Editor` mounted; toggle preview visibility with CSS, never unmount the editor.**
- Raw: editor visible, preview absent.
- Both: flex row — editor (left) + preview (right), each 50%, reuse the `Splitter` component if a draggable divider is wanted; fixed 50/50 acceptable for v1.
- Read: editor hidden via CSS (`display:none`, not unmounted) + preview full width.
Keeping the model mounted preserves the undo stack, cursor, and the uncontrolled-model invariant the file documents at length (one model per path, `keepCurrentModel`). Unmounting Monaco on every mode switch would risk the exact undo-stack poisoning the existing comments warn about. The preview reads `content` plus live edits via the editor model's `onDidChangeContent`.

**4. New `MarkdownPreview` component owns rendering.**
Props: `source: string`. It renders Markdown → HTML, post-processes `mermaid` blocks, and sanitizes before injecting via `dangerouslySetInnerHTML` (pattern already used safely for colorized hunks in `FileView`). Live updates come from a debounced subscription to the model's content (reuse the ~300–400ms debounce pattern already in `FileView`).

**5. Dependencies: `markdown-it` + `dompurify` + `mermaid`.**
- `markdown-it` — small, fast, plugin-friendly, lets us intercept `mermaid` fences via a custom fence renderer. (Alternative `marked` is fine too; `markdown-it`'s renderer override is cleaner for the fence hook.)
- `dompurify` — sanitize rendered HTML; non-negotiable since file content is untrusted.
- `mermaid` — diagram rendering. It is heavy (~MB) and pulls its own deps, so **lazy-load it with a dynamic `import()`** only when a Markdown preview that contains a `mermaid` block is first shown. This keeps the default editor bundle unaffected.

**6. Mermaid rendering flow.**
Override `markdown-it`'s fence rule: a `mermaid` info string emits a `<div class="mermaid-block" data-src="…">` placeholder instead of a `<pre><code>`. After the sanitized HTML is in the DOM, a `useEffect` finds those placeholders, lazy-imports `mermaid`, calls `mermaid.render` per block, and swaps in the SVG. Parse failures replace that block with an inline error node — the rest of the document is unaffected. Mermaid is initialized once with `startOnLoad:false` and a theme matching the editor (dark).

**7. Theme/styling.**
Preview styled in `styles.css` under a `.md-preview` scope using existing CSS theme variables so it tracks the active editor theme. Mermaid given a matching dark theme on init.

## Risks / Trade-offs

- **Mermaid bundle weight** → lazy dynamic `import()`, loaded only on first Mermaid block; default bundle and non-Markdown files pay nothing.
- **XSS from untrusted `.md` content** → DOMPurify sanitizes all rendered HTML before injection; Mermaid output (SVG) is generated from the source and injected only after sanitize of surrounding HTML — Mermaid input is the fenced text, treated as diagram syntax not HTML.
- **Undo-stack / model corruption from remount** → never unmount the editor on mode change; hide with CSS only, preserving `keepCurrentModel` semantics the file already depends on.
- **`automaticLayout` + hidden editor** → toggling `display:none` then back can need a Monaco relayout; rely on `automaticLayout: true` (already set) or trigger a layout on mode change if the editor shows stale sizing.
- **Live-render cost on large docs** → debounce content-driven re-render (~300ms), same pattern as the existing gutter/diag recompute timers.
- **Splitter reuse** → if the draggable `Splitter` integration is non-trivial, ship fixed 50/50 for Both in v1 and add resize later.

## Open Questions

- Persist the chosen mode to `uiPrefs` (durable) instead of session-only? Spec only requires session — defaulting to session-only.
- Should Both mode get a draggable divider (`Splitter`) in v1, or fixed 50/50? Leaning fixed 50/50 first.
