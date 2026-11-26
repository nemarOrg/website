/**
 * The quality views' exports (`src/lib/quality-views/export/`, website phase W8, #588): the PNG's
 * text chunks parse back and every CRC verifies, the SVG carries the view's digest, kind and
 * permalink in `<metadata>`, both are in the light palette whatever the theme, a file is handed over
 * as the exact bytes NEMAR recorded (and refused when they are not), and no export makes a request.
 *
 * Built on the record and files captured from the real nemar-cli route
 * (`test/fixtures/quality-views/route/`), read through the panel's own file source and models; the
 * answers reach it as `Response` objects of the captured bytes (HTTP fixtures). The PNG's pixels
 * and the controls in a real browser are `e2e/quality-panel.spec.ts`.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as download from "../src/lib/quality-views/export/download";
import * as exportMetaModule from "../src/lib/quality-views/export/meta";
import type { ExportMeta } from "../src/lib/quality-views/export/meta";
import * as palette from "../src/lib/quality-views/export/palette";
import * as png from "../src/lib/quality-views/export/png";
import { MAP_PX } from "../src/lib/quality-views/export/raster";
import * as svg from "../src/lib/quality-views/export/svg";
import { localChecks } from "../src/lib/quality-views/local-checks";
import { type BuiltModel, type ViewDecl, buildModel } from "../src/lib/quality-views/model";
import { type Montage, parseMontage } from "../src/lib/quality-views/montages";
import { qualityPermalink } from "../src/lib/quality-views/panel-model";
import { forgetPreloads, preloadedSource } from "../src/lib/quality-views/preloaded";
import { recordFiles } from "../src/lib/quality-views/quality-files";
import { type QualityRecord, readRecordAnswer } from "../src/lib/quality-views/record";
import { MAP_SIZE } from "../src/lib/quality-views/render/sensor-field-view";
import { escapeHtml, toHtml } from "../src/lib/quality-views/tree";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const ROUTE = "test/fixtures/quality-views/route";
const json = (path: string) => JSON.parse(fs.readFileSync(repoPath(path), "utf8"));
const captured = json(`${ROUTE}/record.json`) as { headers: Record<string, string>; body: string };
const files = json(`${ROUTE}/files.json`) as Record<string, { location: string }>;
const provenance = json(`${ROUTE}/provenance.json`) as {
  dataset_id: string;
  recipe: string;
  recording: string;
};
const BASE = "https://data.example.invalid";
const record = (await readRecordAnswer(
  new TextEncoder().encode(captured.body),
  captured.headers.ETag,
  {
    datasetId: provenance.dataset_id,
    recipe: provenance.recipe,
    recording: provenance.recording,
  },
)) as QualityRecord;
const viewOf = (key: string) => record.views.find((v) => v.key === key) as unknown as ViewDecl;
const fileBytes = (sha: string) => fs.readFileSync(repoPath(`${ROUTE}/files/${sha}`));
const montage = async (name: string): Promise<Montage> =>
  parseMontage(
    JSON.parse(
      fs.readFileSync(repoPath(`src/lib/quality-views/vocabulary/montages/${name}.json`), "utf8"),
    ),
    name,
  );

/** A fetch that answers each file URL with its captured bytes, counting requests. */
function routeFetch(flip?: string) {
  const requests: string[] = [];
  const answer = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    requests.push(url);
    const sha = Object.keys(files).find((s) => url.includes(`/${s}/`));
    if (!sha) return new Response("{}", { status: 404 });
    const bytes = fileBytes(sha).slice();
    if (sha === flip) bytes[10] ^= 1;
    return new Response(bytes);
  };
  return { requests, fetch: answer as typeof fetch };
}

async function built(key: string, fetcher = routeFetch()) {
  const source = preloadedSource(recordFiles(BASE, record, { fetch: fetcher.fetch }));
  const model = await buildModel(viewOf(key), source, { checks: localChecks, montage });
  return { model, source, fetcher };
}

const PERMALINK = qualityPermalink("https://nemar.org", provenance.dataset_id, "v1.0.0", {
  recording: provenance.recording,
  key: "spectrum",
});
const metaOf = (key: string, colorMaps = false): ExportMeta => {
  const view = viewOf(key);
  return {
    caption: view.caption,
    kind: view.kind,
    kindVersion: view.kind_version,
    digest: record.digests[key],
    permalink: PERMALINK,
    colorMaps,
  };
};

afterEach(() => forgetPreloads());

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

describe("CRC-32", () => {
  it("is the PNG CRC: the check value of the standard test string, and of nothing", () => {
    expect(png.crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(png.crc32(new Uint8Array(0))).toBe(0);
    // The IEND chunk's CRC every PNG ends with.
    expect(png.crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });
});

describe("the PNG's text chunks", () => {
  const original = fs.readFileSync(repoPath("public/logos/ucsd-library.png"));
  const entries = exportMetaModule.metaEntries(metaOf("spectrum", true));

  it("parse back, every CRC verifies, and the pixel chunks are the original's byte for byte", () => {
    const out = png.withTextChunks(original, entries);
    const before = png.pngChunks(original);
    const after = png.pngChunks(out);
    expect(after.every((c) => c.crcOk)).toBe(true);
    expect(after[0].type).toBe("IHDR");
    expect(after.at(-1)!.type).toBe("IEND");
    // The new chunks come right after the header, before any image data.
    expect(after.slice(1, 1 + entries.length).every((c) => c.type === "tEXt")).toBe(true);
    const kept = [after[0], ...after.slice(1 + entries.length)];
    expect(kept.map((c) => c.type)).toEqual(before.map((c) => c.type));
    kept.forEach((c, i) => {
      expect(Array.from(c.data)).toEqual(Array.from(before[i].data));
      expect(c.crc).toBe(before[i].crc);
    });
    expect(out.length).toBe(
      original.length + entries.reduce((n, [k, t]) => n + 12 + k.length + 1 + t.length, 0),
    );
    expect(png.pngTexts(out).slice(0, entries.length)).toEqual(entries);
  });

  it("names the view's digest, kind, kind version and permalink, and the color maps' notice", () => {
    const texts = Object.fromEntries(png.pngTexts(png.withTextChunks(original, entries)));
    expect(texts["nemar:view-digest"]).toBe(record.digests.spectrum);
    expect(texts["nemar:view-digest"]).toMatch(/^[0-9a-f]{64}$/);
    expect(texts["nemar:kind"]).toBe("nemar.spectrum");
    expect(texts["nemar:kind-version"]).toBe("1");
    expect(texts["nemar:permalink"]).toBe(PERMALINK);
    expect(texts["nemar:permalink"]).toBe(
      `https://nemar.org/dataset/${provenance.dataset_id}?v=v1.0.0#quality/${provenance.recording}/spectrum`,
    );
    expect(texts.Source).toBe(PERMALINK);
    expect(texts["nemar:color-maps"]).toContain(
      "https://nemar.org/licenses/quality-views/NOTICE.txt",
    );
    expect(texts["nemar:color-maps"]).toContain("Apache-2.0");
  });

  it("leaves the color maps' notice out when no map is shown", () => {
    const texts = Object.fromEntries(
      png.pngTexts(png.withTextChunks(original, exportMetaModule.metaEntries(metaOf("spectrum")))),
    );
    expect(texts["nemar:color-maps"]).toBeUndefined();
  });

  it("writes a text Latin-1 cannot hold as UTF-8 in iTXt, and reads it back", () => {
    const out = png.withTextChunks(original, [
      ["Title", "Spectrum – µV²/Hz, 脑电"],
      ["Comment", "µV² is Latin-1"],
    ]);
    const types = png.pngChunks(out).map((c) => c.type);
    expect(types.slice(1, 3)).toEqual(["iTXt", "tEXt"]);
    expect(png.pngTexts(out).slice(0, 2)).toEqual([
      ["Title", "Spectrum – µV²/Hz, 脑电"],
      ["Comment", "µV² is Latin-1"],
    ]);
    expect(png.pngChunks(out).every((c) => c.crcOk)).toBe(true);
  });

  it("refuses a keyword PNG does not allow", () => {
    for (const bad of ["", " Title", "Title ", "Two  spaces", "k".repeat(80), "tab\tkey", "ключ"]) {
      expect(() => png.textChunk(bad, "x"), bad).toThrow(RangeError);
    }
    expect(png.keywordOk("k".repeat(79))).toBe(true);
    expect(png.keywordOk("nemar:view-digest")).toBe(true);
  });

  it("finds a changed byte by its CRC and refuses to add to a file that is not a PNG", () => {
    const damaged = original.slice();
    damaged[40] ^= 1;
    expect(png.pngChunks(damaged).some((c) => !c.crcOk)).toBe(true);
    // The browser's encoder is trusted with its own chunks; one that is not a PNG is refused.
    expect(() =>
      png.withTextChunks(new TextEncoder().encode("GIF89a..........."), entries),
    ).toThrow(/header/);
    expect(() => png.pngChunks(new TextEncoder().encode("GIF89a.."))).toThrow(/signature/);
    expect(() => png.pngChunks(original.slice(0, original.length - 3))).toThrow(/past the end/);
  });
});

describe("the SVG export", () => {
  it("carries the digest, kind, kind version and permalink in <metadata>, and prints them", async () => {
    const { model } = await built("spectrum");
    const drawing = (await svg.svgDrawing(model))!;
    expect(drawing.tag).toBe("svg");
    const text = svg.exportSvg(drawing, metaOf("spectrum"), toHtml);
    const metadata = svg.svgMetadata(text)!;
    expect(metadata["nemar:view-digest"]).toBe(record.digests.spectrum);
    expect(metadata["nemar:kind"]).toBe("nemar.spectrum");
    expect(metadata["nemar:kind-version"]).toBe("1");
    expect(metadata["nemar:permalink"]).toBe(PERMALINK);
    expect(
      text.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg"',
      ),
    ).toBe(true);
    expect(text).toContain(
      `<title id="qv-export-title">${escapeHtml(viewOf("spectrum").caption)}</title>`,
    );
    expect(text).toContain(record.digests.spectrum);
    // The permalink is printed under the drawing, escaped as XML text.
    expect(text).toContain(PERMALINK.replace(/&/g, "&amp;"));
    // Every series the page drew, and no cursor.
    const series = (model.model as { series: { items: unknown[] } }).series.items.length;
    expect(text.match(/<polyline class="qv-series"/g)).toHaveLength(series);
    expect(text).not.toContain(`class="qv-cursor"`);
  });

  it("is offered for the spectrum and the histogram only", async () => {
    expect((await svg.svgDrawing((await built("icclasses")).model))?.attrs.class).toBe(
      "qv-histogram",
    );
    expect(await svg.svgDrawing((await built("icmaps")).model)).toBeNull();
    expect(await svg.svgDrawing(null)).toBeNull();
    const { model } = await built("spectrum");
    expect(
      await svg.svgDrawing({
        ...model,
        refused: { kind: "x", kind_version: 1, word: "w" },
      } as BuiltModel),
    ).toBeNull();
  });

  it("paints in the light palette: the page's light tokens, whatever the theme", () => {
    const tokens = fs.readFileSync(repoPath("src/styles/tokens.css"), "utf8");
    // The first declaration of a token is the light theme's (`:root`); dark ones come later.
    const light = (name: string) =>
      new RegExp(`${name}:\\s*([^;]+);`)
        .exec(tokens)?.[1]
        .replace(/\s*\/\*.*$/, "")
        .trim();
    expect(palette.LIGHT).toEqual({
      background: light("--color-bg"),
      foreground: light("--color-fg"),
      muted: light("--color-fg-muted"),
      axis: light("--chart-axis"),
      series: light("--chart-series-1"),
      selected: light("--chart-series-2"),
      end: light("--chart-series-4"),
      head: light("--qv-head-line"),
      contour: light("--qv-contour-line"),
    });
    const style = svg.exportStyle();
    expect(style).toContain(`.qv-series{stroke:${palette.LIGHT.series}`);
    expect(style).toContain(`.qv-tick{fill:${palette.LIGHT.axis}`);
    expect(style).toContain(".qv-cursor{display:none}");
    expect(style).not.toContain("var(");
  });

  it("offers SVG for lines and histograms only, and paints maps at the page's size", async () => {
    expect(palette.hasSvg((await built("spectrum")).model)).toBe(true);
    expect(palette.hasSvg((await built("icclasses")).model)).toBe(true);
    expect(palette.hasSvg((await built("icmaps")).model)).toBe(false);
    expect(palette.hasSvg(null)).toBe(false);
    expect(MAP_PX).toBe(MAP_SIZE);
  });

  it("paints a class by every class it has, later over earlier", () => {
    expect(palette.paintOf("qv-bar qv-bar-end").fill).toBe(palette.LIGHT.end);
    expect(palette.paintOf("qv-bar qv-marked").fill).toBe(palette.LIGHT.selected);
    expect(palette.paintOf("qv-cursor").hidden).toBe(true);
    expect(palette.paintOf("constructor toString")).toEqual({});
    expect(palette.paintOf(undefined)).toEqual({});
  });
});

describe("a file handed over", () => {
  it("is the exact bytes NEMAR recorded, from the source the view was drawn with, with no request", async () => {
    const { source, fetcher } = await built("spectrum");
    const asked = fetcher.requests.length;
    for (const decl of viewOf("spectrum").data ?? []) {
      const got = await download.verifiedBytes(decl, source);
      expect("bytes" in got).toBe(true);
      const bytes = (got as { bytes: Uint8Array }).bytes;
      expect(sameBytes(bytes, fileBytes(decl.sha256))).toBe(true);
    }
    // Drawn already: no file is asked for again.
    expect(fetcher.requests.length).toBe(asked);
  });

  it("is refused, with the reason, when the bytes are not the recorded ones", async () => {
    const values = viewOf("spectrum").data!.find((d) => d.role === "values")!;
    const fetcher = routeFetch(values.sha256);
    const source = preloadedSource(recordFiles(BASE, record, { fetch: fetcher.fetch }));
    expect(await download.verifiedBytes(values, source)).toEqual({ word: "file_digest_mismatch" });
    expect(await download.verifiedBytes({ ...values, size: values.size + 1 }, source)).toEqual({
      word: "file_size_mismatch",
    });
    expect(await download.verifiedBytes(values, async () => null)).toEqual({
      word: "file_missing",
    });
  });

  it("is saved with the media type of its extension", () => {
    expect(download.mediaTypeOf("a/b_spectrum.tsv")).toBe("text/tab-separated-values");
    expect(download.mediaTypeOf("a/b_icclasses.json")).toBe("application/json");
    expect(download.mediaTypeOf("x.PNG")).toBe("image/png");
    expect(download.mediaTypeOf("x.svg")).toBe("image/svg+xml");
    expect(download.mediaTypeOf("x.edf")).toBe("application/octet-stream");
  });
});

describe("no export makes a request", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("builds the SVG, the PNG's chunks and a drawn view's files with every fetch refused", async () => {
    const { model, source } = await built("spectrum");
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      throw new Error("no request may leave an export");
    }) as typeof fetch;
    const text = svg.exportSvg((await svg.svgDrawing(model))!, metaOf("spectrum"), toHtml);
    const out = png.withTextChunks(
      fs.readFileSync(repoPath("public/logos/ucsd-library.png")),
      exportMetaModule.metaEntries(metaOf("spectrum")),
    );
    for (const decl of viewOf("spectrum").data ?? []) {
      expect("bytes" in (await download.verifiedBytes(decl, source))).toBe(true);
    }
    expect(text.length).toBeGreaterThan(0);
    expect(out.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });
});

describe("the export's names and lines", () => {
  it("names a file by the recording and the view, in safe characters", () => {
    expect(download.exportName("spectrum", provenance.recording, "png")).toBe(
      `${provenance.recording
        .split("/")
        .pop()!
        .replace(/\.[^.]*$/, "")}_spectrum.png`,
    );
    expect(download.exportName("icmaps", null, "svg")).toBe("icmaps.svg");
    expect(download.exportName("k", "a/b c?.edf", "png")).toBe("b_c__k.png");
  });

  it("prints the kind, version, digest and permalink, and the notice only with a map", () => {
    const lines = exportMetaModule.footerLines(metaOf("icmaps", true));
    expect(lines[0]).toBe(
      `nemar.ic-maps, version 1; view digest (nemar.view-digest.v1) ${record.digests.icmaps}`,
    );
    expect(lines[1]).toBe(PERMALINK);
    expect(lines[2]).toContain("https://nemar.org/licenses/quality-views/NOTICE.txt");
    expect(exportMetaModule.footerLines(metaOf("icmaps"))).toHaveLength(2);
    expect(exportMetaModule.noticeUrl("https://test.example/dataset/x#quality")).toBe(
      "https://test.example/licenses/quality-views/NOTICE.txt",
    );
  });
});
