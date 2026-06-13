import { describe, expect, it } from "vitest";
import { aggregateHostedStats, isHostedDataset } from "./stats";
import type { Dataset } from "./types";

/**
 * Real-shape catalog rows (fields and values mirror api.nemar.org/datasets).
 * `row()` fills the columns the aggregator never reads so each case stays
 * readable; the values under test (`id`, `source_type`, `participants`,
 * `file_size`) are spelled out per row.
 */
function row(over: Partial<Dataset>): Dataset {
  return {
    dataset_id: over.id ?? "nm000000",
    id: over.id ?? "nm000000",
    name: "Sample dataset",
    description: null,
    status: "active",
    visibility: "public",
    github_repo: null,
    concept_doi: null,
    doi: null,
    created_at: "",
    updated_at: "",
    owner_username: null,
    nemar_sync_status: null,
    source: null,
    source_type: null,
    source_id: null,
    modalities: "EEG",
    participants: 0,
    tasks: "",
    authors: "",
    file_size: 0,
    file_size_formatted: "",
    latest_version: null,
    ...over,
  };
}

const GB = 1024 ** 3;

describe("isHostedDataset", () => {
  it("counts managed nm* and on* rows as hosted", () => {
    expect(isHostedDataset(row({ id: "nm000103", source_type: "managed" }))).toBe(true);
    expect(isHostedDataset(row({ id: "on004398", source_type: "managed" }))).toBe(true);
  });
  it("excludes catalog ds* rows", () => {
    expect(isHostedDataset(row({ id: "ds007955", source_type: "catalog" }))).toBe(false);
  });
  it("falls back to id prefix when source_type is missing", () => {
    expect(isHostedDataset(row({ id: "nm000104", source_type: null }))).toBe(true);
    expect(isHostedDataset(row({ id: "ds002718", source_type: null }))).toBe(false);
  });
});

describe("aggregateHostedStats", () => {
  it("sums only the hosted (managed) rows", () => {
    const rows = [
      row({ id: "nm000103", source_type: "managed", participants: 1000, file_size: 10 * GB }),
      row({ id: "on004398", source_type: "managed", participants: 273, file_size: 5 * GB }),
      // ds* rows are catalog-only — their bytes live on OpenNeuro, not NEMAR.
      row({ id: "ds007955", source_type: "catalog", participants: 9999, file_size: 900 * GB }),
    ];
    const stats = aggregateHostedStats(rows);
    expect(stats.datasets).toBe(2);
    expect(stats.participants).toBe(1273);
    expect(stats.size).toBe(15 * GB);
  });

  it("tolerates null participants / file_size on sparse hosted rows", () => {
    const rows = [
      row({ id: "on005262", source_type: "managed", participants: 0, file_size: 0 }),
      row({
        id: "nm000105",
        source_type: "managed",
        participants: undefined as unknown as number,
        file_size: undefined as unknown as number,
      }),
    ];
    const stats = aggregateHostedStats(rows);
    expect(stats.datasets).toBe(2);
    expect(stats.participants).toBe(0);
    expect(stats.size).toBe(0);
  });

  it("returns zeros for an empty catalog page", () => {
    expect(aggregateHostedStats([])).toEqual({ datasets: 0, participants: 0, size: 0 });
  });
});
