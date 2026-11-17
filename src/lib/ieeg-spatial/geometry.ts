/**
 * Resolve, parse and join an iEEG recording's contacts (card IS-C1).
 *
 * For one recording on a dataset page this module reads ONLY the dataset's own
 * `_electrodes.tsv` and `_coordsystem.json` files, found by walking the
 * recording's directory and its ancestors through the data plane, and returns:
 * every coordinate space the dataset declares for the recording, each with its
 * contacts (millimeters when the units are declared), the declared frame
 * classified into one of five kinds, and, when a space cannot be shown, a closed
 * reason word. `joinChannels` then matches the store's channel labels to the
 * contacts of one chosen space.
 *
 * Nothing here is guessed:
 * - The `space` entity names a frame and selects no recording, so one recording
 *   may have several; all of them are returned and none is preferred.
 * - A frame is `template` only when the declared label equals a standard
 *   template identifier of the BIDS coordinate-systems appendix, ignoring letter
 *   case and nothing else. A description never promotes a frame, and no prefix
 *   or partial match counts.
 * - Units come from `iEEGCoordinateUnits` alone (`m`, `cm`, `mm`); never from
 *   magnitudes. Undeclared units leave the values as written.
 * - A channel joins a contact by exact name, or as `A-B` when both halves are
 *   contacts. No case folding, no prefix.
 *
 * The module is pure: it takes `listDir` and `readText` functions, so tests hand
 * it readers over committed real files and production hands it
 * `dataPlaneSource`.
 */

import { type DirListing, fetchDirListing, fileDownloadUrl } from "../dir-listing";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Why a space (or a whole recording) cannot be shown. A closed set.
 *
 * `no_coordsystem` never withholds contacts: a space with an electrodes file and no
 * paired coordsystem file is shown in its own frame with undeclared units, and the word
 * is carried as that frame's `why` (the plan counts these datasets among the ones with
 * usable coordinates). It is a member of the set so one vocabulary words every label.
 */
export type GeometryReason =
  | "no_electrodes_file"
  | "no_coordinates"
  | "all_zero"
  | "unreadable"
  | "no_coordsystem"
  | "ambiguous"
  | "listing_failed";

export const GEOMETRY_REASONS: readonly GeometryReason[] = [
  "no_electrodes_file",
  "no_coordinates",
  "all_zero",
  "unreadable",
  "no_coordsystem",
  "ambiguous",
  "listing_failed",
];

/**
 * The BIDS appendix's "Standard template identifiers" table (coordinate systems),
 * canonical spelling. The deprecated spellings the appendix lists separately
 * (`fsaverage3` to `fsaverage6`, `UNCInfant0V21` and kin) are deliberately absent:
 * a label that equals none of these is an unknown frame.
 */
export const STANDARD_TEMPLATES = [
  "ICBM452AirSpace",
  "ICBM452Warp5Space",
  "IXI549Space",
  "fsaverage",
  "fsaverageSym",
  "fsLR",
  "MNIColin27",
  "MNI152Lin",
  "MNI152NLin2009aSym",
  "MNI152NLin2009bSym",
  "MNI152NLin2009cSym",
  "MNI152NLin2009aAsym",
  "MNI152NLin2009bAsym",
  "MNI152NLin2009cAsym",
  "MNI152NLin6Sym",
  "MNI152NLin6ASym",
  "MNI305",
  "NIHPD",
  "OASIS30AntsOASISAnts",
  "OASIS30Atropos",
  "Talairach",
  "UNCInfant",
] as const;

export type StandardTemplate = (typeof STANDARD_TEMPLATES)[number];

const TEMPLATE_BY_FOLDED = new Map<string, StandardTemplate>(
  STANDARD_TEMPLATES.map((t) => [t.toLowerCase(), t]),
);

/** Why a frame is `unknown`. */
export type UnknownFrameWhy =
  | "no_coordsystem" // no `_coordsystem.json` pairs with this space
  | "not_declared" // the file has no usable `iEEGCoordinateSystem`
  | "unrecognized_label" // the label equals no keyword and no standard template identifier
  | "space_mismatch"; // the `space` entity disagrees with the declared label

export type Frame =
  | {
      kind: "template";
      /** The label exactly as the coordsystem file writes it. */
      declared: string;
      /** The appendix's canonical spelling. */
      identifier: StandardTemplate;
      /** True when `declared` differs from `identifier` in letter case only. */
      caseNormalized: boolean;
    }
  | { kind: "native"; declared: "ACPC" | "ScanRAS" }
  | {
      kind: "described";
      declared: "Other";
      /** `iEEGCoordinateSystemDescription`, verbatim; null when the file has none. */
      description: string | null;
    }
  | { kind: "pixels"; declared: "Pixels" }
  | {
      kind: "unknown";
      why: UnknownFrameWhy;
      declared: string | null;
      spaceEntity: string | null;
    };

export interface Units {
  /** `iEEGCoordinateUnits` as written (trimmed); null when absent. */
  declared: string | null;
  /** The unit of `Contact.position`: `mm` after scaling, `pixels`, or null when the values stay as written. `size` is never scaled. */
  unit: "mm" | "pixels" | null;
  /** The factor applied to reach millimeters; null when none was applied. */
  scaleToMm: number | null;
  /** True when the file names a unit (`m`, `cm`, `mm`, `pixels`); `n/a`, absent or anything else is false. */
  unitsDeclared: boolean;
}

export type Vec3 = readonly [number, number, number];

export interface Contact {
  name: string;
  /** Millimeters when `units.unit === "mm"`; otherwise as written. Null when x, y or z is `n/a`, empty or not a finite number. */
  position: Vec3 | null;
  /** Contact surface area in square millimeters as written; null when `n/a`, non-finite or not positive (the `-999` sentinel). */
  size: number | null;
  /** The remaining optional columns as written (`ECoG`, `ECOG` and `SEEG` all occur); null for `n/a` or empty. */
  type: string | null;
  group: string | null;
  hemisphere: string | null;
  /** Zero-based position among the file's named rows. */
  row: number;
}

export interface SpaceGeometry {
  /** The `space` entity value shared by the electrodes and coordsystem files; null when the files carry none. */
  space: string | null;
  /** Dataset-relative path of the electrodes file chosen for this space; null only when `reason` is `ambiguous`. */
  electrodesPath: string | null;
  /** The coordsystem file paired with this space, or null. */
  coordsystemPath: string | null;
  /** Every file tied for this space when `reason` is `ambiguous`; empty otherwise. */
  tiedPaths: string[];
  /** The declared frame; null only when the space was refused before its coordsystem was read (`ambiguous`, `unreadable`). */
  frame: Frame | null;
  units: Units;
  /** `iEEGCoordinateSystemDescription`, verbatim, for any frame. */
  description: string | null;
  /** `iEEGCoordinateProcessingDescription`, verbatim. */
  processingDescription: string | null;
  /** Every named row of the electrodes file, in file order, with or without a position. Empty when `reason` is set. */
  contacts: Contact[];
  /** Named rows in the file. */
  rowCount: number;
  /** Rows dropped because their `name` was empty or `n/a`. */
  skippedRows: number;
  /** Why this space cannot be shown; null when `contacts` can be drawn. */
  reason: GeometryReason | null;
}

export interface RecordingGeometry {
  datasetId: string;
  version: string;
  recording: string;
  /**
   * Every space the dataset declares for this recording, ordered by the `space`
   * value (null first). The order is not a recommendation: the caller chooses.
   */
  spaces: SpaceGeometry[];
  /** Null when at least one space can be shown; otherwise why none can. */
  reason: GeometryReason | null;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The part of `fetchDirListing`'s answer this module reads; null is a failed request. */
export type ListDir = (path: string) => Promise<Pick<DirListing, "children"> | null>;

/** The UTF-8 text of a dataset-relative file, as `Response.text()` returns it; null is a failed read. */
export type ReadText = (path: string) => Promise<string | null>;

export interface GeometryInput {
  datasetId: string;
  version: string;
  /** Dataset-relative path of the recording (a data file, or a directory such as `.mefd`). */
  recording: string;
  listDir: ListDir;
  readText: ReadText;
}

// ---------------------------------------------------------------------------
// BIDS names
// ---------------------------------------------------------------------------

interface BidsName {
  entities: Map<string, string>;
  suffix: string;
  extension: string;
}

const ENTITY_CHUNK = /^([A-Za-z0-9]+)-([^_]+)$/;

/**
 * Split a BIDS file name into entities, suffix and extension. The last
 * underscore-separated chunk is always the suffix plus extension, never an
 * entity. Returns null for a name whose entity chunks are not `key-value` or
 * that repeats a key.
 */
function parseBidsName(name: string): BidsName | null {
  const chunks = name.split("_");
  const last = chunks.pop() ?? "";
  const dot = last.indexOf(".");
  const suffix = dot < 0 ? last : last.slice(0, dot);
  const extension = dot < 0 ? "" : last.slice(dot);
  const entities = new Map<string, string>();
  for (const chunk of chunks) {
    const m = ENTITY_CHUNK.exec(chunk);
    if (!m || entities.has(m[1])) return null;
    entities.set(m[1], m[2]);
  }
  return { entities, suffix, extension };
}

/** The recording's entities; lenient, since a recording may be a directory or oddly named. */
function recordingEntities(basename: string): Map<string, string> {
  const chunks = basename.split("_");
  chunks.pop();
  const entities = new Map<string, string>();
  for (const chunk of chunks) {
    const m = ENTITY_CHUNK.exec(chunk);
    if (m && !entities.has(m[1])) entities.set(m[1], m[2]);
  }
  entities.delete("space");
  return entities;
}

function splitPath(path: string): string[] {
  return path.split("/").filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

interface Candidate {
  path: string;
  depth: number;
  /** Entities other than `space`. */
  specificity: number;
  space: string | null;
}

/** `listDir` that never throws: a rejection is a failed request. */
async function safeList(
  listDir: ListDir,
  path: string,
): Promise<Pick<DirListing, "children"> | null> {
  try {
    const listing = await listDir(path);
    return listing && Array.isArray(listing.children) ? listing : null;
  } catch {
    return null;
  }
}

async function safeRead(readText: ReadText, path: string): Promise<string | null> {
  try {
    const text = await readText(path);
    return typeof text === "string" ? text : null;
  } catch {
    return null;
  }
}

/**
 * Candidates of one kind that apply to the recording. A file applies when it sits
 * in the recording's directory or an ancestor and every entity in its name except
 * `space` has the recording's value for that entity (BIDS inheritance).
 */
function collectCandidates(
  listings: { dir: string; depth: number; children: DirListing["children"] }[],
  recording: Map<string, string>,
  suffix: string,
  extension: string,
): Candidate[] {
  const out: Candidate[] = [];
  for (const { dir, depth, children } of listings) {
    for (const child of children) {
      if (child.kind !== "file") continue;
      const parsed = parseBidsName(child.name);
      if (!parsed || parsed.suffix !== suffix || parsed.extension !== extension) continue;
      let applies = true;
      let specificity = 0;
      for (const [key, value] of parsed.entities) {
        if (key === "space") continue;
        specificity += 1;
        if (recording.get(key) !== value) {
          applies = false;
          break;
        }
      }
      if (!applies) continue;
      out.push({
        path: dir ? `${dir}/${child.name}` : child.name,
        depth,
        specificity,
        space: parsed.entities.get("space") ?? null,
      });
    }
  }
  return out;
}

interface Selection {
  winner: Candidate | null;
  tied: Candidate[];
}

/** The most specific candidate per `space` value: deepest directory, then most entities. */
function selectPerSpace(candidates: Candidate[]): Map<string | null, Selection> {
  const bySpace = new Map<string | null, Candidate[]>();
  for (const c of candidates) {
    const group = bySpace.get(c.space);
    if (group) group.push(c);
    else bySpace.set(c.space, [c]);
  }
  const out = new Map<string | null, Selection>();
  for (const [space, group] of bySpace) {
    let top = group[0];
    for (const c of group) {
      if (c.depth > top.depth || (c.depth === top.depth && c.specificity > top.specificity))
        top = c;
    }
    const tied = group.filter((c) => c.depth === top.depth && c.specificity === top.specificity);
    out.set(space, tied.length === 1 ? { winner: top, tied: [] } : { winner: null, tied });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A finite decimal, or null. `Number("")` is 0 and `Number("0x1")` is 1, so the text is checked first. */
function parseFiniteNumber(text: string): number | null {
  const t = text.trim();
  if (!DECIMAL.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function optionalText(cell: string | undefined): string | null {
  const t = (cell ?? "").trim();
  return t === "" || t === "n/a" ? null : t;
}

interface RawRow {
  name: string;
  xyz: [number, number, number] | null;
  size: number | null;
  type: string | null;
  group: string | null;
  hemisphere: string | null;
}

interface ParsedElectrodes {
  rows: RawRow[];
  skipped: number;
}

/** Parse an `_electrodes.tsv`; null when it is not a tab-separated table with `name`, `x`, `y` and `z`. */
function parseElectrodes(text: string): ParsedElectrodes | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  // `trim` also removes a leading byte order mark, which opens some real files (on004100, on005415).
  const header = lines[0].split("\t").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const iName = col("name");
  const iX = col("x");
  const iY = col("y");
  const iZ = col("z");
  if (iName < 0 || iX < 0 || iY < 0 || iZ < 0) return null;
  const iSize = col("size");
  const iType = col("type");
  const iGroup = col("group");
  const iHemi = col("hemisphere");
  const rows: RawRow[] = [];
  let skipped = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const name = (cells[iName] ?? "").trim();
    if (name === "" || name === "n/a") {
      skipped += 1;
      continue;
    }
    const x = parseFiniteNumber(cells[iX] ?? "");
    const y = parseFiniteNumber(cells[iY] ?? "");
    const z = parseFiniteNumber(cells[iZ] ?? "");
    const sizeText = iSize < 0 ? null : optionalText(cells[iSize]);
    const size = sizeText === null ? null : parseFiniteNumber(sizeText);
    rows.push({
      name,
      xyz: x === null || y === null || z === null ? null : [x, y, z],
      size: size !== null && size > 0 ? size : null,
      type: iType < 0 ? null : optionalText(cells[iType]),
      group: iGroup < 0 ? null : optionalText(cells[iGroup]),
      hemisphere: iHemi < 0 ? null : optionalText(cells[iHemi]),
    });
  }
  return { rows, skipped };
}

interface ParsedCoordsystem {
  system: string | null;
  units: string | null;
  description: string | null;
  processing: string | null;
}

function jsonText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Parse a `_coordsystem.json`; null when it is not a JSON object. */
function parseCoordsystem(text: string): ParsedCoordsystem | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const o = doc as Record<string, unknown>;
  const system = jsonText(o.iEEGCoordinateSystem)?.trim() ?? "";
  const units = jsonText(o.iEEGCoordinateUnits)?.trim() ?? "";
  return {
    system: system === "" ? null : system,
    units: units === "" ? null : units,
    description: jsonText(o.iEEGCoordinateSystemDescription),
    processing: jsonText(o.iEEGCoordinateProcessingDescription),
  };
}

const NO_UNITS: Units = { declared: null, unit: null, scaleToMm: null, unitsDeclared: false };

/** `m`, `cm`, `mm` scale to millimeters; `pixels` stays pixels; anything else is undeclared. */
function classifyUnits(declared: string | null): Units {
  switch (declared) {
    case "mm":
      return { declared, unit: "mm", scaleToMm: 1, unitsDeclared: true };
    case "cm":
      return { declared, unit: "mm", scaleToMm: 10, unitsDeclared: true };
    case "m":
      return { declared, unit: "mm", scaleToMm: 1000, unitsDeclared: true };
    case "pixels":
      return { declared, unit: "pixels", scaleToMm: null, unitsDeclared: true };
    default:
      return { declared, unit: null, scaleToMm: null, unitsDeclared: false };
  }
}

/**
 * Classify a declared coordinate system into exactly one frame kind. Only a
 * standard template identifier is matched ignoring letter case; the other
 * keywords are exact. A `space` entity that disagrees with the declared label
 * (ignoring case) makes the frame unknown.
 */
export function classifyFrame(
  declared: string | null,
  spaceEntity: string | null,
  description: string | null,
): Frame {
  if (declared === null) {
    return { kind: "unknown", why: "not_declared", declared: null, spaceEntity };
  }
  if (spaceEntity !== null && spaceEntity.toLowerCase() !== declared.toLowerCase()) {
    return { kind: "unknown", why: "space_mismatch", declared, spaceEntity };
  }
  if (declared === "ACPC" || declared === "ScanRAS") return { kind: "native", declared };
  if (declared === "Other") return { kind: "described", declared, description };
  if (declared === "Pixels") return { kind: "pixels", declared };
  const identifier = TEMPLATE_BY_FOLDED.get(declared.toLowerCase());
  if (identifier) {
    return { kind: "template", declared, identifier, caseNormalized: identifier !== declared };
  }
  return { kind: "unknown", why: "unrecognized_label", declared, spaceEntity };
}

// ---------------------------------------------------------------------------
// One space
// ---------------------------------------------------------------------------

function refused(
  space: string | null,
  reason: GeometryReason,
  parts: Partial<SpaceGeometry> = {},
): SpaceGeometry {
  return {
    space,
    electrodesPath: null,
    coordsystemPath: null,
    tiedPaths: [],
    frame: null,
    units: NO_UNITS,
    description: null,
    processingDescription: null,
    contacts: [],
    rowCount: 0,
    skippedRows: 0,
    reason,
    ...parts,
  };
}

async function buildSpace(
  space: string | null,
  electrodes: Selection,
  coordsystem: Selection | undefined,
  readText: ReadText,
): Promise<SpaceGeometry> {
  const tiedPaths = [...electrodes.tied, ...(coordsystem?.tied ?? [])].map((c) => c.path).sort();
  if (electrodes.winner === null || tiedPaths.length > 0) {
    return refused(space, "ambiguous", { tiedPaths });
  }
  const electrodesPath = electrodes.winner.path;
  const coordsystemPath = coordsystem?.winner?.path ?? null;
  const parts = { electrodesPath, coordsystemPath };

  const [electrodesText, coordsystemText] = await Promise.all([
    safeRead(readText, electrodesPath),
    coordsystemPath === null ? Promise.resolve(null) : safeRead(readText, coordsystemPath),
  ]);
  const table = electrodesText === null ? null : parseElectrodes(electrodesText);
  if (table === null) return refused(space, "unreadable", parts);

  let frame: Frame;
  let units = NO_UNITS;
  let description: string | null = null;
  let processingDescription: string | null = null;
  if (coordsystemPath === null) {
    frame = { kind: "unknown", why: "no_coordsystem", declared: null, spaceEntity: space };
  } else {
    const coord = coordsystemText === null ? null : parseCoordsystem(coordsystemText);
    if (coord === null) return refused(space, "unreadable", parts);
    frame = classifyFrame(coord.system, space, coord.description);
    units = classifyUnits(coord.units);
    description = coord.description;
    processingDescription = coord.processing;
  }
  const determined = {
    ...parts,
    frame,
    units,
    description,
    processingDescription,
    rowCount: table.rows.length,
    skippedRows: table.skipped,
  };

  const located = table.rows.filter((r) => r.xyz !== null);
  if (located.length === 0) return refused(space, "no_coordinates", determined);
  if (located.every((r) => r.xyz?.every((v) => v === 0))) {
    return refused(space, "all_zero", determined);
  }

  const scale = units.scaleToMm ?? 1;
  const contacts: Contact[] = table.rows.map((r, row) => ({
    name: r.name,
    position: r.xyz && [r.xyz[0] * scale, r.xyz[1] * scale, r.xyz[2] * scale],
    size: r.size,
    type: r.type,
    group: r.group,
    hemisphere: r.hemisphere,
    row,
  }));
  return { ...refused(space, "no_coordinates", determined), contacts, reason: null };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function empty(input: GeometryInput, reason: GeometryReason): RecordingGeometry {
  return {
    datasetId: input.datasetId,
    version: input.version,
    recording: input.recording,
    spaces: [],
    reason,
  };
}

function compareSpace(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/**
 * The contacts, frames and reasons for one recording. Walks the recording's
 * directory and its ancestors to the dataset root, applies the inheritance rule
 * per `space`, pairs coordsystem files by equal `space`, and returns every space.
 *
 * A directory listing that fails anywhere on the walk gives `listing_failed`
 * for the whole recording: a missing ancestor could hold a file that offers a
 * further space, so a partial answer would silently omit it.
 */
export async function resolveRecordingGeometry(input: GeometryInput): Promise<RecordingGeometry> {
  const segments = splitPath(input.recording);
  const basename = segments.pop() ?? "";
  const entities = recordingEntities(basename);
  const dirs = Array.from({ length: segments.length + 1 }, (_, depth) => ({
    depth,
    dir: segments.slice(0, depth).join("/"),
  }));
  const answers = await Promise.all(dirs.map((d) => safeList(input.listDir, d.dir)));
  const listings: { dir: string; depth: number; children: DirListing["children"] }[] = [];
  for (let i = 0; i < dirs.length; i++) {
    const answer = answers[i];
    if (answer === null) return empty(input, "listing_failed");
    listings.push({ ...dirs[i], children: answer.children });
  }

  const electrodes = selectPerSpace(collectCandidates(listings, entities, "electrodes", ".tsv"));
  if (electrodes.size === 0) return empty(input, "no_electrodes_file");
  const coordsystems = selectPerSpace(
    collectCandidates(listings, entities, "coordsystem", ".json"),
  );

  const spaces = await Promise.all(
    [...electrodes.keys()]
      .sort(compareSpace)
      .map((space) =>
        buildSpace(
          space,
          electrodes.get(space) as Selection,
          coordsystems.get(space),
          input.readText,
        ),
      ),
  );
  const shown = spaces.some((s) => s.reason === null);
  return {
    datasetId: input.datasetId,
    version: input.version,
    recording: input.recording,
    spaces,
    reason: shown ? null : (spaces[0]?.reason ?? "no_electrodes_file"),
  };
}

// ---------------------------------------------------------------------------
// Joins
// ---------------------------------------------------------------------------

/** Why a channel has no position. */
export type UnlocatedCause =
  | "no_contact" // no contact carries the name, and no `A-B` split names two contacts
  | "no_position" // the named contact (or one half of the pair) has no position
  | "duplicate_contact" // two rows carry the same contact name
  | "ambiguous_pair"; // more than one `-` split names two contacts

export interface ChannelJoin {
  channel: string;
  /** `located`: one contact by exact name. `bipolar`: two contacts, position at their midpoint. */
  status: "located" | "bipolar" | "unlocated";
  /** Names of the contacts joined: one, two for a bipolar channel, none for `no_contact`. */
  contacts: string[];
  /** In the space's units; null when unlocated. */
  position: Vec3 | null;
  cause: UnlocatedCause | null;
}

function midpoint(a: Vec3, b: Vec3): Vec3 {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function unlocated(channel: string, cause: UnlocatedCause, contacts: string[] = []): ChannelJoin {
  return { channel, status: "unlocated", contacts, position: null, cause };
}

/**
 * Join channel labels to the contacts of one space. Exact name first; otherwise a
 * channel `A-B` (or `A - B`) joins both contacts when exactly one `-` split names
 * two contacts. A name that is a contact but has no position is unlocated, never
 * a fall-through to the pair rule. No case folding, no prefix matching.
 */
export function joinChannels(space: SpaceGeometry, channels: readonly string[]): ChannelJoin[] {
  const byName = new Map<string, Contact[]>();
  for (const c of space.contacts) {
    const group = byName.get(c.name);
    if (group) group.push(c);
    else byName.set(c.name, [c]);
  }

  return channels.map((channel): ChannelJoin => {
    const exact = byName.get(channel);
    if (exact) {
      if (exact.length > 1) return unlocated(channel, "duplicate_contact", [channel]);
      const position = exact[0].position;
      if (position === null) return unlocated(channel, "no_position", [channel]);
      return { channel, status: "located", contacts: [channel], position, cause: null };
    }

    const pairs: [string, string][] = [];
    for (let i = 0; i < channel.length; i++) {
      if (channel[i] !== "-") continue;
      const left = channel.slice(0, i).trim();
      const right = channel.slice(i + 1).trim();
      if (left !== "" && right !== "" && left !== right && byName.has(left) && byName.has(right)) {
        pairs.push([left, right]);
      }
    }
    if (pairs.length === 0) return unlocated(channel, "no_contact");
    if (pairs.length > 1) return unlocated(channel, "ambiguous_pair");

    const [left, right] = pairs[0];
    const a = byName.get(left) as Contact[];
    const b = byName.get(right) as Contact[];
    if (a.length > 1 || b.length > 1) return unlocated(channel, "duplicate_contact", [left, right]);
    const pa = a[0].position;
    const pb = b[0].position;
    if (pa === null || pb === null) return unlocated(channel, "no_position", [left, right]);
    return {
      channel,
      status: "bipolar",
      contacts: [left, right],
      position: midpoint(pa, pb),
      cause: null,
    };
  });
}

// ---------------------------------------------------------------------------
// Production source
// ---------------------------------------------------------------------------

export interface DataPlaneSourceInit {
  signal?: AbortSignal;
  dataBase?: string;
}

/**
 * `listDir` and `readText` over the data plane, for production. The listing is
 * `fetchDirListing` itself; a file is read from the stable download route and
 * any failure (network, non-200) is null.
 */
export function dataPlaneSource(
  datasetId: string,
  version: string,
  init: DataPlaneSourceInit = {},
): { listDir: ListDir; readText: ReadText } {
  return {
    listDir: (path) => fetchDirListing(datasetId, version, path, init),
    readText: async (path) => {
      try {
        const res = await fetch(fileDownloadUrl(datasetId, version, path, init.dataBase), {
          signal: init.signal,
        });
        return res.ok ? await res.text() : null;
      } catch {
        return null;
      }
    },
  };
}
