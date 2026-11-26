/**
 * `nemar.sensor-labels.v1`: sensor positions inferred from channel names (neuroschema 0.6.0
 * `docs/views/sensor-labels.md`, with `src/neuroschema/views/sensor_labels.py` as the reference;
 * nemar-cli ADR 0137 decision 3 and its amendment of 2026-11-24; website ADR 0035 decision 5).
 *
 * Given a recording's channels (name and BIDS type, in recording order) and, optionally, its
 * sidecar's cap model and reference, the names are normalized, matched against the fourteen
 * montages names can reach, and either placed on the one montage they identify or refused with a
 * reason. Nothing is ever placed on a default: when no montage is a confident match, the reason is
 * shown instead of a map (`sensor-labels-copy.ts` holds its sentence).
 *
 * Pure and worker-safe: no DOM, no fetch, no import of a montage file. The caller loads the montages
 * (`loadNameMontages`), so a page pays for them only when a map is placed by name.
 * `test/quality-views-sensor-labels.test.ts` replays every case of `views/vectors/sensor-labels.v1.json`.
 *
 * Normalization, the exclusions and the fiducials are `sensor-names.ts`, which
 * `nemar.sensor-layout.v1` reads too; this module adds the hyphen split, the aliases, the matching
 * and the choice.
 */

import { type Montage, MontageFileInvalid } from "./montages";
import type { Vec3 } from "./sensor-layout";
import { FIDUCIALS, asciiLower, clean, excludedByName, finish, typeClass } from "./sensor-names";

export const ALGORITHM = "nemar.sensor-labels.v1";

/** The montages names reach, in the order that breaks a tie between equal match counts. */
export const NAME_MONTAGES: readonly string[] = [
  "standard_1005",
  "GSN-HydroCel-32",
  "GSN-HydroCel-64_1.0",
  "GSN-HydroCel-65_1.0",
  "GSN-HydroCel-128",
  "GSN-HydroCel-129",
  "GSN-HydroCel-256",
  "GSN-HydroCel-257",
  "biosemi16",
  "biosemi32",
  "biosemi64",
  "biosemi128",
  "biosemi160",
  "biosemi256",
];

/** EEGLAB's files of EGI's nets from before the HydroCel nets: never matched by name, even when a
 *  caller passes them. A sensor role may still store template positions from them. */
export const TEMPLATE_ONLY_MONTAGES: readonly string[] = [
  "GSN64v2_0",
  "GSN65v2_0",
  "GSN128",
  "GSN129",
  "GSN256",
  "GSN257",
];

/** A right part (after the last hyphen) that names a reference, not an electrode. */
export const REFERENCES: ReadonlySet<string> = new Set([
  "ref",
  "reference",
  "avg",
  "ar",
  "car",
  "le",
  "re",
  "lm",
  "rm",
  "linked",
  "a1",
  "a2",
  "a12",
  "m1",
  "m2",
  "m12",
]);

/** Aliases of a family, applied only to that family's montages. A new alias is a new version. */
export const FAMILY_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // The American Clinical Neurophysiology Society (ACNS) renamed these.
  "10-05": { t3: "t7", t4: "t8", t5: "p7", t6: "p8" },
  // EGI's vertex reference electrode.
  "GSN-HydroCel": { vref: "cz" },
};

/** Aliases of one montage: an EGI net's vertex reference named by the number after its last
 *  electrode, which is an electrode of its own on a larger net. */
export const MONTAGE_ALIASES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "GSN-HydroCel-32": { e33: "cz" },
  "GSN-HydroCel-65_1.0": { e65: "cz" },
  "GSN-HydroCel-129": { e129: "cz" },
  "GSN-HydroCel-257": { e257: "cz" },
};

export const MIN_CHANNELS = 8;
export const MIN_MATCHED = 8;
/** Shares are integer ratios, compared by cross-multiplying, so a boundary is decided alike. */
export const MIN_SHARE: readonly [number, number] = [4, 5];
export const CONTENDER_SHARE: readonly [number, number] = [9, 10];
export const COMMON_REFERENCE_SHARE: readonly [number, number] = [9, 10];
export const COINCIDENT_M = 1e-9;
/** A chosen montage of these families must match at least 90% of its electrodes. */
export const NET_FAMILIES: readonly string[] = ["GSN-HydroCel", "GSN", "BioSemi"];
export const NET_COVERAGE: readonly [number, number] = [9, 10];
/** EGI's families: a placement on one needs the cap model to name the net. */
export const EGI_FAMILIES: readonly string[] = ["GSN-HydroCel", "GSN"];
/** The families whose electrode a recording's EEGReference may name. */
export const REFERENCE_FAMILIES: readonly string[] = ["10-05", "GSN-HydroCel"];

const HYDROCEL_NETS: Readonly<Record<string, readonly string[]>> = {
  "32": ["GSN-HydroCel-32"],
  "64": ["GSN-HydroCel-64_1.0", "GSN-HydroCel-65_1.0"],
  "128": ["GSN-HydroCel-128", "GSN-HydroCel-129"],
  "256": ["GSN-HydroCel-256", "GSN-HydroCel-257"],
};
const EVERY_HYDROCEL_NET = Object.values(HYDROCEL_NETS).flat();

/** Each cap model, folded by `foldCapModel`, and the nets it names. Any other string names none. */
export const CAP_MODELS: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ["hydrocel geodesic sensor net", EVERY_HYDROCEL_NET],
  // The misspelling of OpenNeuro ds004395's CapManufacturersModelName.
  ["hydrocel geodisic sensor net", EVERY_HYDROCEL_NET],
  ["hydrocel gsn", EVERY_HYDROCEL_NET],
  ...Object.entries(HYDROCEL_NETS).flatMap(([size, nets]) =>
    [
      `hydrocel geodesic sensor net ${size}`,
      `hydrocel gsn ${size}`,
      // The sensor layout name an EGI MFF recording carries.
      `hydrocel gsn ${size} 1.0`,
    ].map((model) => [model, nets] as const),
  ),
  // The montage names (MNE-Python's, EEGLAB's and FieldTrip's files).
  ...Object.values(HYDROCEL_NETS).flatMap((nets) =>
    nets.map((name) => [name.toLowerCase(), nets] as const),
  ),
]);

/** Refusal reasons, in the order they are checked. */
export const REASONS = [
  "too_few_channels",
  "bipolar_labels",
  "labels_unrecognized",
  "share_too_low",
  "too_few_matched",
  "cap_model_unknown",
  "duplicate_label",
  "montage_ambiguous",
  "net_coverage_low",
] as const;
export type LabelsReason = (typeof REASONS)[number];

/** A channel's status, decided from the names alone. */
export type ChannelStatus =
  | "excluded_type"
  | "excluded_name"
  | "fiducial"
  | "bipolar"
  | "candidate";

export interface LabelsChannel {
  readonly name: string;
  readonly type: string | null;
  readonly status: ChannelStatus;
  /** The normalized name; null for a channel excluded by its type or name. */
  readonly key: string | null;
  /** The montage's label, for a placed channel; otherwise null. */
  readonly electrode: string | null;
  /** RAS meters, for a placed channel; otherwise null. */
  readonly position: Vec3 | null;
}

export interface Inference {
  readonly outcome: "placed" | "refused";
  readonly reason: LabelsReason | null;
  readonly montage: string | null;
  readonly candidates: number;
  readonly matched: number;
  readonly contenders: readonly string[];
  readonly duplicates: readonly string[];
  /** The name of the placed channel the recording's reference names, or null. */
  readonly reference: string | null;
  readonly channels: readonly LabelsChannel[];
}

/** A montage keyed for matching: each label's key to the label as spelled and its position. */
interface Keyed {
  readonly montage: Montage;
  readonly size: number;
  readonly positions: ReadonlyMap<string, { readonly label: string; readonly position: Vec3 }>;
  readonly aliases: Readonly<Record<string, string>>;
}

// ── Normalization ─────────────────────────────────────────────────────────

/** A montage label's (or a reference's) key: steps 1 to 3 and 5 to 7, with no split at a hyphen. */
export const labelKey = (label: string): string => finish(clean(label));

const isAscii = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x7f) return false;
  return true;
};

/** A cap model as `CAP_MODELS` compares it: trimmed, each run of step 2's whitespace one space, A
 *  to Z folded, and nothing else. */
export function foldCapModel(model: string): string {
  return asciiLower(
    model.replace(/^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g, "").replace(/[\t\n\v\f\r ]+/g, " "),
  );
}

/** The EGI montages a cap model names: none for no model, or for any string not listed. */
export function capModelNets(model: string | null): readonly string[] {
  if (model === null) return [];
  return CAP_MODELS.get(foldCapModel(model)) ?? [];
}

/** The keyword arguments the algorithm takes from a recording's sidecar (after BIDS inheritance):
 *  `CapManufacturersModelName` and `EEGReference`, each null unless a string. */
export function sidecarInputs(sidecar: Readonly<Record<string, unknown>>): {
  capModel: string | null;
  reference: string | null;
} {
  const text = (key: string): string | null =>
    typeof sidecar[key] === "string" ? (sidecar[key] as string) : null;
  return { capModel: text("CapManufacturersModelName"), reference: text("EEGReference") };
}

// ── Montages ──────────────────────────────────────────────────────────────

const keyedCache = new WeakMap<Montage, Keyed>();

/** A montage keyed for matching; refuses a label that is not ASCII or shares its key. */
function keyed(montage: Montage): Keyed {
  const held = keyedCache.get(montage);
  if (held) return held;
  const positions = new Map<string, { label: string; position: Vec3 }>();
  montage.names.forEach((label, i) => {
    const key = labelKey(label);
    if (!isAscii(key)) {
      throw new MontageFileInvalid(montage.name, `${JSON.stringify(label)} is not ASCII`);
    }
    const other = positions.get(key);
    if (other) {
      throw new MontageFileInvalid(
        montage.name,
        `${JSON.stringify(label)} and ${JSON.stringify(other.label)} have one key ${JSON.stringify(key)}`,
      );
    }
    positions.set(key, { label, position: montage.positions[i] });
  });
  const made: Keyed = {
    montage,
    size: montage.names.length,
    positions,
    aliases: { ...FAMILY_ALIASES[montage.family], ...MONTAGE_ALIASES[montage.name] },
  };
  keyedCache.set(montage, made);
  return made;
}

/**
 * The montages names reach, loaded through `load` (`loadMontage` on a page, the files in the
 * tests), in tie-break order. Rejects when one cannot be loaded.
 */
export function loadNameMontages(load: (name: string) => Promise<Montage>): Promise<Montage[]> {
  return Promise.all(NAME_MONTAGES.map((name) => load(name)));
}

// ── Classification ────────────────────────────────────────────────────────

interface Classified {
  readonly name: string;
  readonly type: string | null;
  readonly status: ChannelStatus;
  readonly key: string | null;
}

/** The right part most labels share, if it is the recording's common reference. */
function commonReference(rights: readonly string[], pending: number): string | null {
  if (rights.length === 0 || rights.length * 2 <= pending) return null;
  // Python's Counter.most_common(1): the highest count, the first inserted among equals.
  const counts = new Map<string, number>();
  for (const right of rights) counts.set(right, (counts.get(right) ?? 0) + 1);
  let value = rights[0];
  let count = 0;
  for (const [right, n] of counts) {
    if (n > count) {
      count = n;
      value = right;
    }
  }
  const [num, den] = COMMON_REFERENCE_SHARE;
  return count * den >= num * rights.length ? value : null;
}

/** Text before and after the last hyphen-minus, as Python's `rpartition("-")`. */
function splitLast(text: string): [string, string] | null {
  const at = text.lastIndexOf("-");
  return at < 0 ? null : [text.slice(0, at), text.slice(at + 1)];
}

function classify(
  channels: readonly (readonly [string, string | null])[],
  montages: readonly Keyed[],
): Classified[] {
  const cleaned = channels.map(([name]) => clean(name));
  const status: (ChannelStatus | null)[] = channels.map(([, type], i) => {
    const kind = typeClass(type);
    if (kind === "other") return "excluded_type";
    if (kind === "untyped" && excludedByName(cleaned[i])) return "excluded_name";
    return null;
  });
  const pending = status.flatMap((s, i) => (s === null ? [i] : []));
  const rights = pending.flatMap((i) => {
    const split = splitLast(cleaned[i]);
    return split ? [finish(split[1])] : [];
  });
  const common = commonReference(rights, pending.length);
  const names = new Set<string>();
  for (const m of montages) {
    for (const key of m.positions.keys()) names.add(key);
    for (const key of Object.keys(m.aliases)) names.add(key);
  }
  return channels.map(([name, type], i) => {
    const excluded = status[i];
    if (excluded !== null) return { name, type, status: excluded, key: null };
    const text = cleaned[i];
    let state: ChannelStatus = "candidate";
    let key = finish(text);
    const split = splitLast(text);
    if (split) {
      const right = finish(split[1]);
      if (REFERENCES.has(right) || right === common) key = finish(split[0]);
      else if (names.has(right)) state = "bipolar";
    }
    if (state === "candidate" && FIDUCIALS.has(key)) state = "fiducial";
    return { name, type, status: state, key };
  });
}

/**
 * The number of candidates (status `candidate` or `bipolar`), which needs no montage: the montages
 * only tell a bipolar name from a candidate, and both count, and a fiducial's key never holds a
 * hyphen, so no name a montage would make bipolar is a fiducial without one. Below `MIN_CHANNELS`,
 * `inferPositions` refuses with `too_few_channels` whatever the montages, so a caller can refuse
 * before loading any.
 */
export function countCandidates(channels: readonly (readonly [string, string | null])[]): number {
  return classify(channels, []).filter((c) => c.status === "candidate" || c.status === "bipolar")
    .length;
}

/** Candidate index to the montage key it matches. */
function hitsOf(montage: Keyed, channels: readonly Classified[]): Map<number, string> {
  const hits = new Map<number, string>();
  channels.forEach((channel, i) => {
    if (channel.status !== "candidate") return;
    const own = channel.key!;
    const key = Object.hasOwn(montage.aliases, own) ? montage.aliases[own] : own;
    if (isAscii(key) && montage.positions.has(key)) hits.set(i, key);
  });
  return hits;
}

const distance = (a: Vec3, b: Vec3): number =>
  Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);

// ── The choice ────────────────────────────────────────────────────────────

export interface InferInputs {
  /** The recording's `CapManufacturersModelName`, or null. */
  readonly capModel?: string | null;
  /** The recording's `EEGReference`, or null. */
  readonly reference?: string | null;
}

/**
 * Apply `nemar.sensor-labels.v1` to a recording's channels: `[name, BIDS type or null]` per
 * channel, in recording order, against `montages` (`loadNameMontages`; a template-only montage
 * among them is set aside, never matched or chosen).
 */
export function inferPositions(
  channels: readonly (readonly [string, string | null])[],
  montages: readonly Montage[],
  { capModel = null, reference = null }: InferInputs = {},
): Inference {
  const usable = montages
    .filter((m) => !TEMPLATE_ONLY_MONTAGES.includes(m.name))
    .map((m) => keyed(m));
  const classified = classify(channels, usable);
  const candidates = classified.filter(
    (c) => c.status === "candidate" || c.status === "bipolar",
  ).length;
  const bipolar = classified.filter((c) => c.status === "bipolar").length;
  const hits = new Map(usable.map((m) => [m, hitsOf(m, classified)]));
  const n = (m: Keyed): number => hits.get(m)!.size;
  const best = usable.reduce((most, m) => Math.max(most, n(m)), 0);

  const refused = (
    reason: LabelsReason,
    contenders: readonly Keyed[] = [],
    duplicates: readonly string[] = [],
  ): Inference => ({
    outcome: "refused",
    reason,
    montage: null,
    candidates,
    matched: best,
    contenders: contenders.map((m) => m.montage.name),
    duplicates,
    reference: null,
    channels: classified.map((c) => ({ ...c, electrode: null, position: null })),
  });

  if (candidates < MIN_CHANNELS) return refused("too_few_channels");
  {
    const [num, den] = MIN_SHARE;
    if (best * den < candidates * num) {
      const unmatched = candidates - best;
      if (bipolar * 2 >= unmatched) return refused("bipolar_labels");
      if (best === 0) return refused("labels_unrecognized");
      return refused("share_too_low");
    }
  }
  if (best < MIN_MATCHED) return refused("too_few_matched");

  const [cNum, cDen] = CONTENDER_SHARE;
  let contenders = usable.filter((m) => n(m) * cDen >= best * cNum);
  const named = capModelNets(capModel);
  const kept = contenders.filter(
    (m) => !EGI_FAMILIES.includes(m.montage.family) || named.includes(m.montage.name),
  );
  if (!kept.some((m) => n(m) === best)) return refused("cap_model_unknown", contenders);
  contenders = kept;
  const subset = (a: Map<number, string>, b: Map<number, string>): boolean => {
    for (const i of a.keys()) if (!b.has(i)) return false;
    return true;
  };
  const remaining = contenders.filter(
    (m) =>
      !contenders.some(
        (s) =>
          s.montage.family === m.montage.family &&
          s.size < m.size &&
          subset(hits.get(m)!, hits.get(s)!),
      ),
  );
  const winner = remaining.find((m) => n(m) === best)!;
  const chosen = hits.get(winner)!;

  const counts = new Map<string, number>();
  for (const key of chosen.values()) counts.set(key, (counts.get(key) ?? 0) + 1);
  const duplicates: string[] = [];
  for (const key of chosen.values()) {
    const label = winner.positions.get(key)!.label;
    if (counts.get(key)! > 1 && !duplicates.includes(label)) duplicates.push(label);
  }
  if (duplicates.length > 0) return refused("duplicate_label", remaining, duplicates);

  for (const other of remaining) {
    if (other === winner) continue;
    const theirs = hits.get(other)!;
    for (const [i, key] of chosen) {
      const there = theirs.get(i);
      if (there === undefined) continue;
      const a = winner.positions.get(key)!.position;
      const b = other.positions.get(there)!.position;
      if (distance(a, b) > COINCIDENT_M) return refused("montage_ambiguous", remaining);
    }
  }

  const [vNum, vDen] = NET_COVERAGE;
  if (NET_FAMILIES.includes(winner.montage.family) && best * vDen < winner.size * vNum) {
    return refused("net_coverage_low", remaining);
  }

  const placed: LabelsChannel[] = classified.map((c, i) => {
    const key = chosen.get(i);
    if (key === undefined) return { ...c, electrode: null, position: null };
    const { label, position } = winner.positions.get(key)!;
    return { ...c, electrode: label, position };
  });
  return {
    outcome: "placed",
    reason: null,
    montage: winner.montage.name,
    candidates,
    matched: best,
    contenders: remaining.map((m) => m.montage.name),
    duplicates: [],
    reference: referenceChannel(reference, winner, classified, chosen),
    channels: placed,
  };
}

/**
 * The name of the placed channel the recording's reference names, or null. Only on a montage of
 * `REFERENCE_FAMILIES`: the reference is normalized as a montage label is (no split at a hyphen),
 * redirected by the montage's aliases, and the channel placed on that electrode is the reference.
 */
function referenceChannel(
  reference: string | null,
  montage: Keyed,
  channels: readonly Classified[],
  chosen: ReadonlyMap<number, string>,
): string | null {
  if (reference === null || !REFERENCE_FAMILIES.includes(montage.montage.family)) return null;
  const own = labelKey(reference);
  const key = Object.hasOwn(montage.aliases, own) ? montage.aliases[own] : own;
  for (const [i, electrode] of chosen) if (electrode === key) return channels[i].name;
  return null;
}

/** The result as the vectors file records it (positions omitted). */
export function inferenceJson(inference: Inference): Record<string, unknown> {
  return {
    outcome: inference.outcome,
    reason: inference.reason,
    montage: inference.montage,
    candidates: inference.candidates,
    matched: inference.matched,
    contenders: [...inference.contenders],
    duplicates: [...inference.duplicates],
    reference: inference.reference,
    channels: inference.channels.map((c) => ({
      status: c.status,
      key: c.key,
      electrode: c.electrode,
    })),
  };
}
