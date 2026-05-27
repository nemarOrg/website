import { describe, expect, it } from "vitest";
import { renderMarkdownPreview } from "./render-file-preview-md";

describe("renderMarkdownPreview", () => {
  it("wraps rendered markdown in .preview__md", () => {
    const html = renderMarkdownPreview("# Hello\n\nworld");
    expect(html).toContain(`<div class="preview__md">`);
    expect(html).toContain("Hello");
    expect(html).toContain("world");
  });

  it("returns the empty-file message on an empty string", () => {
    expect(renderMarkdownPreview("")).toContain("This file is empty");
  });

  it("returns the empty-file message on whitespace-only input", () => {
    expect(renderMarkdownPreview("   \n\n  ")).toContain("This file is empty");
  });

  it("includes nested formatting from the underlying markdown renderer", () => {
    const html = renderMarkdownPreview("**bold** and `code` and [link](https://x)");
    expect(html).toContain("<strong>");
    expect(html).toContain("<code>");
    expect(html).toContain('href="https://x"');
  });
});
