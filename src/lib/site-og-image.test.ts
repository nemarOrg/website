import { describe, expect, it } from "vitest";
import { renderSiteOgSvg } from "./site-og-image";

const LOGO =
  '<svg viewBox="0 0 10 10"><g fill="var(--brand-accent, currentColor)"></g><g fill="var(--brand-electrode, currentColor)"></g></svg>';

describe("renderSiteOgSvg", () => {
  it("renders the three hosted stats with hero formatting", () => {
    const svg = renderSiteOgSvg({ datasets: 759, participants: 8_900, size: 54 * 1024 ** 4 }, LOGO);

    expect(svg).toContain(">759<");
    expect(svg).toContain(">8.9K<"); // formatCount
    expect(svg).toContain(">54.0 TB<"); // formatBytes
    expect(svg).toContain('width="1200" height="630"');
  });

  it("bakes light-gold electrodes and white wordmark into the embedded logo", () => {
    const svg = renderSiteOgSvg({ datasets: 1, participants: 1, size: 1024 }, LOGO);

    expect(svg).toContain('style="color:#f8fafc"');
    expect(svg).toContain('fill="#5bbad5"'); // brain outline stays cyan
    expect(svg).toContain('fill="#f4d06b"'); // electrodes -> light gold
    expect(svg).not.toContain("var(--brand-accent");
    expect(svg).not.toContain("var(--brand-electrode");
  });

  it("shows Unavailable rather than a zero size when the catalog is empty", () => {
    const svg = renderSiteOgSvg({ datasets: 0, participants: 0, size: 0 }, LOGO);
    expect(svg).toContain(">Unavailable<");
  });
});
