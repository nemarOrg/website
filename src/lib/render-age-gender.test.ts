import { describe, expect, it } from "vitest";
import { renderAgeGenderStackedSvg } from "./render-age-gender";

const rects = (svg: string) => [...svg.matchAll(/<rect [^>]*height="([\d.]+)"[^>]*><title>([^<]*)<\/title><\/rect>/g)];
const labels = (svg: string) =>
  [...svg.matchAll(/<text [^>]*font-family="var\(--font-mono\)"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
const count = (svg: string, re: RegExp) => (svg.match(re) ?? []).length;

describe("renderAgeGenderStackedSvg", () => {
  // Ages 20-69 fit to 5-year bins starting at 20: ten buckets.
  const ages = [20, 21, 25, 30, 30, 69];
  const sexes: Array<"M" | "F" | "O" | null> = ["M", "F", "M", "F", null, "M"];
  const svg = renderAgeGenderStackedSvg(ages, sexes);

  it("draws one labeled column per bucket and one baseline", () => {
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg).toContain('aria-label="Age distribution stacked by sex"');
    expect(labels(svg)).toEqual([
      "20-24",
      "25-29",
      "30-34",
      "35-39",
      "40-44",
      "45-49",
      "50-54",
      "55-59",
      "60-64",
      "65-69",
    ]);
    expect(count(svg, /<line /g)).toBe(1);
    // 10 buckets of 44 px plus 8 px on each side.
    expect(svg).toContain('viewBox="0 0 456 ');
  });

  it("stacks one segment per non-empty sex, scaled to the tallest bucket", () => {
    const segs = rects(svg).map((m) => [m[2], m[1]]);
    expect(segs).toEqual([
      ["20-24: 1 M", "65.00"],
      ["20-24: 1 F", "65.00"],
      ["25-29: 1 M", "65.00"],
      ["30-34: 1 F", "65.00"],
      ["30-34: 1 other", "65.00"],
      ["65-69: 1 M", "65.00"],
    ]);
  });

  it("draws a full-height bar for the tallest bucket", () => {
    const single = renderAgeGenderStackedSvg([30, 30, 31], ["F", "F", "F"]);
    expect(rects(single).map((m) => m[1])).toContain("130.00");
  });

  it("says there is no age data for an empty cohort", () => {
    const empty = renderAgeGenderStackedSvg([], []);
    expect(empty).toContain('aria-label="No age data"');
    expect(count(empty, /<rect /g)).toBe(0);
    expect(count(empty, /<line /g)).toBe(0);
  });

  it("says there is no age data when no age is a finite number", () => {
    const nan = renderAgeGenderStackedSvg([Number.NaN, Number.POSITIVE_INFINITY], ["M", "F"]);
    expect(nan).toContain('aria-label="No age data"');
    expect(count(nan, /<rect /g)).toBe(0);
  });

  it("ignores ages that are not finite numbers beside real ones", () => {
    const mixed = renderAgeGenderStackedSvg([Number.NaN, 30, 31], ["M", "F", "F"]);
    expect(rects(mixed).map((m) => m[2])).toEqual(["30: 1 F", "31: 1 F"]);
  });
});
