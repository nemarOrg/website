/**
 * Zarrita reader spike (epic nemarOrg/nemar-cli#684, website#99).
 *
 * Confirms zarrita reads a real NEMAR biosigIO Zarr v3 store end-to-end before
 * the viewer is built on top of it: index.json manifest, store root/group attrs,
 * a NON-sharded `view/L` envelope read (the hot render path) and the SHARDED +
 * zstd `level-0` read (max-zoom / filtering). Run with bun (no CORS in a script;
 * CORS is verified separately with curl + an Origin header):
 *
 *   bun run scripts/zarr-spike.ts [base] [datasetId] [storeRelPath]
 *   bun run scripts/zarr-spike.ts https://zarr.nemar.org nm000132 \
 *       sub-001/eeg/sub-001_task-MMN_eeg.zarr
 */
import * as zarr from "zarrita";

declare const process: {
  argv: string[];
  exit(code?: number): never;
};

const base = (process.argv[2] ?? "https://zarr.nemar.org").replace(/\/$/, "");
const id = process.argv[3] ?? "nm000132";
const storeRel = process.argv[4] ?? "";

function log(label: string, value: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(value);
}

const indexUrl = `${base}/${id}/zarr/index.json`;
const idxRes = await fetch(indexUrl);
log("index.json", `${indexUrl} -> HTTP ${idxRes.status}`);
let index: {
  format?: string;
  source_commit?: string;
  stores?: Array<{ path: string; zarr: string; modalities?: string[]; groups?: unknown[] }>;
} = {};
if (idxRes.ok) {
  index = await idxRes.json();
  log("index summary", {
    format: index.format,
    source_commit: index.source_commit?.slice(0, 8),
    store_count: index.stores?.length,
    first: index.stores?.[0],
  });
} else if (!storeRel) {
  console.error("index.json not reachable and no explicit storeRelPath given; aborting.");
  process.exit(1);
} else {
  console.log("(index.json not yet written; using the explicit store path)");
}

const rel = storeRel || index.stores?.[0]?.zarr;
if (!rel) {
  console.error("no store to open");
  process.exit(1);
}
const storeUrl = `${base}/${id}/zarr/${rel}/`;
log("opening store", storeUrl);

const store = new zarr.FetchStore(storeUrl);
const rootGroup = await zarr.open(store, { kind: "group" });
log("root attrs", rootGroup.attrs);

const groupNames =
  (rootGroup.attrs.channel_groups as string[] | undefined) ??
  (index.stores?.[0]?.groups as Array<{ name: string }> | undefined)?.map((g) => g.name) ??
  [];
log("channel groups", groupNames);
const groupName = groupNames[0];
if (!groupName) {
  console.error("no channel group found in root attrs");
  process.exit(1);
}

const grp = await zarr.open(rootGroup.resolve(groupName), { kind: "group" });
const channels = grp.attrs.channels as Array<Record<string, unknown>> | undefined;
log(`group ${groupName} attrs`, {
  rate: grp.attrs.rate,
  original_rate: grp.attrs.original_rate,
  n_channels: grp.attrs.n_channels,
  n_samples: grp.attrs.n_samples,
  channel0: channels?.[0],
});

// NON-sharded view level (the hot render path).
try {
  const view1 = await zarr.open(rootGroup.resolve(`${groupName}/view/1`), { kind: "array" });
  log("view/1 array", { shape: view1.shape, dtype: view1.dtype, chunks: view1.chunks });
  const region = await zarr.get(view1, [null, null, zarr.slice(0, 64)]);
  log("view/1 read [.,.,0:64]", {
    shape: region.shape,
    sample: Array.from(region.data as ArrayLike<number>).slice(0, 6),
  });
} catch (err) {
  console.error("view/1 read FAILED:", err);
}

// Sharded + zstd level-0 (the gating spike).
try {
  const level0 = await zarr.open(rootGroup.resolve(`${groupName}/0`), { kind: "array" });
  log("level-0 array (sharded+zstd)", {
    shape: level0.shape,
    dtype: level0.dtype,
    chunks: level0.chunks,
  });
  const region = await zarr.get(level0, [zarr.slice(0, 4), zarr.slice(0, 250)]);
  log("level-0 read [0:4,0:250]", {
    shape: region.shape,
    sample: Array.from(region.data as ArrayLike<number>).slice(0, 6),
  });
  console.log("\n*** SHARDING + ZSTD: zarrita reads level-0 OK ***");
} catch (err) {
  console.error("level-0 read FAILED (sharding/zstd gap?):", err);
}

// Events group.
try {
  const onset = await zarr.open(rootGroup.resolve("events/onset"), { kind: "array" });
  const ev = await zarr.get(onset, null);
  log("events/onset", {
    shape: ev.shape,
    first: Array.from(ev.data as ArrayLike<number>).slice(0, 5),
  });
} catch {
  console.log("\n=== events ===\n(no events group on this store)");
}

console.log("\nspike complete.");
