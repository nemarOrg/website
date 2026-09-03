import { describe, expect, it } from "vitest";
import catalogFixture from "../../test/fixtures/sitemap-catalog.json";
import { MARKETING_BASE_URL } from "./host";
import {
  buildSitemapXml,
  datasetSitemapEntries,
  sitemapLastmod,
  staticSitemapEntries,
} from "./sitemap";
import type { Dataset } from "./types";

// Captured 2026-09-03 via:
//   curl -s "https://api.nemar.org/datasets?limit=5" > test/fixtures/sitemap-catalog.json
// All five rows happen to be status=active/visibility=public with managed
// (nm*/on*) ids -- the exclusion cases below are built by cloning a real row
// and overriding only the field under test, so every row still carries the
// real shape rather than an invented one.
const fixtureRows = catalogFixture.datasets as unknown as Dataset[];

describe("sitemapLastmod", () => {
  it("converts the API's space-separated UTC timestamp to a W3C datetime", () => {
    const row = fixtureRows.find((r) => r.dataset_id === "nm000281");
    expect(row?.updated_at).toBe("2026-08-31 11:09:05");
    expect(sitemapLastmod(row as Dataset)).toBe("2026-08-31T11:09:05.000Z");
  });

  it("equals the row's own updated_at, not created_at, when both are present", () => {
    const row = fixtureRows.find((r) => r.dataset_id === "nm000281") as Dataset;
    expect(row.updated_at).not.toBe(row.created_at);
    expect(sitemapLastmod(row)).toBe(sitemapLastmod({ updated_at: row.updated_at }));
  });

  it("falls back to created_at when updated_at is missing", () => {
    expect(sitemapLastmod({ updated_at: null, created_at: "2026-01-19 03:25:23" })).toBe(
      "2026-01-19T03:25:23.000Z",
    );
    expect(sitemapLastmod({ updated_at: "", created_at: "2026-01-19 03:25:23" })).toBe(
      "2026-01-19T03:25:23.000Z",
    );
  });

  it("returns null when neither timestamp is present", () => {
    expect(sitemapLastmod({ updated_at: null, created_at: null })).toBeNull();
    expect(sitemapLastmod({})).toBeNull();
  });

  it("returns null for a timestamp that does not parse rather than a wrong guess", () => {
    expect(sitemapLastmod({ updated_at: "not-a-date" })).toBeNull();
    expect(sitemapLastmod({ updated_at: "2026-13-40 99:99:99" })).toBeNull();
    // ISO-with-T is not the shape the API ships, so it deliberately does not
    // match either -- an omitted lastmod beats guessing at a second format.
    expect(sitemapLastmod({ updated_at: "2026-08-31T11:09:05Z" })).toBeNull();
  });
});

describe("datasetSitemapEntries", () => {
  it("lists every active/public managed row from the real catalog fixture", () => {
    const entries = datasetSitemapEntries(fixtureRows);
    expect(entries).toHaveLength(fixtureRows.length);
    const nm000281 = entries.find((e) => e.loc === `${MARKETING_BASE_URL}/dataset/nm000281`);
    expect(nm000281).toEqual({
      loc: `${MARKETING_BASE_URL}/dataset/nm000281`,
      lastmod: "2026-08-31T11:09:05.000Z",
    });
  });

  it("excludes a private row", () => {
    const base = fixtureRows[0];
    const privateRow: Dataset = { ...base, visibility: "private" };
    expect(datasetSitemapEntries([privateRow])).toHaveLength(0);
  });

  it("excludes a non-active row", () => {
    const base = fixtureRows[0];
    const withdrawnRow: Dataset = { ...base, status: "withdrawn" };
    expect(datasetSitemapEntries([withdrawnRow])).toHaveLength(0);
  });

  it("excludes a ds-prefixed row (it 301-redirects to its canonical)", () => {
    const base = fixtureRows[0];
    const dsRow: Dataset = { ...base, dataset_id: "ds007964" };
    expect(datasetSitemapEntries([dsRow])).toHaveLength(0);
  });

  it("includes a row with an unparseable timestamp, with no lastmod", () => {
    const base = fixtureRows[0];
    const badTimestampRow: Dataset = {
      ...base,
      updated_at: "garbage",
      created_at: "also garbage",
    };
    const entries = datasetSitemapEntries([badTimestampRow]);
    expect(entries).toHaveLength(1);
    expect(entries[0].lastmod).toBeNull();
  });
});

describe("staticSitemapEntries", () => {
  it("lists the fixed marketing routes with no lastmod", () => {
    const entries = staticSitemapEntries();
    expect(entries.map((e) => e.loc)).toEqual([
      `${MARKETING_BASE_URL}/`,
      `${MARKETING_BASE_URL}/discover`,
      `${MARKETING_BASE_URL}/about`,
      `${MARKETING_BASE_URL}/support`,
      `${MARKETING_BASE_URL}/privacy`,
      `${MARKETING_BASE_URL}/terms`,
    ]);
    expect(entries.every((e) => e.lastmod === null)).toBe(true);
  });

  it("never lists an app-host route", () => {
    const locs = staticSitemapEntries().map((e) => e.loc);
    for (const forbidden of ["/login", "/dashboard", "/upload", "/settings", "/admin", "/auth"]) {
      expect(locs.some((loc) => loc.includes(forbidden))).toBe(false);
    }
  });
});

describe("buildSitemapXml", () => {
  it("emits a valid urlset document", () => {
    const xml = buildSitemapXml(staticSitemapEntries());
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("</urlset>");
  });

  it("omits <lastmod> for entries with a null lastmod", () => {
    const xml = buildSitemapXml([{ loc: `${MARKETING_BASE_URL}/`, lastmod: null }]);
    expect(xml).not.toContain("<lastmod>");
  });

  it("includes <lastmod> for entries that have one", () => {
    const xml = buildSitemapXml([
      { loc: `${MARKETING_BASE_URL}/dataset/nm000281`, lastmod: "2026-08-31T11:09:05.000Z" },
    ]);
    expect(xml).toContain("<lastmod>2026-08-31T11:09:05.000Z</lastmod>");
  });

  it("escapes & and < in a value", () => {
    const xml = buildSitemapXml([
      { loc: `${MARKETING_BASE_URL}/discover?a=1&b=<script>`, lastmod: null },
    ]);
    expect(xml).toContain("&amp;b=&lt;script&gt;");
    expect(xml).not.toContain("&b=<script>");
  });

  it("never emits a link to openneuro.org", () => {
    const xml = buildSitemapXml([...staticSitemapEntries(), ...datasetSitemapEntries(fixtureRows)]);
    expect(xml).not.toContain("openneuro.org");
  });
});
