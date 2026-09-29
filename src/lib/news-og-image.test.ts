import { describe, expect, it } from "vitest";
import logoSvg from "../assets/nemar-logo.svg?raw";
import { NEWS_CARD_H, NEWS_CARD_W, renderNewsOgSvg } from "./news-og-image";

const BASE = {
  title: "Annotate with HED & SCORE <in the viewer>",
  category: "feature",
  publishedAt: "2026-09-02T19:00:00Z",
  bannerDataUri: null,
};

describe("renderNewsOgSvg", () => {
  it("is a 1200x630 card", () => {
    const svg = renderNewsOgSvg(BASE, logoSvg);
    expect(NEWS_CARD_W).toBe(1200);
    expect(NEWS_CARD_H).toBe(630);
    expect(svg).toContain('viewBox="0 0 1200 630"');
  });

  it("escapes the title everywhere it appears", () => {
    const svg = renderNewsOgSvg(BASE, logoSvg);
    expect(svg).toContain("HED &amp; SCORE &lt;in");
    expect(svg).not.toContain("<in the viewer>");
  });

  it("prints the category label and the date in NEMAR's time zone", () => {
    const svg = renderNewsOgSvg({ ...BASE, publishedAt: "2026-09-25T03:00:00Z" }, logoSvg);
    expect(svg).toContain(">New feature</text>");
    expect(svg).toContain(">September 24, 2026</text>");
  });

  it("frames the banner when there is one, and draws none otherwise", () => {
    const uri = "data:image/png;base64,iVBORw0KGgo=";
    expect(renderNewsOgSvg({ ...BASE, bannerDataUri: uri }, logoSvg)).toContain(`href="${uri}"`);
    expect(renderNewsOgSvg(BASE, logoSvg)).not.toContain("<image");
  });

  it("falls back to the update marker for an unknown category", () => {
    const svg = renderNewsOgSvg({ ...BASE, category: "webinar" }, logoSvg);
    expect(svg).toContain(">Update</text>");
  });
});
