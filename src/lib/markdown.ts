/**
 * Minimal CommonMark-subset markdown -> HTML renderer for dataset READMEs.
 *
 * Scope:
 *   - ATX headings (#, ##, ###, up to ######)
 *   - Paragraphs
 *   - Bulleted lists (`-` / `*`) and ordered lists (`1.`)
 *   - Code fences (```lang)
 *   - Inline code, bold (**, __), italic (*, _)
 *   - Links [text](url) and bare URL autolinks
 *   - Horizontal rules (---, ***)
 *   - HTML escaping everywhere; reject `javascript:` URLs
 *
 * Out of scope (added in follow-ups if real READMEs need them):
 *   - Tables, footnotes, blockquotes, images, raw HTML, strikethrough
 *
 * Zero deps. Cloudflare Workers runtime safe (no Node APIs).
 */

const HTML_ESCAPE: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPE[c]);
}

function safeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^javascript:/i.test(trimmed)) return "#";
  if (/^data:/i.test(trimmed)) return "#";
  return escapeHtml(trimmed);
}

/**
 * Inline formatting pass: code, bold, italic, links, autolinks.
 * Operates on already-escaped HTML so the input MUST be pre-escaped.
 */
function renderInline(escaped: string): string {
  let out = escaped;
  // Inline code (single backticks). Run before bold/italic so * inside ` ` is literal.
  out = out.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
  // Bold: **text** or __text__
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  // Italic: *text* or _text_ (avoid ** which the bold rule consumed)
  out = out.replace(/(^|[^\*])\*([^\*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");
  // Links: [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text: string, url: string) => {
    return `<a href="${safeUrl(url)}" rel="external">${text}</a>`;
  });
  // Bare URL autolinks (only when not already inside an href).
  out = out.replace(
    /(^|[^"\(\[])(https?:\/\/[^\s<>)]+)(?![^<]*>)/g,
    (_, prefix: string, url: string) =>
      `${prefix}<a href="${safeUrl(url)}" rel="external">${url}</a>`,
  );
  return out;
}

interface RenderState {
  buf: string[];
  /** Open list stack: 'ul' | 'ol'. */
  listStack: Array<"ul" | "ol">;
  /** Open paragraph buffer. */
  paragraph: string[];
  inCodeFence: boolean;
  codeLang: string;
  codeBuf: string[];
}

function flushParagraph(state: RenderState): void {
  if (state.paragraph.length === 0) return;
  const text = state.paragraph.join(" ");
  state.buf.push(`<p>${renderInline(escapeHtml(text))}</p>`);
  state.paragraph.length = 0;
}

function closeLists(state: RenderState, downTo = 0): void {
  while (state.listStack.length > downTo) {
    const tag = state.listStack.pop();
    state.buf.push(`</${tag}>`);
  }
}

function flushAll(state: RenderState): void {
  flushParagraph(state);
  closeLists(state);
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^```(\S*)\s*$/;
const HR_RE = /^(\*{3,}|-{3,}|_{3,})\s*$/;
const ULI_RE = /^\s*[-*]\s+(.+)$/;
const OLI_RE = /^\s*\d+\.\s+(.+)$/;

export function renderMarkdown(input: string): string {
  const state: RenderState = {
    buf: [],
    listStack: [],
    paragraph: [],
    inCodeFence: false,
    codeLang: "",
    codeBuf: [],
  };

  const lines = input.replace(/\r\n?/g, "\n").split("\n");

  for (const line of lines) {
    // Code fence state has priority.
    if (state.inCodeFence) {
      if (FENCE_RE.test(line)) {
        const langAttr = state.codeLang ? ` class="language-${escapeHtml(state.codeLang)}"` : "";
        state.buf.push(
          `<pre><code${langAttr}>${escapeHtml(state.codeBuf.join("\n"))}</code></pre>`,
        );
        state.codeBuf.length = 0;
        state.codeLang = "";
        state.inCodeFence = false;
      } else {
        state.codeBuf.push(line);
      }
      continue;
    }

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushAll(state);
      state.inCodeFence = true;
      state.codeLang = fence[1];
      continue;
    }

    if (line.trim() === "") {
      flushParagraph(state);
      closeLists(state);
      continue;
    }

    if (HR_RE.test(line)) {
      flushAll(state);
      state.buf.push("<hr />");
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushAll(state);
      const level = heading[1].length;
      state.buf.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    const uli = ULI_RE.exec(line);
    if (uli) {
      flushParagraph(state);
      if (state.listStack[state.listStack.length - 1] !== "ul") {
        closeLists(state);
        state.buf.push("<ul>");
        state.listStack.push("ul");
      }
      state.buf.push(`<li>${renderInline(escapeHtml(uli[1]))}</li>`);
      continue;
    }

    const oli = OLI_RE.exec(line);
    if (oli) {
      flushParagraph(state);
      if (state.listStack[state.listStack.length - 1] !== "ol") {
        closeLists(state);
        state.buf.push("<ol>");
        state.listStack.push("ol");
      }
      state.buf.push(`<li>${renderInline(escapeHtml(oli[1]))}</li>`);
      continue;
    }

    // Soft-break continuation inside a paragraph.
    state.paragraph.push(line.trim());
  }

  if (state.inCodeFence) {
    // Unclosed fence — flush what we have rather than dropping content.
    state.buf.push(`<pre><code>${escapeHtml(state.codeBuf.join("\n"))}</code></pre>`);
  }
  flushAll(state);
  return state.buf.join("\n");
}
