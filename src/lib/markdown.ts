import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

// `mermaid` is heavy (~MB) and drags in its own deps — keep it out of the eager
// bundle and dynamic-import it only when a preview actually contains a diagram.
type MermaidApi = typeof import("mermaid")["default"];
let mermaidPromise: Promise<MermaidApi> | null = null;
async function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
      return m.default;
    });
  }
  return mermaidPromise;
}

const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

// Fence override: a ```mermaid block becomes a placeholder carrying its source
// (URI-encoded so quotes/newlines survive the attribute), rendered to SVG after
// the HTML is in the DOM. Every other fence keeps markdown-it's default code.
const defaultFence =
  md.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info.trim().toLowerCase();
  if (info === "mermaid") {
    return `<div class="mermaid-block" data-src="${encodeURIComponent(token.content)}"></div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

export function renderMarkdown(source: string): string {
  const html = md.render(source);
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ["div"],
    ADD_ATTR: ["class", "data-src"],
  });
}

function flash(el: HTMLElement, cls: string) {
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), 900);
}

// Click-to-copy: a Copy button on fenced code blocks and click-anywhere on
// inline `code`. Run after the HTML is in the DOM (these nodes are created
// directly, so they bypass — and don't need — sanitization).
export function enhanceCodeCopy(container: HTMLElement): void {
  for (const pre of container.querySelectorAll<HTMLElement>("pre")) {
    if (pre.querySelector(".md-copy-btn")) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const text = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = "Copied";
        btn.classList.add("ok");
        window.setTimeout(() => {
          btn.textContent = "Copy";
          btn.classList.remove("ok");
        }, 900);
      }, () => {});
    });
    pre.appendChild(btn);
  }
  for (const code of container.querySelectorAll<HTMLElement>("code")) {
    if (code.closest("pre") || code.dataset.copy) continue;
    code.dataset.copy = "1";
    code.classList.add("md-inline-copy");
    code.title = "Click to copy";
    code.addEventListener("click", () => {
      navigator.clipboard.writeText(code.textContent ?? "").then(() => flash(code, "copied"), () => {});
    });
  }
}

let mermaidSeq = 0;

// Replace each .mermaid-block placeholder with its rendered SVG. A block that
// fails to parse is swapped for an inline error and the rest is left intact.
export async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
  const blocks = Array.from(container.querySelectorAll<HTMLElement>(".mermaid-block"));
  if (blocks.length === 0) return;
  const mermaid = await loadMermaid();
  for (const el of blocks) {
    const src = decodeURIComponent(el.dataset.src ?? "");
    try {
      const { svg } = await mermaid.render(`mmd-${++mermaidSeq}`, src);
      el.innerHTML = svg;
    } catch (e) {
      el.classList.add("mermaid-error");
      el.textContent = `Mermaid error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
}
