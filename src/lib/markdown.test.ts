import { describe, expect, it } from "vitest";
import { renderMarkdown, stripStandaloneImages } from "./markdown";

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

  it("strips standalone DOI / badge image lines before rendering", () => {
    // The OpenNeuro / Zenodo DOI badge pattern: a link wrapping an image.
    // Our CommonMark subset doesn't render <img>; this line otherwise paints
    // as ugly literal text and forces horizontal overflow on mobile (#87).
    const md = [
      "[![DOI](https://img.shields.io/badge/DOI-10.18112%2Fopenneuro.ds002718.v1.0.0-blue)](https://doi.org/10.18112/openneuro.ds002718.v1.0.0)",
      "",
      "# ERP CORE",
      "",
      "Body text.",
    ].join("\n");
    const out = renderMarkdown(md);
    expect(out).not.toContain("![DOI");
    expect(out).not.toContain("img.shields.io");
    expect(out).toContain("<h1>ERP CORE</h1>");
    expect(out).toContain("Body text");
  });
});

describe("stripStandaloneImages", () => {
  it("removes bare standalone image lines (collapsing the line out)", () => {
    const md = "![alt](https://x.png)\n\n# Heading\n";
    // Image line removed; the trailing blank + heading + trailing newline
    // collapse together via filter+join. The blank line is still present
    // so the heading stays preceded by whitespace.
    expect(stripStandaloneImages(md)).toBe("\n# Heading\n");
  });

  it("removes link-wrapping-image badge lines (the DOI pattern)", () => {
    const md = "[![DOI](https://img.shields.io/badge/X)](https://doi.org/Y)\n\n# Title";
    expect(stripStandaloneImages(md)).toBe("\n# Title");
  });

  it("leaves inline image references alone (image inside a paragraph)", () => {
    const md = "This is text with an ![inline](https://x.png) image inside.";
    expect(stripStandaloneImages(md)).toBe(md);
  });

  it("tolerates leading / trailing whitespace on the matched line", () => {
    const md = "  ![alt](url)  \n# Heading";
    expect(stripStandaloneImages(md)).toBe("# Heading");
  });

  it("leaves regular link lines alone (not images)", () => {
    const md = "[Click me](https://x)\n# Heading";
    expect(stripStandaloneImages(md)).toBe(md);
  });
});
