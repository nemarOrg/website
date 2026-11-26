/**
 * The page's side of the review's fixes to #594 (website#588 phase W4):
 *
 * - the declaration and content checks run in the map worker (`SensorFieldClient.checks()`), with
 *   the same verdicts as on this thread, and on this thread when the worker cannot answer;
 * - the model builders are keyed by `kind@version`;
 * - a scalp map's layout is fetched beside its values, never behind them, and handed to the page
 *   (`onLayout`) as soon as it is read;
 * - `warmInput` selects the rows `fieldDrawInput` draws, so a geometry prepared from the layout
 *   alone is the one the maps' draw finds in the worker's cache (a layout with an EOG row and an
 *   `n/a` place, among others).
 */

import { describe, expect, it } from "vitest";
import { localChecks } from "../src/lib/quality-views/local-checks";
import {
  BUILDERS,
  type FileDecl,
  type SensorFieldModel,
  buildModel,
  subtleSha256,
  warmInput,
} from "../src/lib/quality-views/model";
import { type Montage, parseMontage } from "../src/lib/quality-views/montages";
import {
  forgetPreloads,
  preloadedSource,
  prepareAhead,
  readLimited,
  shouldPreload,
} from "../src/lib/quality-views/prepare-ahead";
import { readTsv } from "../src/lib/quality-views/read";
import { fieldDrawInput } from "../src/lib/quality-views/render/sensor-field-view";
import { createSensorFieldHandler, inThreadWorker } from "../src/lib/quality-views/worker";
import { SensorFieldClient } from "../src/lib/quality-views/worker-client";
import { nodeFs, nodeProcess, repoPath } from "./node";
import { MONTAGES_DIR, loadFieldVectors, mapOutcome } from "./quality-views-vectors";

const fs = await nodeFs();
const read = (file: string) =>
  JSON.parse(fs.readFileSync(repoPath(`test/fixtures/quality-views/vectors/${file}`), "utf8"));
const verdicts = read("kinds-verdicts.v1.json") as {
  cases: { name: string; schema: string; instance: unknown; valid: boolean }[];
};
type Files = Record<string, { text?: string; base64?: string }>;
const models = read("kinds-models.v1.json") as {
  cases: {
    name: string;
    view: unknown;
    files: Files;
    caps?: Record<string, number>;
    model: { model: { type: string } };
  }[];
};

const montage = async (name: string): Promise<Montage> =>
  parseMontage(JSON.parse(fs.readFileSync(repoPath(`${MONTAGES_DIR}/${name}.json`), "utf8")), name);
const source =
  (files: Files) =>
  async (file: FileDecl): Promise<Uint8Array | null> => {
    const held = files[file.location];
    if (!held) return null;
    if (held.text !== undefined) return new TextEncoder().encode(held.text);
    return Uint8Array.from(atob(held.base64!), (c) => c.charCodeAt(0));
  };

describe("the checks run in the worker", () => {
  const views = verdicts.cases.filter((c) => c.schema === "view");
  const contents = verdicts.cases.filter((c) => c.schema.startsWith("content."));

  it("gives every verdict of the corpus, as this thread does", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const checks = client.checks();
    for (const c of views) {
      const [worker, local] = await Promise.all([
        checks.view(c.instance),
        localChecks.view(c.instance),
      ]);
      expect(worker, c.name).toEqual(local);
      expect(worker.valid, c.name).toBe(c.valid);
    }
    for (const c of contents) {
      expect(await checks.content(c.schema, c.instance), c.name).toBe(c.valid);
    }
    client.terminate();
  });

  it("checks on this thread when the worker cannot start, with the same verdicts", async () => {
    const client = new SensorFieldClient(() => {
      throw new Error("no workers");
    });
    const checks = client.checks();
    for (const c of views.slice(0, 40)) {
      expect((await checks.view(c.instance)).valid, c.name).toBe(c.valid);
    }
  });

  it("builds every model vector's model the same through the worker's checks", async () => {
    const client = new SensorFieldClient(inThreadWorker);
    const checks = client.checks();
    const settle = (p: Promise<unknown>) =>
      p.then(
        (v) => v,
        (error: unknown) => String(error),
      );
    for (const c of models.cases) {
      const caps = c.caps
        ? { bytes_per_role: 4194304, entries_per_dim: 1024, cells_per_role: 262144, ...c.caps }
        : undefined;
      const options = { montage, mapOutcome, caps };
      const [a, b] = await Promise.all([
        settle(buildModel(c.view, source(c.files), { ...options, checks })),
        settle(buildModel(c.view, source(c.files), { ...options, checks: localChecks })),
      ]);
      expect(a, c.name).toEqual(b);
    }
    client.terminate();
  });
});

describe("the worker checks the computed presets itself", () => {
  it("answers a check of every computed preset's case, with the corpus's verdict", async () => {
    const posted: { type: string; id: number; valid?: boolean }[] = [];
    const handle = createSensorFieldHandler((message) => posted.push(message as never));
    const computed = verdicts.cases.filter(
      (c) =>
        c.schema === "view" &&
        /^nemar\.(ic-activity|signal-window)$/.test(
          String((c.instance as { kind?: unknown }).kind),
        ),
    );
    computed.forEach((c, id) => handle({ type: "check", id, view: c.instance }));
    for (let i = 0; i < 50 && posted.length < computed.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(posted).toHaveLength(computed.length);
    for (const answer of posted) {
      expect(answer.type).toBe("checked");
      expect(answer.valid, computed[answer.id].name).toBe(computed[answer.id].valid);
    }
  });
});

describe("the model builders", () => {
  it("are keyed by kind and version: the five generic kinds at version 1", () => {
    expect([...BUILDERS.keys()].sort()).toEqual([
      "nemar.heatmap@1",
      "nemar.histogram@1",
      "nemar.lines@1",
      "nemar.sensor-field@1",
      "nemar.table@1",
    ]);
  });
});

// A scalp map placed by a measured layout: 20 EEG sensors of the vectors' 64-channel cap, an EOG
// row (not drawn) and an EEG row with no place (`n/a`, not drawn), one map per component.
const field = await loadFieldVectors();
const cap = field.cases.find((c) => c.name === "montage_64")!.sensors;
const rows = [
  ...Array.from({ length: 20 }, (_, k) => ({
    name: cap.name[k],
    theta: String(cap.theta_deg![k]),
    radius: String(cap.radius![k]),
    type: "EEG",
  })),
  { name: "EOG1", theta: "0", radius: "0.6", type: "EOG" },
  { name: "X1", theta: "n/a", radius: "n/a", type: "EEG" },
];
const layoutText = `name\ttheta_deg\tradius\tsensor_type\n${rows.map((r) => `${r.name}\t${r.theta}\t${r.radius}\t${r.type}`).join("\n")}\n`;
const valuesText = `IC1\tIC2\n${rows.map((_, k) => `${Math.sin(k + 1)}\t${Math.cos(k * 0.7)}`).join("\n")}\n`;
const encode = (text: string) => new TextEncoder().encode(text);
const LAYOUT = "sub-01/eeg/sub-01_desc-test_chanlocs.tsv";
const VALUES = "sub-01/eeg/sub-01_desc-test_mixing.tsv";
const view = {
  key: "icmaps",
  kind: "nemar.sensor-field",
  kind_version: 1,
  caption: "Component maps.",
  source: { recipe: { name: "nemar-ica", version: "0.1.0" } },
  data: [
    {
      role: "values",
      location: VALUES,
      format: "tsv",
      size: encode(valuesText).length,
      sha256: await subtleSha256(encode(valuesText)),
      columns: [
        { name: "IC1", type: "number" },
        { name: "IC2", type: "number" },
      ],
      dims: [
        {
          name: "sensor",
          axis: "rows",
          type: "string",
          coords: { role: "layout", column: "name" },
        },
        { name: "component", axis: "columns", type: "string", coords: { header: true } },
      ],
    },
    {
      role: "layout",
      location: LAYOUT,
      format: "tsv",
      size: encode(layoutText).length,
      sha256: await subtleSha256(encode(layoutText)),
      columns: [
        { name: "name", type: "string" },
        { name: "theta_deg", type: "number", unit: "deg" },
        { name: "radius", type: "number" },
        { name: "sensor_type", type: "string" },
      ],
      dims: [{ name: "sensor", axis: "rows", type: "string", coords: { column: "name" } }],
      coordinate_system: "CapTrak",
      position_source: "measured",
    },
  ],
};
const files = { [LAYOUT]: { text: layoutText }, [VALUES]: { text: valuesText } };

describe("the layout before the values", () => {
  it("is valid and draws the 20 placed EEG rows", async () => {
    expect((await localChecks.view(view)).valid).toBe(true);
    const built = await buildModel(view, source(files), { checks: localChecks, montage });
    const model = built.model as SensorFieldModel;
    expect(model.type).toBe("sensor-field");
    expect(model.sensors.drawn.filter(Boolean)).toHaveLength(20);
    expect(model.sensors.drawn.slice(20)).toEqual([false, false]);
  });

  it("is fetched beside the values, and handed to the page before the values arrive", async () => {
    const requested: string[] = [];
    let releaseValues: () => void = () => {};
    const valuesHeld = new Promise<void>((resolve) => {
      releaseValues = resolve;
    });
    let announced: { thetaDeg: Float64Array; radius: Float64Array } | null = null;
    const building = buildModel(
      view,
      async (file) => {
        requested.push(file.location);
        if (file.location === VALUES) await valuesHeld;
        return source(files)(file);
      },
      {
        checks: localChecks,
        montage,
        onLayout: (places) => {
          announced = places;
        },
      },
    );
    // Let the layout be fetched, hashed and read while the values are still on their way.
    for (let i = 0; i < 20 && !announced; i++) await new Promise((r) => setTimeout(r, 1));
    expect(new Set(requested)).toEqual(new Set([VALUES, LAYOUT]));
    expect(announced).not.toBeNull();
    releaseValues();
    const built = await building;
    const draw = fieldDrawInput({ ...built, model: built.model as SensorFieldModel })!;
    expect([...announced!.thetaDeg]).toEqual([...draw.thetaDeg]);
    expect([...announced!.radius]).toEqual([...draw.radius]);
  });

  it("prepares the geometry the maps' draw finds in the worker's cache", async () => {
    const places = warmInput(view as never, readTsv(encode(layoutText)))!;
    expect(places.thetaDeg).toHaveLength(20);
    const client = new SensorFieldClient(inThreadWorker);
    const layoutKey = view.data[1].sha256;
    const prepared = await client.prepare({ layoutKey, ...places });
    expect(prepared).toMatchObject({ kind: "prepared", cached: false });
    const built = await buildModel(view, source(files), { checks: localChecks, montage });
    const draw = fieldDrawInput({ ...built, model: built.model as SensorFieldModel })!;
    const outcome = await client.draw({
      layoutKey,
      thetaDeg: draw.thetaDeg,
      radius: draw.radius,
      maps: draw.maps,
    });
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.stats.cacheMisses).toBe(0);
    expect(outcome.stats.cacheHits).toBeGreaterThan(0);
  });

  it("selects the rows the draw selects, for every vector placed by a layout", async () => {
    let checked = 0;
    for (const c of models.cases) {
      const m = c.model.model as Partial<SensorFieldModel>;
      if (m.type !== "sensor-field" || m.placement?.source !== "layout" || m.placement.word)
        continue;
      const built = await buildModel(c.view, source(c.files), { checks: localChecks, montage });
      if (built.model.type !== "sensor-field") continue;
      const draw = fieldDrawInput({ ...built, model: built.model });
      const layoutEntry = (c.view as { data: FileDecl[] & { role: string }[] }).data.find(
        (e) => (e as unknown as { role: string }).role === "layout",
      )!;
      const tsv = readTsv((await source(c.files)(layoutEntry))!);
      const places = warmInput(c.view as never, tsv);
      if (!draw) {
        continue;
      }
      expect(places, c.name).not.toBeNull();
      expect([...places!.thetaDeg], c.name).toEqual([...draw.thetaDeg]);
      expect([...places!.radius], c.name).toEqual([...draw.radius]);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("fetches the layout beside the values even when the page asks for no layout", async () => {
    const requested: string[] = [];
    let releaseValues: () => void = () => {};
    const valuesHeld = new Promise<void>((resolve) => {
      releaseValues = resolve;
    });
    const building = buildModel(
      view,
      async (file) => {
        requested.push(file.location);
        if (file.location === VALUES) await valuesHeld;
        return source(files)(file);
      },
      { checks: localChecks, montage },
    );
    for (let i = 0; i < 5 && requested.length < 2; i++) await new Promise((r) => setTimeout(r, 1));
    expect(new Set(requested)).toEqual(new Set([VALUES, LAYOUT]));
    releaseValues();
    expect((await building).model.type).toBe("sensor-field");
  });
});

describe("preloading the first screen ahead of the panel (prepareAhead)", () => {
  const layoutUrl = "https://data.example.invalid/layout.tsv";
  const valuesUrl = "https://data.example.invalid/values.tsv";
  const served: Record<string, Uint8Array> = {
    [layoutUrl]: encode(layoutText),
    [valuesUrl]: encode(valuesText),
  };
  const fetched: string[] = [];
  const fetchBytes = async (url: string) => {
    fetched.push(url);
    return served[url] ?? null;
  };
  const layoutFile = { ...view.data[1], url: layoutUrl };
  const valuesFile = { ...view.data[0], url: valuesUrl };

  it("prepares the geometry and keeps the first windows' files, so the panel only draws", async () => {
    forgetPreloads();
    fetched.length = 0;
    const client = new SensorFieldClient(inThreadWorker);
    const ahead = await prepareAhead(
      { layout: { view: view as never, file: layoutFile }, files: [valuesFile, layoutFile] },
      { client, fetchBytes },
    );
    expect(ahead.layout).toMatchObject({ kind: "prepared", cached: false });
    expect([...ahead.files.values()]).toEqual(["preloaded", "preloaded"]);
    // The panel builds its model from the preloaded bytes, fetching nothing.
    const panelFetches: string[] = [];
    const built = await buildModel(
      view,
      preloadedSource(async (file) => {
        panelFetches.push(file.location);
        return null;
      }),
      { checks: localChecks, montage },
    );
    expect(panelFetches).toEqual([]);
    const draw = fieldDrawInput({ ...built, model: built.model as SensorFieldModel })!;
    const outcome = await client.draw({
      layoutKey: layoutFile.sha256,
      thetaDeg: draw.thetaDeg,
      radius: draw.radius,
      maps: draw.maps,
    });
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.stats.cacheMisses).toBe(0);
    expect(outcome.stats.cacheHits).toBeGreaterThan(0);
    // Each file was fetched once, the layout's twice-named entry included.
    expect(fetched.sort()).toEqual([layoutUrl, valuesUrl].sort());
  });

  it("is idempotent: a second call fetches and prepares nothing again", async () => {
    forgetPreloads();
    fetched.length = 0;
    const client = new SensorFieldClient(inThreadWorker);
    const input = { layout: { view: view as never, file: layoutFile }, files: [valuesFile] };
    const [a, b] = await Promise.all([
      prepareAhead(input, { client, fetchBytes }),
      prepareAhead(input, { client, fetchBytes }),
    ]);
    const c = await prepareAhead(input, { client, fetchBytes });
    client.terminate();
    expect(a.layout).toEqual(b.layout);
    expect(c.layout).toEqual(a.layout);
    expect(fetched.sort()).toEqual([layoutUrl, valuesUrl].sort());
  });

  it("keeps to its byte cap and stops when cancelled", async () => {
    forgetPreloads();
    fetched.length = 0;
    const client = new SensorFieldClient(inThreadWorker);
    const capped = await prepareAhead(
      { files: [layoutFile, valuesFile], maxBytes: layoutFile.size },
      { client, fetchBytes },
    );
    expect(capped.files.get(layoutFile.sha256)).toBe("preloaded");
    expect(capped.files.get(valuesFile.sha256)).toMatchObject({ kind: "skipped" });
    const stop = new AbortController();
    stop.abort();
    const cancelled = await prepareAhead(
      {
        warm: true,
        layout: { view: view as never, file: layoutFile },
        files: [valuesFile],
        signal: stop.signal,
      },
      { client, fetchBytes },
    );
    client.terminate();
    expect(cancelled.warm).toBeNull();
    expect(cancelled.layout).toBeNull();
    expect(cancelled.files.get(valuesFile.sha256)).toMatchObject({ kind: "skipped" });
    expect(fetched).toEqual([layoutUrl]);
  });

  it("prepares nothing for a layout not the one recorded, missing, or unreachable", async () => {
    forgetPreloads();
    const client = new SensorFieldClient(inThreadWorker);
    const wrong = { ...layoutFile, sha256: "0".repeat(64) };
    expect(
      (await prepareAhead({ layout: { view: view as never, file: wrong } }, { client, fetchBytes }))
        .layout,
    ).toMatchObject({ kind: "skipped" });
    const missing = { ...layoutFile, url: "https://x.invalid/none.tsv" };
    expect(
      (
        await prepareAhead(
          { layout: { view: view as never, file: missing } },
          { client, fetchBytes },
        )
      ).layout,
    ).toMatchObject({ kind: "skipped" });
    const offline = await prepareAhead(
      { layout: { view: view as never, file: layoutFile } },
      {
        client,
        fetchBytes: async () => {
          throw new Error("offline");
        },
      },
    );
    expect(offline.layout).toEqual({ kind: "skipped", reason: "offline" });
    // Nothing was prepared: the draw builds the geometry itself.
    const built = await buildModel(view, source(files), { checks: localChecks, montage });
    const draw = fieldDrawInput({ ...built, model: built.model as SensorFieldModel })!;
    const outcome = await client.draw({
      layoutKey: layoutFile.sha256,
      thetaDeg: draw.thetaDeg,
      radius: draw.radius,
      maps: draw.maps,
    });
    client.terminate();
    if (outcome.kind !== "done") throw new Error(outcome.kind);
    expect(outcome.stats.cacheMisses).toBe(1);
  });

  it("is a no-op, and never throws, when the worker cannot start", async () => {
    forgetPreloads();
    const client = new SensorFieldClient(() => {
      throw new Error("no workers");
    });
    const ahead = await prepareAhead(
      { warm: true, layout: { view: view as never, file: layoutFile } },
      { client, fetchBytes },
    );
    expect(ahead.layout?.kind).toBe("unavailable");
  });

  it("skips a data-saving or 2G-class connection", () => {
    expect(shouldPreload({ connection: { saveData: true } })).toBe(false);
    expect(shouldPreload({ connection: { effectiveType: "2g" } })).toBe(false);
    expect(shouldPreload({ connection: { effectiveType: "slow-2g" } })).toBe(false);
    expect(shouldPreload({ connection: { effectiveType: "4g" } })).toBe(true);
    expect(shouldPreload({})).toBe(true);
  });
});

describe("the review's repros (#594, round 2)", () => {
  const layoutUrl = "https://data.example.invalid/layout.tsv";
  const layoutFile = { ...view.data[1], url: layoutUrl };
  const valuesFile = { ...view.data[0], url: "https://data.example.invalid/values.tsv" };

  it("a panel opened while a preload fetch hangs fetches at once and draws, never waiting on it", async () => {
    forgetPreloads();
    let hung = 0;
    // The preload's fetch never answers.
    void prepareAhead(
      { files: [valuesFile, layoutFile] },
      {
        client: new SensorFieldClient(inThreadWorker),
        fetchBytes: () => {
          hung++;
          return new Promise<Uint8Array | null>(() => {});
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hung).toBe(1);
    const built = await Promise.race([
      buildModel(view, preloadedSource(source(files)), { checks: localChecks, montage }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    expect(built).not.toBeNull();
    expect(built!.model.type).toBe("sensor-field");
    forgetPreloads();
  });

  it("a preload's bytes that do not verify lose to the panel's own fetch", async () => {
    forgetPreloads();
    let release: (b: Uint8Array) => void = () => {};
    void prepareAhead(
      { files: [layoutFile] },
      {
        client: new SensorFieldClient(inThreadWorker),
        fetchBytes: () =>
          new Promise<Uint8Array | null>((resolve) => {
            release = resolve;
          }),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reading = preloadedSource(source(files))(layoutFile);
    release(encode("name\n"));
    expect(new TextDecoder().decode((await reading)!)).toBe(layoutText);
    forgetPreloads();
  });

  it("caps a preload at the registry's bytes per role when it names no cap", async () => {
    forgetPreloads();
    let calls = 0;
    const big = { ...valuesFile, size: 4194305 };
    const ahead = await prepareAhead(
      { files: [big] },
      {
        client: new SensorFieldClient(inThreadWorker),
        fetchBytes: async () => {
          calls++;
          return null;
        },
      },
    );
    expect(calls).toBe(0);
    expect(ahead.files.get(big.sha256)).toMatchObject({ kind: "skipped" });
  });

  it("stops reading a response past the declared size", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1000));
        if (pulled > 100) controller.close();
      },
    });
    expect(await readLimited(new Response(body), 2500)).toBeNull();
    expect(pulled).toBeLessThan(10);
    expect(await readLimited(new Response(new Uint8Array(3)), 3)).toEqual(new Uint8Array(3));
    expect(await readLimited(new Response("x", { status: 404 }))).toBeNull();
  });

  it("leaves no unhandled rejection when a prefetched layout fails and the model never reads it", async () => {
    const process = await nodeProcess();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    const refusal = await buildModel(
      view,
      async (file) => {
        if (file.location === LAYOUT) throw new Error("layout fetch failed");
        return null; // the values are missing: the view is refused before the layout is read
      },
      { checks: localChecks, montage },
    ).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off("unhandledRejection", listener);
    expect((refusal as { word?: string }).word).toBe("file_missing");
    expect(unhandled).toEqual([]);
  });

  it("reads the layout's places with the model's cell reader", () => {
    const withCell = (cell: string) =>
      warmInput(
        view as never,
        readTsv(encode(layoutText.replace(`\t${rows[0].theta}\t`, `\t${cell}\t`))),
      );
    expect(withCell("")).toBeNull();
    expect(withCell("0x10")).toBeNull();
    expect(withCell("1e400")).toBeNull();
    const zero = withCell("-0")!;
    expect(Object.is(zero.thetaDeg[0], 0)).toBe(true);
  });
});
