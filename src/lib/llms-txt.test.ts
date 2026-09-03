import { describe, expect, it } from "vitest";
import { llmsTxtBody } from "./llms-txt";

/**
 * Every `[label](url)` pair in the body, in order. Deliberately a plain
 * regex over the rendered text rather than a markdown parser -- this file
 * builds the body with template strings, not a library, so testing it the
 * same way keeps the test honest about what actually ships.
 */
function extractLinks(body: string): { label: string; url: string }[] {
  const out: { label: string; url: string }[] = [];
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  for (const match of body.matchAll(re)) {
    out.push({ label: match[1], url: match[2] });
  }
  return out;
}

describe("llmsTxtBody shape", () => {
  it("opens with an H1 naming the site", () => {
    expect(llmsTxtBody().startsWith("# NEMAR\n")).toBe(true);
  });

  it("follows the H1 with a blockquote summary", () => {
    const body = llmsTxtBody();
    const blocks = body.split("\n\n");
    expect(blocks[0]).toBe("# NEMAR");
    expect(blocks[1].startsWith("> ")).toBe(true);
    // Every line of the summary block is part of the blockquote.
    for (const line of blocks[1].split("\n")) {
      expect(line.startsWith(">")).toBe(true);
    }
  });

  it("states in the blockquote that the data is not on nemar.org", () => {
    const body = llmsTxtBody();
    const blockquote = body.split("\n\n")[1];
    expect(blockquote).toContain("not hosted on nemar.org");
  });

  it("organizes the rest of the body into markdown sections with headings", () => {
    const body = llmsTxtBody();
    const headings = body.match(/^## .+$/gm) ?? [];
    expect(headings.length).toBeGreaterThanOrEqual(4);
    expect(headings).toContain("## Data");
    expect(headings).toContain("## API");
    expect(headings).toContain("## Docs");
    expect(headings).toContain("## Datasets");
  });
});

describe("llmsTxtBody links", () => {
  it("emits at least one link", () => {
    expect(extractLinks(llmsTxtBody()).length).toBeGreaterThan(0);
  });

  it("every link is absolute and resolves to a nemar.org host", () => {
    const links = extractLinks(llmsTxtBody());
    expect(links.length).toBeGreaterThan(0);
    for (const { url } of links) {
      const hostname = new URL(url).hostname;
      const isNemarHost = hostname === "nemar.org" || hostname.endsWith(".nemar.org");
      expect(isNemarHost, `${url} does not resolve to a nemar.org host`).toBe(true);
    }
  });

  it("never links to openneuro.org", () => {
    const body = llmsTxtBody();
    expect(body.toLowerCase()).not.toContain("openneuro");
  });

  it("links the data host with the /<id>/latest/ shape", () => {
    const body = llmsTxtBody();
    expect(body).toContain("https://data.nemar.org/");
    expect(body).toContain("/<id>/latest/");
  });

  it("links the API catalog endpoint and a working search example", () => {
    const body = llmsTxtBody();
    expect(body).toContain("https://api.nemar.org/datasets)");
    // The search endpoint 400s with no `q` param; the linked example must
    // carry one so a naive follow of the link actually resolves.
    expect(body).toContain("https://api.nemar.org/datasets/search?q=EEG)");
    expect(body).toContain("`q`");
  });

  it("links the docs For-agents guide and the Zarr contract pages", () => {
    const body = llmsTxtBody();
    expect(body).toContain("https://docs.nemar.org/platform/for-agents/");
    expect(body).toContain("https://docs.nemar.org/platform/zarr/");
  });

  it("links the per-dataset page and names its markdown mirror and JSON-LD", () => {
    const body = llmsTxtBody();
    expect(body).toContain("https://nemar.org/dataset/<id>");
    expect(body).toContain("/dataset/<id>.md");
    expect(body).toContain("JSON-LD");
  });
});

describe("llmsTxtBody license caveat", () => {
  it("says most licenses are CC0 or CC-BY and a minority are restrictive", () => {
    const body = llmsTxtBody();
    expect(body).toContain("## License");
    expect(body).toContain("vary per dataset");
    expect(body).toContain("Most are CC0 or CC-BY");
    expect(body).toContain("a minority carry a non-commercial or no-derivatives term");
  });

  it("does not overstate non-commercial licensing as the norm", () => {
    // Measured across all 755 public datasets (catalog API, 2026-09-03):
    // CC0/public-domain is ~76%, non-commercial/no-derivatives is ~5%.
    // "Often non-commercial" was off by an order of magnitude.
    const body = llmsTxtBody();
    expect(body).not.toMatch(/often non-commercial/i);
  });
});

describe("llmsTxtBody honesty", () => {
  it("never claims an SEO or findability benefit", () => {
    const body = llmsTxtBody();
    expect(body).not.toMatch(/SEO/i);
    expect(body).not.toMatch(/findability/i);
    expect(body).not.toMatch(/discoverab/i);
  });
});
