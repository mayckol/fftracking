import { useEffect, useRef, useState } from "react";
import { enhanceCodeCopy, renderMarkdown, renderMermaidBlocks } from "../lib/markdown";

interface Props {
  source: string;
}

export default function MarkdownPreview({ source }: Props) {
  // Debounce the source so fast typing in Both mode doesn't re-render the whole
  // document on every keystroke — same ~300ms pattern as FileView's recomputes.
  const [debounced, setDebounced] = useState(source);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(source), 300);
    return () => window.clearTimeout(t);
  }, [source]);

  const html = renderMarkdown(debounced);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    enhanceCodeCopy(ref.current);
    renderMermaidBlocks(ref.current);
  }, [html]);

  return <div ref={ref} className="md-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}
