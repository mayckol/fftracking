import { Editor } from "@monaco-editor/react";
import { defineTheme, THEME } from "./monacoTheme";

interface Props {
  content: string;
  language: string;
}

export default function FileView({ content, language }: Props) {
  return (
    <Editor
      className="editor-wrap"
      theme={THEME}
      language={language}
      value={content}
      beforeMount={defineTheme}
      options={{
        readOnly: true,
        glyphMargin: false,
        automaticLayout: true,
        fontFamily: "JetBrains Mono",
        fontSize: 12.5,
        lineHeight: 19,
        minimap: { enabled: false },
        overviewRulerLanes: 0,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        guides: { indentation: false },
        renderLineHighlight: "all",
        renderLineHighlightOnlyWhenFocus: false,
        cursorBlinking: "smooth",
        padding: { top: 10, bottom: 10 },
        wordWrap: "off",
      }}
    />
  );
}
