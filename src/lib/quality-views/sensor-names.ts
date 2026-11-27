/**
 * The parts of `nemar.sensor-labels.v1` that `nemar.sensor-layout.v1` reads: how a channel's type
 * and name are normalized, which untyped names are not EEG, which names are fiducials, and the
 * montage names (neuroschema 0.6.0 `docs/views/sensor-labels.md`, steps 1 to 3 and 5 to 7, and
 * `src/neuroschema/views/sensor_labels.py`).
 *
 * The rest of that algorithm (the hyphen split, the aliases, matching against montages and its
 * refusals) is `sensor-labels.ts`, which builds on these definitions rather than repeating them. `test/quality-views-sensor-names.test.ts` holds them to the channels of
 * `views/vectors/sensor-labels.v1.json` that need nothing more.
 *
 * Nothing here uses Unicode normalization: a name is folded by a fixed table (full-width ASCII and
 * the compatibility spaces), the same in every runtime, and only A to Z are lowercased.
 */

/** The montages of `views/montages`, by exact name, in the order that breaks a tie between equal
 *  match counts; the last six are older EGI nets that names never reach. */
export const MONTAGE_NAMES: readonly string[] = [
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
  "GSN64v2_0",
  "GSN65v2_0",
  "GSN128",
  "GSN129",
  "GSN256",
  "GSN257",
];

/** An untyped channel whose cleaned name starts with one of these (in lowercase) is not EEG. */
export const NON_EEG_PREFIXES: readonly string[] = [
  "eog",
  "heog",
  "veog",
  "ecg",
  "ekg",
  "emg",
  "trig",
  "status",
  "stim",
  "event",
  "marker",
  "resp",
  "gsr",
  "photic",
  "exg",
  "spo2",
  "pleth",
  "pulse",
  "position",
  "light",
  // Neuroscan's eye channels and cerebellar electrodes, which no montage places.
  "heo",
  "veo",
  "cb1",
  "cb2",
  // Eye channels at the canthi, and the burst suppression trends, of clinical EDF exports.
  "roc",
  "loc",
  "luc",
  "rlc",
  "ibi",
  "bursts",
  "suppr",
];

/** Names of the nasion, inion and preauricular points, as `finish(clean(name))` gives them. */
export const FIDUCIALS: ReadonlySet<string> = new Set([
  "nz",
  "lpa",
  "rpa",
  "nas",
  "inion",
  "fidnz",
  "fidt9",
  "fidt10",
  "nasion",
  "leftear",
  "rightear",
]);

/** Step 2's whitespace: TAB, LF, VT, FF, CR and space. */
const WHITESPACE = "\t\n\v\f\r ";
const WHITESPACE_RUN = /[\t\n\v\f\r ]+/g;
/** A type prefix: EEG and a separator, or Nihon Kohden's POL and a space. */
const TYPE_PREFIX = /^(?:[Ee][Ee][Gg][ \-_:]+|[Pp][Oo][Ll] +)/;
const LEADING_ZEROS = /^([a-z]+)0+([0-9]+)$/;
const COMPATIBILITY_SPACES = new Set([
  0x00a0, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x202f, 0x205f, 0x3000,
]);

/** Fold A to Z to a to z, and nothing else. */
export function asciiLower(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
}

/** Step 1: full-width ASCII (U+FF01 to U+FF5E) to ASCII, and the compatibility spaces to a space. */
export function fold(text: string): string {
  let out = "";
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else if (COMPATIBILITY_SPACES.has(code)) out += " ";
    else out += character;
  }
  return out;
}

/** Strip the characters of `set` from both ends of `text`, as Python's `str.strip(set)` does. */
function strip(text: string, set: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && set.includes(text[start])) start++;
  while (end > start && set.includes(text[end - 1])) end--;
  return text.slice(start, end);
}

function stripEnd(text: string, set: string): string {
  let end = text.length;
  while (end > 0 && set.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

/** Steps 1 to 3: fold, trim and collapse whitespace, drop a type prefix. */
export function clean(name: string): string {
  const text = strip(fold(name), WHITESPACE).replace(WHITESPACE_RUN, " ");
  const prefix = TYPE_PREFIX.exec(text);
  return prefix ? text.slice(prefix[0].length) : text;
}

/**
 * Steps 5 to 7 for a name or one side of a hyphen: strip spaces at both ends, dots at the end and
 * quotation marks at both ends until none is left, fold A to Z to lowercase, and drop leading zeros
 * from the number of a letters-then-digits name (E001 is e1, A01 is a1).
 */
export function finish(part: string): string {
  let text = part;
  for (;;) {
    const stripped = strip(stripEnd(strip(text, " "), "."), "\"'");
    if (stripped === text) break;
    text = stripped;
  }
  text = asciiLower(text);
  const zeros = LEADING_ZEROS.exec(text);
  return zeros ? zeros[1] + zeros[2] : text;
}

/** `eeg`, `untyped` or `other`: a BIDS channel type, trimmed of step 2's whitespace and folded A
 *  to Z, never otherwise normalized. Absent, empty and `n/a` are untyped. */
export type TypeClass = "eeg" | "untyped" | "other";

export function typeClass(channelType: string | null | undefined): TypeClass {
  if (channelType === null || channelType === undefined) return "untyped";
  const folded = asciiLower(strip(channelType, WHITESPACE));
  if (folded === "" || folded === "n/a") return "untyped";
  return folded === "eeg" ? "eeg" : "other";
}

/** An untyped channel whose name, after steps 1 to 3, starts with a non-EEG prefix. */
export function excludedByName(cleaned: string): boolean {
  const lower = asciiLower(cleaned);
  return NON_EEG_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Whether `name` names a fiducial (`Nz`, `LPA`, `FidT9`, `Nasion`, ...), normalized. */
export function isFiducial(name: string): boolean {
  return FIDUCIALS.has(finish(clean(name)));
}
