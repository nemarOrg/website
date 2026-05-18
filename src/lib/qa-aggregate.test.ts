import { afterEach, describe, expect, it, vi } from "vitest";
import { buildQaAggregates } from "./qa-aggregate";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
}

function makeRouter(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes[url] ?? routes[url.replace(/\/$/, "")];
    return route ? route() : notFound();
  }) as unknown as typeof fetch;
}

describe("buildQaAggregates", () => {
  it("returns null when the qa root listing 404s", async () => {
    globalThis.fetch = makeRouter({}) as typeof fetch;
    expect(await buildQaAggregates("on999999")).toBeNull();
  });

  it("returns null when the qa tree has no per-file dataqual files", async () => {
    globalThis.fetch = makeRouter({
      "https://data.nemar.org/on999999/qa": () =>
        jsonResponse({
          dataset_id: "on999999",
          path: "",
          kind: "directory",
          children: [{ kind: "file", name: "dataqual.json" }],
        }),
    }) as typeof fetch;
    expect(await buildQaAggregates("on999999")).toBeNull();
  });

  it("aggregates per-file dataqual into QaAggregates arrays", async () => {
    const id = "on002718";
    const subjectListing = (subject: string) => ({
      dataset_id: id,
      path: subject,
      kind: "directory" as const,
      children: [{ kind: "dir" as const, name: "eeg" }],
    });
    const eegListing = (subject: string) => ({
      dataset_id: id,
      path: `${subject}/eeg`,
      kind: "directory" as const,
      children: [
        { kind: "file" as const, name: `${subject}_task-X_eeg_dataqual.json` },
        { kind: "file" as const, name: `${subject}_task-X_eeg_spectopo.svg` },
      ],
    });
    globalThis.fetch = makeRouter({
      [`https://data.nemar.org/${id}/qa`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "",
          kind: "directory",
          children: [
            { kind: "dir", name: "sub-002" },
            { kind: "dir", name: "sub-003" },
            { kind: "file", name: "dataqual.json" },
          ],
        }),
      [`https://data.nemar.org/${id}/qa/sub-002`]: () => jsonResponse(subjectListing("sub-002")),
      [`https://data.nemar.org/${id}/qa/sub-003`]: () => jsonResponse(subjectListing("sub-003")),
      [`https://data.nemar.org/${id}/qa/sub-002/eeg`]: () => jsonResponse(eegListing("sub-002")),
      [`https://data.nemar.org/${id}/qa/sub-003/eeg`]: () => jsonResponse(eegListing("sub-003")),
      [`https://data.nemar.org/${id}/qa/sub-002/eeg/sub-002_task-X_eeg_dataqual.json`]: () =>
        jsonResponse({
          goodDataPercentRaw: "81",
          goodChansPercentRaw: "87",
          goodICAPercentRaw: "90",
          linenoise_magn: "14.40dB",
          icaFail: 0,
        }),
      [`https://data.nemar.org/${id}/qa/sub-003/eeg/sub-003_task-X_eeg_dataqual.json`]: () =>
        jsonResponse({
          goodDataPercentRaw: "78",
          goodChansPercentRaw: "92",
          goodICAPercentRaw: "85",
          linenoise_magn: "13.20dB",
          icaFail: 0,
        }),
    }) as typeof fetch;

    const result = await buildQaAggregates(id);
    expect(result).not.toBeNull();
    expect(result?.files).toBe(2);
    expect(result?.goodDataPercent.sort()).toEqual([78, 81]);
    expect(result?.goodChansPercent.sort()).toEqual([87, 92]);
    expect(result?.goodICAPercent.sort()).toEqual([85, 90]);
    expect(result?.linenoiseDb.sort()).toEqual([13.2, 14.4]);
    expect(result?.pipelineStatus.finished).toBe(2);
    expect(result?.pipelineStatus.failed).toBe(0);
  });

  it("counts icaFail>0 entries as failed in pipelineStatus", async () => {
    const id = "on000001";
    globalThis.fetch = makeRouter({
      [`https://data.nemar.org/${id}/qa`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "",
          kind: "directory",
          children: [{ kind: "dir", name: "sub-01" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "sub-01",
          kind: "directory",
          children: [{ kind: "dir", name: "eeg" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/eeg`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "sub-01/eeg",
          kind: "directory",
          children: [{ kind: "file", name: "sub-01_task-X_eeg_dataqual.json" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/eeg/sub-01_task-X_eeg_dataqual.json`]: () =>
        jsonResponse({
          goodDataPercentRaw: "55",
          goodChansPercentRaw: "60",
          goodICAPercentRaw: "70",
          icaFail: 3,
        }),
    }) as typeof fetch;

    const result = await buildQaAggregates(id);
    expect(result?.pipelineStatus.failed).toBe(1);
    expect(result?.pipelineStatus.finished).toBe(0);
  });
});
