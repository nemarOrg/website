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
 *   - Images on a line of their own, as figures, only when the caller opts in
 *     with {@link MarkdownOptions.allowImage} (news posts do; READMEs do not)
 *
 * Out of scope (added in follow-ups if real READMEs need them):
 *   - Tables, footnotes, blockquotes, inline images, raw HTML, strikethrough
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
// Lines that are *only* a markdown image. Two shapes show up in real
// READMEs: a bare image (`![alt](url)`) and a link-wrapping-an-image
// (`[![alt](img)](href)` — the clickable-DOI-badge pattern OpenNeuro
// and Zenodo pin at the top of every README). Our zero-dep CommonMark
// subset doesn't render <img>, so both otherwise paint as raw text and
// force horizontal overflow on mobile. Stripping at source.
const STANDALONE_IMAGE_RE = /^[ \t]*!\[[^\]]*\]\([^)]*\)[ \t]*$/;
const LINKED_IMAGE_RE = /^[ \t]*\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)[ \t]*$/;

/** Strip standalone markdown-image lines from a markdown source. Exposed
 *  separately from `renderMarkdown` for callers that want to preview the
 *  cleaned source (e.g. the inline file viewer that injects via innerHTML
 *  outside the main renderer's flow). Handles both bare-image and
 *  link-wrapping-image patterns. */
export function stripStandaloneImages(input: string): string {
  return input
    .split("\n")
    .filter((line) => !STANDALONE_IMAGE_RE.test(line) && !LINKED_IMAGE_RE.test(line))
    .join("\n");
}

/**
 * A standalone image line with an optional quoted title, which becomes the
 * caption: `![alt](src "caption")`. Group 1 is the alt text, 2 the source,
 * 3 the caption.
 */
const FIGURE_RE = /^[ \t]*!\[([^\]]*)\]\(\s*([^\s)]+)(?:\s+"([^"]*)")?\s*\)[ \t]*$/;

export interface MarkdownOptions {
  /**
   * Render a standalone image line as a `<figure>` when this returns true
   * for its source. Sources it rejects are dropped, exactly as they are
   * without the option.
   *
   * There is no default allowlist on purpose: the page's
   * Content-Security-Policy decides which image hosts can load, so the caller
   * that knows its CSP decides which sources are worth emitting. News posts
   * pass `isNewsMediaUrl`, which admits only this site's own `/news/media/`.
   */
  readonly allowImage?: (src: string) => boolean;
  /**
   * Added to every heading level, capped at 6. A news article already has
   * its title as the page's `h1`, so its body starts at `h2`.
   */
  readonly headingOffset?: number;
}

function renderFigure(match: RegExpExecArray): string {
  const alt = escapeHtml(match[1].trim());
  const src = safeUrl(match[2]);
  const caption = match[3]?.trim();
  const img = `<img src="${src}" alt="${alt}" loading="lazy" decoding="async" />`;
  return caption
    ? `<figure>${img}<figcaption>${renderInline(escapeHtml(caption))}</figcaption></figure>`
    : `<figure>${img}</figure>`;
}

export function renderMarkdown(input: string, options: MarkdownOptions = {}): string {
  const { allowImage } = options;
  const headingOffset = Math.max(0, Math.trunc(options.headingOffset ?? 0));
  // Pre-filter standalone image markdown so a DOI banner at the top of
  // a README doesn't show as a literal `![DOI](https://...)` blob. With
  // `allowImage`, image lines survive to the loop, which renders the allowed
  // ones and drops the rest; link-wrapped badges are always dropped.
  const source = allowImage
    ? input
        .split("\n")
        .filter((line) => !LINKED_IMAGE_RE.test(line))
        .join("\n")
    : stripStandaloneImages(input);
  const state: RenderState = {
    buf: [],
    listStack: [],
    paragraph: [],
    inCodeFence: false,
    codeLang: "",
    codeBuf: [],
  };

  const lines = source.replace(/\r\n?/g, "\n").split("\n");

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

    if (allowImage && STANDALONE_IMAGE_RE.test(line)) {
      flushAll(state);
      const figure = FIGURE_RE.exec(line);
      if (figure && allowImage(figure[2])) state.buf.push(renderFigure(figure));
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushAll(state);
      const level = Math.min(6, heading[1].length + headingOffset);
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
