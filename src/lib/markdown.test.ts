import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("renders headings", () => {
    expect(renderMarkdown("# Title")).toBe("<h1>Title</h1>");
    expect(renderMarkdown("### Sub")).toBe("<h3>Sub</h3>");
  });

  it("renders paragraphs and joins soft breaks", () => {
    expect(renderMarkdown("first line\nsecond line")).toBe("<p>first line second line</p>");
  });

  it("escapes HTML in paragraph text", () => {
    expect(renderMarkdown("a <script>alert(1)</script> b")).toContain(
      "a &lt;script&gt;alert(1)&lt;/script&gt; b",
    );
  });

  it("renders bulleted lists", () => {
    const out = renderMarkdown("- one\n- two\n- three");
    expect(out).toBe("<ul>\n<li>one</li>\n<li>two</li>\n<li>three</li>\n</ul>");
  });

  it("renders ordered lists", () => {
    const out = renderMarkdown("1. one\n2. two");
    expect(out).toBe("<ol>\n<li>one</li>\n<li>two</li>\n</ol>");
  });

  it("renders fenced code blocks with language", () => {
    const out = renderMarkdown("```bash\nls -la\n```");
    expect(out).toBe('<pre><code class="language-bash">ls -la</code></pre>');
  });

  it("escapes HTML inside code blocks", () => {
    const out = renderMarkdown("```\n<div>hi</div>\n```");
    expect(out).toContain("&lt;div&gt;hi&lt;/div&gt;");
  });

  it("renders inline code", () => {
    expect(renderMarkdown("use `foo` here")).toBe("<p>use <code>foo</code> here</p>");
  });

  it("renders bold and italic", () => {
    expect(renderMarkdown("**bold** and *italic*")).toBe(
      "<p><strong>bold</strong> and <em>italic</em></p>",
    );
  });

  it("renders links with safe URLs", () => {
    const out = renderMarkdown("[ON](https://openneuro.org/x)");
    expect(out).toBe('<p><a href="https://openneuro.org/x" rel="external">ON</a></p>');
  });

  it("rejects javascript: links", () => {
    const out = renderMarkdown("[click](javascript:alert(1))");
    expect(out).toContain('href="#"');
    expect(out).not.toContain("javascript");
  });

  it("renders horizontal rules", () => {
    expect(renderMarkdown("---")).toBe("<hr />");
    expect(renderMarkdown("***")).toBe("<hr />");
  });

  it("autolinks bare URLs", () => {
    const out = renderMarkdown("see https://nemar.org/x for more");
    expect(out).toContain('<a href="https://nemar.org/x"');
  });
});
