import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildQaAggregates } from "./qa-aggregate";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

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

// Mock router that requires an EXACT URL match. Production servers behave
// the same way (the bare `<id>/qa` form 308-redirects to a broken path),
// so tests verify the code actually appends the trailing slash to listings.
function makeRouter(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const route = routes[url];
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
      "https://data.nemar.org/on999999/qa/": () =>
        jsonResponse({
          dataset_id: "on999999",
          path: "",
          kind: "directory",
          children: [{ kind: "file", name: "dataqual.json" }],
        }),
    }) as typeof fetch;
    expect(await buildQaAggregates("on999999")).toBeNull();
  });

  it("requires the listing URL to end in '/' (matches production 308 behavior)", async () => {
    // Only register the trailing-slash form. If the implementation ever
    // dropped its trailing-slash append, this test would catch the
    // production-only regression (bare path 308-redirects to a broken
    // /data/ prefix that returns 404).
    const id = "on002718";
    globalThis.fetch = makeRouter({
      [`https://data.nemar.org/${id}/qa/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "",
          kind: "directory",
          children: [{ kind: "file", name: "dataqual.json" }],
        }),
    }) as typeof fetch;
    expect(await buildQaAggregates(id)).toBeNull();
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
      [`https://data.nemar.org/${id}/qa/`]: () =>
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
      [`https://data.nemar.org/${id}/qa/sub-002/`]: () => jsonResponse(subjectListing("sub-002")),
      [`https://data.nemar.org/${id}/qa/sub-003/`]: () => jsonResponse(subjectListing("sub-003")),
      [`https://data.nemar.org/${id}/qa/sub-002/eeg/`]: () => jsonResponse(eegListing("sub-002")),
      [`https://data.nemar.org/${id}/qa/sub-003/eeg/`]: () => jsonResponse(eegListing("sub-003")),
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

  it("descends three+ levels for session-structured BIDS (sub/ses/modality)", async () => {
    const id = "on003190";
    globalThis.fetch = makeRouter({
      [`https://data.nemar.org/${id}/qa/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "",
          kind: "directory",
          children: [{ kind: "dir", name: "sub-01" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "sub-01",
          kind: "directory",
          children: [{ kind: "dir", name: "ses-01" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/ses-01/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "sub-01/ses-01",
          kind: "directory",
          children: [{ kind: "dir", name: "eeg" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/ses-01/eeg/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "sub-01/ses-01/eeg",
          kind: "directory",
          children: [{ kind: "file", name: "sub-01_ses-01_task-X_eeg_dataqual.json" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/ses-01/eeg/sub-01_ses-01_task-X_eeg_dataqual.json`]:
        () =>
          jsonResponse({
            goodDataPercentRaw: "70",
            goodChansPercentRaw: "80",
            goodICAPercentRaw: "85",
            linenoise_magn: "10.0dB",
            icaFail: 0,
          }),
    }) as typeof fetch;

    const result = await buildQaAggregates(id);
    expect(result?.files).toBe(1);
    expect(result?.goodDataPercent).toEqual([70]);
  });

  it("still aggregates the successful subjects when one subject listing 404s", async () => {
    const id = "on000002";
    const goodSubjectListing = {
      dataset_id: id,
      path: "sub-01/eeg",
      kind: "directory" as const,
      children: [{ kind: "file" as const, name: "sub-01_task-X_eeg_dataqual.json" }],
    };
    globalThis.fetch = makeRouter({
      [`https://data.nemar.org/${id}/qa/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "",
          kind: "directory",
          children: [
            { kind: "dir", name: "sub-01" },
            { kind: "dir", name: "sub-02" }, // intentionally unregistered -> 404
          ],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "sub-01",
          kind: "directory",
          children: [{ kind: "dir", name: "eeg" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/eeg/`]: () => jsonResponse(goodSubjectListing),
      [`https://data.nemar.org/${id}/qa/sub-01/eeg/sub-01_task-X_eeg_dataqual.json`]: () =>
        jsonResponse({
          goodDataPercentRaw: "88",
          goodChansPercentRaw: "90",
          goodICAPercentRaw: "92",
          linenoise_magn: "8.0dB",
          icaFail: 0,
        }),
    }) as typeof fetch;

    const result = await buildQaAggregates(id);
    expect(result?.files).toBe(1);
    expect(result?.goodDataPercent).toEqual([88]);
  });

  it("counts icaFail>0 entries as failed in pipelineStatus", async () => {
    const id = "on000001";
    globalThis.fetch = makeRouter({
      [`https://data.nemar.org/${id}/qa/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "",
          kind: "directory",
          children: [{ kind: "dir", name: "sub-01" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "sub-01",
          kind: "directory",
          children: [{ kind: "dir", name: "eeg" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/eeg/`]: () =>
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

  it("classifies a file with only line-noise (no percent fields) as 'other'", async () => {
    const id = "on000003";
    globalThis.fetch = makeRouter({
      [`https://data.nemar.org/${id}/qa/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "",
          kind: "directory",
          children: [{ kind: "dir", name: "sub-01" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "sub-01",
          kind: "directory",
          children: [{ kind: "dir", name: "eeg" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/eeg/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "sub-01/eeg",
          kind: "directory",
          children: [{ kind: "file", name: "sub-01_task-X_eeg_dataqual.json" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/eeg/sub-01_task-X_eeg_dataqual.json`]: () =>
        jsonResponse({ linenoise_magn: "12.0dB", icaFail: 0 }),
    }) as typeof fetch;

    const result = await buildQaAggregates(id);
    expect(result?.pipelineStatus.other).toBe(1);
    expect(result?.pipelineStatus.finished).toBe(0);
    expect(result?.linenoiseDb).toEqual([12]);
  });

  it("classifies a file missing only the ICA percent as 'cleaning'", async () => {
    const id = "on000004";
    globalThis.fetch = makeRouter({
      [`https://data.nemar.org/${id}/qa/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "",
          kind: "directory",
          children: [{ kind: "dir", name: "sub-01" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "sub-01",
          kind: "directory",
          children: [{ kind: "dir", name: "eeg" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/eeg/`]: () =>
        jsonResponse({
          dataset_id: id,
          path: "sub-01/eeg",
          kind: "directory",
          children: [{ kind: "file", name: "sub-01_task-X_eeg_dataqual.json" }],
        }),
      [`https://data.nemar.org/${id}/qa/sub-01/eeg/sub-01_task-X_eeg_dataqual.json`]: () =>
        jsonResponse({
          goodDataPercentRaw: "80",
          goodChansPercentRaw: "85",
          icaFail: 0,
        }),
    }) as typeof fetch;

    const result = await buildQaAggregates(id);
    expect(result?.pipelineStatus.cleaning).toBe(1);
    expect(result?.pipelineStatus.finished).toBe(0);
  });
});
