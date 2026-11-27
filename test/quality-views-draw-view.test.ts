/**
 * The drawing steps the panel and the admin drill-down share (`src/lib/quality-views/draw-view.ts`,
 * nemarOrg/website#600), on the record and files captured from the real nemar-cli route
 * (`test/fixtures/quality-views/route/`): a declaration that is not its digest is refused before
 * any file is read, a file that is not its digest is refused before anything is mounted, and a view
 * that could not be drawn says so unless its work was aborted. That both callers draw a view the
 * same, element for element, is `e2e/quality-draw-parity.spec.ts`, in a real browser.
 */

import { describe, expect, it } from "vitest";
import { drawView, sayFailed } from "../src/lib/quality-views/draw-view";
import type { FileSource, ViewDecl } from "../src/lib/quality-views/model";
import { type QualityRecord, readRecordAnswer } from "../src/lib/quality-views/record";
import { inThreadWorker } from "../src/lib/quality-views/worker";
import { SensorFieldClient } from "../src/lib/quality-views/worker-client";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const ROUTE = "test/fixtures/quality-views/route";
const json = (path: string) => JSON.parse(fs.readFileSync(repoPath(path), "utf8"));
const captured = json(`${ROUTE}/record.json`);
const provenance = json(`${ROUTE}/provenance.json`);
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

/** Just enough of a document for `toDom`: elements keep their attributes and children. */
interface Node {
  tag?: string;
  text?: string;
  attrs: Record<string, string>;
  children: Node[];
  dataset: Record<string, string>;
  className?: string;
  textContent?: string;
}
function fakeDocument() {
  const element = (tag: string) => ({
    tag,
    attrs: {} as Record<string, string>,
    children: [] as unknown[],
    dataset: {} as Record<string, string>,
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    },
    appendChild(child: unknown) {
      this.children.push(child);
      return child;
    },
  });
  return {
    createElement: element,
    createElementNS: (_ns: string, tag: string) => element(tag),
    createTextNode: (text: string) => ({ text, attrs: {}, children: [], dataset: {} }),
  } as unknown as Document;
}

function containerOf(doc: Document) {
  const shown: Node[] = [];
  const container = {
    ownerDocument: doc,
    replaceChildren: (...nodes: Node[]) => shown.splice(0, shown.length, ...nodes),
  } as unknown as HTMLElement;
  return { container, shown };
}

const words = (node: Node): string[] => [
  ...(node.attrs?.["data-word"] ? [node.attrs["data-word"]] : []),
  ...(node.children ?? []).flatMap(words),
];

/** The route's files by SHA-256, each read counted; `flip` changes one byte of one. */
function filesOf(flip?: string) {
  const read: string[] = [];
  const source: FileSource = async (file) => {
    read.push(file.sha256);
    const bytes = new Uint8Array(fs.readFileSync(repoPath(`${ROUTE}/files/${file.sha256}`)));
    if (file.sha256 === flip) bytes[10] ^= 1;
    return bytes;
  };
  return { source, read };
}

/** A caller's deps; `mounted` keeps each mount's arguments (target, built, ctx, layout key). */
function depsOf(files: FileSource, mounted: unknown[][]) {
  const client = new SensorFieldClient(inThreadWorker);
  return {
    doc: fakeDocument(),
    idPrefix: "qx",
    fileUrl: (file: { sha256: string }) => `/file/${file.sha256}`,
    files,
    client: () => client,
    mount: async (...args: unknown[]): Promise<HTMLElement | null> => {
      mounted.push(args);
      return null;
    },
    sentence: async (word: string) => `sentence of ${word}`,
  };
}

describe("drawView", () => {
  it("refuses a declaration that is not its digest before reading any file", async () => {
    const view = { ...viewOf("icmaps"), caption: "edited" } as ViewDecl;
    const { source, read } = filesOf();
    const mounted: unknown[][] = [];
    const deps = depsOf(source, mounted);
    const { container, shown } = containerOf(deps.doc);
    const drew = await drawView(view, record, container, new AbortController().signal, deps);
    expect(drew).toBeUndefined();
    expect(shown.flatMap(words)).toEqual(["view_digest_mismatch"]);
    expect(read).toEqual([]);
    expect(mounted).toEqual([]);
  });

  it("refuses a file that is not its digest, with its good files listed, and mounts nothing", async () => {
    const view = viewOf("spectrum");
    const values = view.data!.find((d) => d.role === "values")!;
    const { source, read } = filesOf(values.sha256);
    const mounted: unknown[][] = [];
    const deps = depsOf(source, mounted);
    const { container, shown } = containerOf(deps.doc);
    const drew = await drawView(view, record, container, new AbortController().signal, deps);
    expect(drew).toBeUndefined();
    expect(read).toContain(values.sha256);
    expect(shown.flatMap(words)).toContain("file_digest_mismatch");
    // The refusal's downloads (ViewRefused's), at the caller's addresses: the good files only.
    const layout = view.data!.find((d) => d.role === "layout")!;
    expect(JSON.stringify(shown)).toContain(`"href":"/file/${layout.sha256}"`);
    expect(JSON.stringify(shown)).not.toContain(`/file/${values.sha256}`);
    expect(mounted).toEqual([]);
  });

  it("mounts a view with good files once, its geometry keyed by its layout file's SHA-256", async () => {
    const view = viewOf("spectrum");
    const layout = view.data!.find((d) => d.role === "layout")!;
    const { source } = filesOf();
    const mounted: unknown[][] = [];
    const deps = depsOf(source, mounted);
    const { container, shown } = containerOf(deps.doc);
    await drawView(view, record, container, new AbortController().signal, deps);
    expect(mounted).toHaveLength(1);
    const [target, built, ctx, layoutKey] = mounted[0] as [
      unknown,
      { refused: string | null },
      { id: string },
      string,
    ];
    expect(layoutKey).toBe(layout.sha256);
    expect(built.refused).toBeNull();
    expect(ctx.id).toBe("qx-spectrum");
    // The base's target is what the container holds.
    expect(shown).toEqual([target]);
    expect(shown.flatMap(words)).toEqual([]);
  });

  it.each([
    ["answers", false],
    ["fails", true],
  ])(
    "shows and mounts nothing when its work is aborted as its first file is read and %s",
    async (_, fails) => {
      const stop = new AbortController();
      const { source: good } = filesOf();
      const source: FileSource = async (file) => {
        stop.abort();
        if (fails) throw new DOMException("aborted", "AbortError");
        return good(file);
      };
      const mounted: unknown[][] = [];
      const deps = depsOf(source, mounted);
      const { container, shown } = containerOf(deps.doc);
      expect(
        await drawView(viewOf("spectrum"), record, container, stop.signal, deps),
      ).toBeUndefined();
      expect(shown).toEqual([]);
      expect(mounted).toEqual([]);
    },
  );

  it("draws nothing once its work is aborted", async () => {
    const { source, read } = filesOf();
    const mounted: unknown[][] = [];
    const deps = depsOf(source, mounted);
    const { container, shown } = containerOf(deps.doc);
    const stop = new AbortController();
    stop.abort();
    expect(
      await drawView(viewOf("spectrum"), record, container, stop.signal, deps),
    ).toBeUndefined();
    expect(shown).toEqual([]);
    expect(read).toEqual([]);
    expect(mounted).toEqual([]);
  });
});

describe("sayFailed", () => {
  it("says the view could not be drawn, in the caller's sentence", async () => {
    const doc = fakeDocument();
    const { container, shown } = containerOf(doc);
    await sayFailed(container, new AbortController().signal, async (w) => `sentence of ${w}`);
    expect(shown).toHaveLength(1);
    expect(shown[0].dataset.word).toBe("failed");
    expect(shown[0].className).toBe("qv-note");
    expect(shown[0].textContent).toBe("sentence of failed");
  });

  it("says nothing when the work was aborted while the sentence loaded", async () => {
    const doc = fakeDocument();
    const { container, shown } = containerOf(doc);
    const stop = new AbortController();
    await sayFailed(container, stop.signal, async (w) => {
      stop.abort();
      return w;
    });
    expect(shown).toEqual([]);
  });
});
