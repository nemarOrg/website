/**
 * The survey behind `.context/research-ieeg-channel-names.md` (card IS-J1), rerunnable.
 *
 *   bun scripts/ieeg-channel-survey.ts [--list <file>]   re-derive the note's counts from live data
 *   bun scripts/ieeg-channel-survey.ts --sample <file>   draw the recordings afresh and write the list
 *
 * The list (default `.context/research-ieeg-channel-names-recordings.json`) names the dataset
 * version and the recordings the note's counts were taken over. A run reads, per recording, the
 * channel labels of every channel group of its Zarr store, the contacts of the first shown space
 * (`resolveRecordingGeometry`) and the recording's own `_channels.tsv`, joins them with the viewer's
 * `joinChannels`, and prints one row per pattern. Public GET requests only, through the census
 * script's polite client. The data plane answers 500 now and then and the client retries.
 *
 * Two counts per row, because they differ: "channels" is name-resolved, with every contact given a
 * position of its own so a contact the file leaves at `n/a` still counts (the join is about names);
 * "located" is the same channels with the positions the file gives (what the panel draws). The last
 * two columns are the corroboration: of the non-exact joins, how many have the `_channels.tsv` row
 * at the same index as the Zarr row naming the contact (a pair: both contacts joined by a hyphen),
 * and how many have the contact (a pair: both contacts) somewhere in that file. A second table
 * gives the same by dataset. The check is silent where the dataset's own `_channels.tsv` repeats the
 * store's label, lists monopolar contacts for a bipolar store, or is absent.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { MATCH_RULES, type MatchRule } from "../src/lib/ieeg-spatial/channel-match";
import {
  type SpaceGeometry,
  joinChannels,
  resolveRecordingGeometry,
} from "../src/lib/ieeg-spatial/geometry";
import { storeRelPath } from "../src/lib/zarr-base";
import { DatasetCache, Net, readerFor } from "./ieeg-geometry-census";

const LIST = ".context/research-ieeg-channel-names-recordings.json";
const CENSUS = ".context/research-ieeg-geometry-census.md";
const ZARR = "https://zarr.nemar.org";
type List = Record<string, { version: string; recordings: string[] }>;

/** A doubled shaft letter, as a rule only to count the pattern the viewer does NOT join (row P6). */
const DOUBLED: MatchRule = {
  id: "doubled",
  kind: "close",
  form: "variants",
  pattern: "",
  example: { channel: "", contact: "" },
  datasets: [],
  sentence: "",
  variants: (n) =>
    [...n].flatMap((c, i) => (c === n[i + 1] ? [n.slice(0, i) + n.slice(i + 1)] : [])),
};
const SIGNAL =
  /^(ECG|EKG|EMG|EOG|DC\d*|TRIG|STIM|MKR|PULS|SpO2|BP|E$|Event|ORB|AH|thor|abdo|emg|ecg|ah|Pleth|OSAT|PR$|MAP|SBP|Trap|OrOr|DigitalInput|MOV_|unnamed|NC$|POL (E|ECG|EKG|DC)|state_)/i;
const SCALP =
  /^(s?F|s?C|s?T|s?P|s?O|s?Fp|s?CZ|s?Cz|s?FZ|s?Fz|s?PZ|s?Pz|s?A[12]$|E[12]$)(\d|Z|z)*(-Ref\d?)?'?$/;
/** Pending patterns, told apart by the dataset and the label (the rows P1 to P9 of the note). */
const PENDING: [string, (id: string, label: string) => boolean][] = [
  ["P3 case only", (id, l) => id === "on004624" && /^CH\d+$/.test(l)],
  ["P2 position-numbered", (id) => id === "nm000377"],
  ["P7 whole lead", (id) => id === "nm000436"],
  ["P1 derived copy", (id, l) => id === "nm000463" && l.endsWith("_rms")],
  ["P8 polarity marker", (_, l) => l.startsWith("POL $")],
  ["P9 repeat counter", (id, l) => id === "nm000373" && /^[A-Za-z]+\d*-\d$/.test(l)],
  ["P4 bare index", (id, l) => id !== "nm000373" && /^\d+$/.test(l)],
  ["P5 prime for side", (id, l) => id === "on005670" && l.includes("'")],
];

const parseNames = (tsv: string | null): string[] =>
  tsv === null
    ? []
    : tsv
        .replace(/^﻿/, "")
        .split(/\r?\n/)
        .slice(1)
        .filter((l) => l.trim() !== "")
        .map((l) => l.split("\t")[0].trim());

/** Zarr channel labels (and types) of every group of a recording's store, in array-row order. */
async function storeLabels(net: Net, id: string, recording: string) {
  const base = `${ZARR}/${id}/zarr/${storeRelPath(recording)}/`;
  const root = await net.get(`${base}zarr.json`);
  if (root.kind !== "ok") return [];
  const groups = (JSON.parse(root.body).attributes?.channel_groups ?? []) as string[];
  const out: { group: string; labels: string[]; types: string[] }[] = [];
  for (const group of groups) {
    const r = await net.get(`${base}${group}/zarr.json`);
    if (r.kind !== "ok") continue;
    const chans = (JSON.parse(r.body).attributes?.channels ?? []) as {
      label: string;
      channel_type: string;
      row_index: number;
    }[];
    chans.sort((a, b) => a.row_index - b.row_index);
    out.push({ group, labels: chans.map((c) => c.label), types: chans.map((c) => c.channel_type) });
  }
  return out;
}

/** Draw up to six recordings per usable dataset: first, middle, last, one per group set and `acq`. */
async function sample(net: Net): Promise<List> {
  const rows = [
    ...readFileSync(CENSUS, "utf8").matchAll(
      /^\| ((?:nm|on)\d{6}) \| (v\S+) \| \d+ \| \d+ \| (\d+) \| (\d+) \|/gm,
    ),
  ];
  const list: List = {};
  for (const [, id, version, template, native] of rows) {
    if (Number(template) + Number(native) === 0) continue;
    const idx = await net.get(`${ZARR}/${id}/zarr/index.json`);
    if (idx.kind !== "ok") continue;
    const stores = (JSON.parse(idx.body).stores ?? []) as {
      path: string;
      groups?: { name?: string }[];
    }[];
    const picked = new Map<string, string>();
    const add = (s?: { path: string }) => s && picked.size < 6 && picked.set(s.path, s.path);
    add(stores[0]);
    add(stores[Math.floor(stores.length / 2)]);
    add(stores.at(-1));
    const seen = new Set<string>();
    for (const s of stores) {
      const key = `${(s.groups ?? []).map((g) => g.name).join("+")}|${/_acq-([^_]+)/.exec(s.path)?.[1] ?? ""}`;
      if (!seen.has(key)) add(s);
      seen.add(key);
    }
    list[id] = { version, recordings: [...picked.keys()] };
  }
  return list;
}

interface Row {
  channels: number;
  located: number;
  recordings: Set<string>;
  datasets: Set<string>;
  joins: number;
  aligned: number;
  present: number;
}

async function derive(net: Net, list: List) {
  const rows = new Map<string, Row>();
  /** Corroboration by rule row and dataset: non-exact joins, row-aligned, present. */
  const byDataset = new Map<string, { joins: number; aligned: number; present: number }>();
  /** Every label and every contact name read, and how many hold a character outside printable ASCII. */
  const names = { read: 0, nonAscii: 0 };
  const row = (key: string): Row => {
    const found = rows.get(key);
    if (found) return found;
    const fresh: Row = {
      channels: 0,
      located: 0,
      recordings: new Set(),
      datasets: new Set(),
      joins: 0,
      aligned: 0,
      present: 0,
    };
    rows.set(key, fresh);
    return fresh;
  };
  for (const [id, { version, recordings }] of Object.entries(list)) {
    const cache = new DatasetCache();
    for (const recording of recordings) {
      const rd = readerFor(net, cache, id, version);
      const g = await resolveRecordingGeometry({
        datasetId: id,
        version,
        recording,
        listDir: rd.listDir,
        readText: rd.readText,
      });
      const space = g.spaces.find((s) => s.reason === null);
      if (!space) continue;
      const dir = recording.slice(0, recording.lastIndexOf("/"));
      const stem = recording.slice(recording.lastIndexOf("/") + 1).replace(/_ieeg\..*$/, "");
      const tsv = parseNames(await rd.readText(`${dir}/${stem}_channels.tsv`));
      const neutral: SpaceGeometry = {
        ...space,
        contacts: space.contacts.map((c) => ({ ...c, position: [0, 0, 0] })),
      };
      for (const { labels, types } of await storeLabels(net, id, recording)) {
        for (const name of [...labels, ...space.contacts.map((c) => c.name)]) {
          names.read += 1;
          if (/[^\x20-\x7e]/.test(name)) names.nonAscii += 1;
        }
        const real = joinChannels(space, labels);
        const named = joinChannels(neutral, labels);
        const doubled = joinChannels(neutral, labels, [...MATCH_RULES, DOUBLED]);
        named.forEach((j, i) => {
          const label = labels[i];
          let key: string;
          if (j.matchKind === "exact")
            key = j.status === "bipolar" ? "S2 exact bipolar pair" : "S1 exact name";
          else if (j.matchKind)
            key = `rule ${j.matchKind}:${j.rule}${j.status === "bipolar" ? " (bipolar)" : ""}`;
          else
            key =
              PENDING.find(([, test]) => test(id, label))?.[0] ??
              (doubled[i].matchKind === "close"
                ? "P6 doubled letter"
                : SIGNAL.test(label) || /^(ECG|EOG|EMG|TRIG|MISC|RESP|STIM)/i.test(types[i] ?? "")
                  ? "N1 a signal that is not a contact"
                  : SCALP.test(label)
                    ? "N2 a scalp EEG lead"
                    : "N3 no row for this contact in the electrodes file");
          const r = row(key);
          r.channels += 1;
          if (real[i].status !== "unlocated") r.located += 1;
          r.recordings.add(`${id}/${recording}`);
          r.datasets.add(id);
          if (j.matchKind && j.matchKind !== "exact") {
            const aligned = tsv[i] === j.contacts.join("-");
            const present = j.contacts.every((c) => tsv.includes(c));
            const d = byDataset.get(`${key} | ${id}`) ?? { joins: 0, aligned: 0, present: 0 };
            d.joins += 1;
            d.aligned += aligned ? 1 : 0;
            d.present += present ? 1 : 0;
            byDataset.set(`${key} | ${id}`, d);
            r.joins += 1;
            r.aligned += aligned ? 1 : 0;
            r.present += present ? 1 : 0;
          }
        });
      }
    }
  }
  return { rows, byDataset, names };
}

async function main() {
  const args = process.argv.slice(2);
  const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
  const net = new Net();
  const out = at("--sample");
  if (out) {
    const list = await sample(net);
    writeFileSync(out, `${JSON.stringify(list, null, 1)}\n`);
    console.log(
      `${Object.keys(list).length} datasets, ${Object.values(list).reduce((n, d) => n + d.recordings.length, 0)} recordings written to ${out}`,
    );
    return;
  }
  const list = JSON.parse(readFileSync(at("--list") ?? LIST, "utf8")) as List;
  const { rows, byDataset, names } = await derive(net, list);
  console.log(
    "| Row | Channels (name-resolved) | Located | Recordings | Datasets | tsv row-aligned | tsv has the name |",
  );
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  let total = 0;
  for (const [key, r] of [...rows].sort((a, b) => b[1].channels - a[1].channels)) {
    total += r.channels;
    const tsv = r.joins > 0 ? `${r.aligned} of ${r.joins}` : "";
    const has = r.joins > 0 ? `${r.present} of ${r.joins}` : "";
    console.log(
      `| ${key} | ${r.channels} | ${r.located} | ${r.recordings.size} | ${r.datasets.size} | ${tsv} | ${has} |`,
    );
  }
  console.log("\n| Rule row and dataset | Joins | tsv row-aligned | tsv has the name |");
  console.log("| --- | --- | --- | --- |");
  for (const [key, d] of [...byDataset].sort()) {
    console.log(`| ${key} | ${d.joins} | ${d.aligned} | ${d.present} |`);
  }
  console.log(`\nNames read: ${names.read}, outside printable ASCII: ${names.nonAscii}`);
  console.log(
    `${total} channels; requests ${net.stats.requests}, retries ${net.stats.retries}, exhausted ${net.stats.exhausted}`,
  );
}

if ((import.meta as { main?: boolean }).main) await main();
