/**
 * What `scripts/check-quality-views-size.mjs` measures (website ADR 0035 decision 1; website#592),
 * on chunk layouts made to order: the script's measuring half, `quality-views-size-lib.mjs`, runs
 * unchanged on scripts written here in the shapes Vite emits.
 *
 * The case website#592 names: two lazy panels import the client, Vite splits the client into a
 * chunk of its own, and one panel is over budget. Measured from the client's chunk alone, as the
 * script did before, the panel's own code is never counted; measured from each dynamically
 * imported chunk that reaches the client, it is.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUDGET,
  CLIENT_MARKER,
  CHUNK_MARKERS,
  ISLAND_PREFIX,
  KB,
  lookupIsland,
  lookupStem,
  measureChunks,
  measurementRoots,
  namedChunk,
  staticClosure,
  staticImports,
} from "../scripts/quality-views-size-lib.mjs";

/** Script text that gzip cannot shrink much: `kib` kilobytes of base64 (about three quarters of it survives gzip). */
const bulk = (kib: number): string => `/*${randomBytes(kib * 768).toString("base64")}*/`;

const files = (entries: Record<string, string>): Map<string, Buffer> =>
  new Map(Object.entries(entries).map(([name, text]) => [name, Buffer.from(text)]));

const client = `const m="${CLIENT_MARKER}";new Worker(new URL("worker-abc.js",import.meta.url),{type:"module"});export{m};`;
const worker = `self.onmessage=()=>{};${bulk(2)}`;

describe("two lazy panels sharing the client (website#592)", () => {
  const layout = files({
    "page.js": `const a=()=>import("./panel-a.js");const b=()=>import("./panel-b.js");export{a,b};`,
    "panel-a.js": `import{m}from"./client.js";${bulk(60)}export{m};`,
    "panel-b.js": `import{m}from"./client.js";${bulk(4)}export{m};`,
    "client.js": client,
    "worker-abc.js": worker,
  });

  it("measures from each panel, not from the client's chunk alone", () => {
    expect(measurementRoots(layout)).toEqual({
      clients: ["client.js"],
      roots: ["panel-a.js", "panel-b.js"],
      fromDynamicImports: true,
    });
  });

  it("finds the panel over budget that the client's chunk alone would hide", () => {
    const { results, eager } = measureChunks("fixture", layout);
    // Each panel is measured once, from its lazy root, never again as an eager importer.
    expect(eager).toEqual({ direct: [], above: [] });
    expect(results.filter((r) => r.root === "panel-a.js")).toHaveLength(1);
    const fromA = results.find((r) => r.root === "panel-a.js")!;
    const fromB = results.find((r) => r.root === "panel-b.js")!;
    expect(fromA.size).toBeGreaterThan(BUDGET.mainThread);
    expect(fromB.size).toBeLessThan(BUDGET.mainThread);
    expect(fromA.label).toContain("client.js + panel-a.js");
    // What the earlier rule measured: the client's chunk and its static imports, under budget.
    const clientOnly = [...staticClosure(["client.js"], layout)];
    expect(clientOnly).toEqual(["client.js"]);
    expect(results.filter((r) => r.label.includes("worker-abc.js"))).toHaveLength(1);
  });
});

describe("a panel imported statically by the page (the review of website#593)", () => {
  const layout = files({
    "page.js": `import{p}from"./dataset-panel.js";${bulk(80)}const v=()=>import("./viewer.js");export{p,v};`,
    "dataset-panel.js": `import{m}from"./worker-client.js";${bulk(45)}export const p=m;`,
    "viewer.js": `const c=()=>import("./worker-client.js");export{c};`,
    "worker-client.js": client,
    "worker-abc.js": worker,
  });

  it("measures the panel that imports the client eagerly, which no lazy root holds", () => {
    const measured = measureChunks("fixture", layout);
    expect(measured.roots).toEqual(["worker-client.js"]);
    expect(measured.eager).toEqual({ direct: ["dataset-panel.js"], above: ["page.js"] });
    const panel = measured.results.find((r) => r.root === "dataset-panel.js")!;
    expect(panel.label).toContain("dataset-panel.js + worker-client.js");
    expect(panel.size).toBeGreaterThan(BUDGET.mainThread);
    expect(measured.notes.join("\n")).toContain(
      "page.js reaches the client through a static import",
    );
  });
});

describe("a facade that re-exports the client", () => {
  it.each([
    ["export {..} from", `export{m}from"./client.js";`],
    ["export * from", `export*from"./client.js";`],
    ["export * as", `export * as c from "./client.js";`],
  ])("is followed through %s", (_form, facade) => {
    const layout = files({
      "page.js": `const f=()=>import("./facade.js");export{f};`,
      "facade.js": `${facade}${bulk(4)}`,
      "client.js": client,
      "worker-abc.js": worker,
    });
    expect(staticImports(facade, layout)).toEqual(["client.js"]);
    const measured = measureChunks("fixture", layout);
    expect(measured.roots).toEqual(["facade.js"]);
    expect(measured.results.find((r) => r.root === "facade.js")!.label).toContain(
      "client.js + facade.js",
    );
  });
});

describe("the signal viewer's layout", () => {
  it("measures the client's own chunk when the viewer imports it lazily", () => {
    const layout = files({
      "viewer.js": `${bulk(60)}const c=()=>import("./worker-client.js");export{c};`,
      "worker-client.js": `import{x}from"./contours.js";${client}`,
      "contours.js": "export const x=1;",
      "worker-abc.js": worker,
      "worker-fallback.js": "export const inThreadWorker=1;",
    });
    expect(measurementRoots(layout).roots).toEqual(["worker-client.js"]);
    const { results } = measureChunks("fixture", layout);
    const main = results.find((r) => r.root === "worker-client.js")!;
    expect(main.label).toContain("contours.js + worker-client.js");
    expect(main.label).not.toContain("viewer.js");
    expect(main.size).toBeLessThan(BUDGET.mainThread);
  });

  it("never counts the client's own lazy fallback, which imports the client's shared code back", () => {
    const layout = files({
      "measured-entry.js": `${client}const f=()=>import("./fallback.js");export{f};`,
      "fallback.js": `import{m}from"./measured-entry.js";${bulk(40)}export{m};`,
      "worker-abc.js": worker,
    });
    const measured = measureChunks("fixture", layout);
    expect(measured.roots).toEqual(["measured-entry.js"]);
    const main = measured.results.find((r) => r.root === "measured-entry.js")!;
    expect(main.label).not.toContain("fallback.js");
    expect(measured.eager).toEqual({ direct: [], above: [] });
    expect(measured.notes.join("\n")).toContain("fallback.js");
  });

  it("falls back to the client's chunk, and says so, when nothing imports it lazily", () => {
    const layout = files({ "entry.js": client, "worker-abc.js": worker });
    const measured = measureChunks("fixture", layout);
    expect(measured.roots).toEqual(["entry.js"]);
    expect(measured.notes.join("\n")).toContain("no dynamically imported chunk reaches the client");
  });

  it("measures nothing when no script carries the client", () => {
    const measured = measureChunks("fixture", files({ "a.js": "export{}" }));
    expect(measured).toMatchObject({ clients: [], roots: [], results: [] });
  });

  it("refuses a measured set that names no worker", () => {
    const layout = files({
      "page.js": `const a=()=>import("./panel.js");export{a};`,
      "panel.js": `const m="${CLIENT_MARKER}";export{m};`,
    });
    expect(() => measureChunks("fixture", layout)).toThrow(/no module worker/);
  });

  it("states its budgets", () => {
    expect(BUDGET).toEqual({ worker: 16 * KB, mainThread: 30 * KB });
  });
});

// The panel's chunk is found by its module's name and its loading sentence together, and exactly one
// chunk must match: the admin drill-down's chunk holds the same sentence, another component's chunk
// is also named `panel`, and which of two matches a directory lists first depends on its file system
// and on the chunks' content hashes, so a first match measured one chunk on one machine and the
// other on the next (website#608).
describe("the chunk a first screen is measured from", () => {
  const LOADING = "Loading the recording's quality views";
  const chunks: Record<string, string> = {
    "admin-drill.Cd-pzLlA.js": `const s="${LOADING}…";export{s};`,
    "panel.WHQJUugx.js": "const other=1;export{other};",
    "panel.D2DfCQhV.js": `const s="${LOADING}…";export{s};`,
    "lines.BhwKn-pD.js": "export const l=1;",
  };
  /** The chunks written to a directory and read back as the script reads `dist/_astro/`. */
  const fromDirectory = (entries: Record<string, string>): Map<string, Buffer> => {
    const dir = mkdtempSync(join(tmpdir(), "quality-views-lookup-"));
    try {
      for (const [name, text] of Object.entries(entries)) writeFileSync(join(dir, name), text);
      return new Map(
        readdirSync(dir)
          .filter((name) => name.endsWith(".js"))
          .map((name) => [name, readFileSync(join(dir, name))]),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("picks the panel, not the admin drill-down's chunk with the same sentence", () => {
    expect(namedChunk(fromDirectory(chunks), "panel.", LOADING)).toEqual({
      name: "panel.D2DfCQhV.js",
      error: null,
    });
  });

  it("picks the same chunk whatever order the directory lists them in", () => {
    const names = Object.keys(chunks);
    for (const order of [names, [...names].reverse()]) {
      const layout = files(Object.fromEntries(order.map((name) => [name, chunks[name]])));
      expect(namedChunk(layout, "panel.", LOADING).name).toBe("panel.D2DfCQhV.js");
    }
  });

  it("fails when no chunk named for the module holds the sentence", () => {
    const { "panel.D2DfCQhV.js": _panel, ...withoutPanel } = chunks;
    const { name, error } = namedChunk(fromDirectory(withoutPanel), "panel.", LOADING);
    expect(name).toBeNull();
    expect(error).toBe(`no chunk named panel.* holds "${LOADING}"`);
  });

  it("fails, naming both, when two chunks named for the module hold the sentence", () => {
    const twice = { ...chunks, "panel.WHQJUugx.js": `const s="${LOADING}";export{s};` };
    const { name, error } = namedChunk(fromDirectory(twice), "panel.", LOADING);
    expect(name).toBeNull();
    expect(error).toContain('2 chunks named panel.* holds "');
    expect(error).toContain("(panel.D2DfCQhV.js, panel.WHQJUugx.js)");
  });

  it("finds a chunk by its name alone when it has no sentence, and fails on two", () => {
    expect(namedChunk(files(chunks), "lines.").name).toBe("lines.BhwKn-pD.js");
    const two = files({ ...chunks, "lines.Zz9.js": "export const l=2;" });
    expect(namedChunk(two, "lines.")).toEqual({
      name: null,
      error:
        "2 chunks named lines.* (lines.BhwKn-pD.js, lines.Zz9.js); which one is measured would depend on the directory's order",
    });
    expect(namedChunk(files(chunks), "spectrum.").error).toBe("no chunk named spectrum.*");
  });
});

// What the gate asks for each name (`lookupStem`, `lookupIsland`), on the chunks Vite emits beside the
// panel's: its own sentences, model and bridge, the island, another component's `panel`, the admin's.
describe("the names the gate looks up", () => {
  const LOADING = CHUNK_MARKERS.panel;
  const site: Record<string, string> = {
    "panel.D2DfCQhV.js": `const s="${LOADING}…";export{s};`,
    "panel.WHQJUugx.js": "const other=1;export{other};",
    // The panel's sentences could hold its loading sentence too: only the name tells them apart.
    "panel-words.WkOU3RDH.js": `const w={loading:"${LOADING}…"};export{w};`,
    "panel-model.DSJ9qExU.js": "export const TABS=[];",
    "panel-bridge.BvMZlB84.js": "export const bridge=1;",
    "admin-drill.Cd-pzLlA.js": `const s="${LOADING}…";export{s};`,
    [`${ISLAND_PREFIX}_index_0_lang.B1LCM-O8.js`]: 'import"./panel-model.DSJ9qExU.js";',
  };

  it("finds the panel by its name and its sentence, never panel-words, panel-model or panel-bridge", () => {
    expect(lookupStem(files(site), "panel")).toEqual({ name: "panel.D2DfCQhV.js", error: null });
    expect(lookupStem(files(site), "panel-model").name).toBe("panel-model.DSJ9qExU.js");
    expect(lookupStem(files(site), "panel-bridge").name).toBe("panel-bridge.BvMZlB84.js");
  });

  it("fails when the panel's chunk has lost its sentence", () => {
    const lost = { ...site, "panel.D2DfCQhV.js": "const s=1;export{s};" };
    expect(lookupStem(files(lost), "panel")).toEqual({
      name: null,
      error: `no chunk named panel.* holds "${LOADING}"`,
    });
  });

  it("finds the export's chunks by their sentences, and a chunk with none by its name", () => {
    const withExport = {
      ...site,
      "controls.B-Dv6hg7.js": `const b="${CHUNK_MARKERS.controls}";export{b};`,
      "picture.BrzeZOZT.js": `const e="${CHUNK_MARKERS.picture}";export{e};`,
      "maps-part.CjLS3rLr.js": "export const m=1;",
    };
    expect(lookupStem(files(withExport), "controls").name).toBe("controls.B-Dv6hg7.js");
    expect(lookupStem(files(withExport), "picture").name).toBe("picture.BrzeZOZT.js");
    expect(lookupStem(files(withExport), "maps-part").name).toBe("maps-part.CjLS3rLr.js");
    expect(lookupStem(files(site), "controls").error).toBe(
      `no chunk named controls.* holds "${CHUNK_MARKERS.controls}"`,
    );
  });

  it("finds the island script, and fails on two", () => {
    const island = `${ISLAND_PREFIX}_index_0_lang.B1LCM-O8.js`;
    expect(lookupIsland(files(site))).toEqual({ name: island, error: null });
    const two = { ...site, [`${ISLAND_PREFIX}_index_1_lang.Q.js`]: "export{};" };
    expect(lookupIsland(files(two)).error).toContain(`2 chunks named ${ISLAND_PREFIX}*`);
  });
});
