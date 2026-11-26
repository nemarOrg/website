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
import { describe, expect, it } from "vitest";
import {
  BUDGET,
  CLIENT_MARKER,
  KB,
  measureChunks,
  measurementRoots,
  staticClosure,
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
    expect(BUDGET).toEqual({ worker: 12 * KB, mainThread: 30 * KB });
  });
});
