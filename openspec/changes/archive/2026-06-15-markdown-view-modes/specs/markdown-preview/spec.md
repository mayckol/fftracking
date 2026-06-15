## ADDED Requirements

### Requirement: View-mode toolbar for Markdown files

The editor pane SHALL show a view-mode toolbar in its top-right corner only when the open file's language is Markdown. The toolbar SHALL offer three modes — Raw, Both, and Read — each represented by an icon button, with the active mode visually highlighted.

#### Scenario: Toolbar shown for Markdown file
- **WHEN** a file whose language resolves to `markdown` is open in the editor pane
- **THEN** a top-right toolbar with Raw, Both, and Read mode buttons is visible

#### Scenario: Toolbar hidden for non-Markdown file
- **WHEN** a file whose language is not `markdown` is open
- **THEN** no view-mode toolbar is shown and the editor behaves exactly as before

#### Scenario: Active mode highlighted
- **WHEN** a view mode is active
- **THEN** its toolbar button is rendered in a highlighted/selected state and the other two are not

### Requirement: Raw view mode

In Raw mode the editor pane SHALL show only the Monaco source editor, identical to the current editing behavior, with no preview.

#### Scenario: Raw mode shows source only
- **WHEN** the user selects Raw mode
- **THEN** the Monaco editor fills the pane and no rendered preview is shown

#### Scenario: Raw is the default
- **WHEN** a Markdown file is first opened
- **THEN** the pane starts in Raw mode

### Requirement: Both view mode

In Both mode the editor pane SHALL split into the Monaco source editor and a rendered preview side by side, with the preview reflecting the current source.

#### Scenario: Both mode shows source and preview
- **WHEN** the user selects Both mode
- **THEN** the Monaco editor and the rendered preview are shown side by side in the same pane

#### Scenario: Editing remains available in Both mode
- **WHEN** the pane is in Both mode and the user edits the source
- **THEN** the edits are accepted in the editor and the save behavior is unchanged

### Requirement: Read view mode

In Read mode the editor pane SHALL show only the rendered preview, occupying the full pane width, with the Monaco editor hidden.

#### Scenario: Read mode shows preview only
- **WHEN** the user selects Read mode
- **THEN** the full-width rendered preview is shown and the Monaco editor is hidden

### Requirement: Live Markdown rendering

The preview SHALL render the Markdown source to sanitized HTML and SHALL update to reflect source edits while the preview is visible. Rendered HTML SHALL be sanitized before insertion to prevent script injection from file content.

#### Scenario: Markdown rendered to HTML
- **WHEN** the preview is visible for a Markdown file
- **THEN** standard Markdown (headings, lists, links, code blocks, tables, emphasis) is shown as formatted HTML

#### Scenario: Preview updates on edit
- **WHEN** the preview is visible in Both mode and the user changes the source
- **THEN** the preview updates to reflect the new source

#### Scenario: Untrusted content sanitized
- **WHEN** the Markdown source contains raw HTML such as a `<script>` tag or an event-handler attribute
- **THEN** the dangerous markup is stripped and does not execute in the preview

### Requirement: Mermaid diagram rendering

The preview SHALL render fenced code blocks tagged `mermaid` as Mermaid diagrams instead of as code text. A block that fails to parse SHALL show an inline error in place of the diagram without breaking the rest of the preview.

#### Scenario: Mermaid block rendered as diagram
- **WHEN** the source contains a fenced code block with the `mermaid` info string and valid diagram syntax
- **THEN** the preview shows the rendered diagram in place of the code block

#### Scenario: Invalid Mermaid shows inline error
- **WHEN** a `mermaid` fenced block contains invalid syntax
- **THEN** the preview shows an inline error for that block and still renders the rest of the document

### Requirement: View-mode persistence

The selected view mode SHALL persist while the application session is running, so reopening a Markdown file or switching to another and back restores the last chosen mode.

#### Scenario: Mode restored within session
- **WHEN** the user selects Read mode, opens another file, then reopens a Markdown file
- **THEN** the pane restores the last selected view mode for the session
