/**
 * How a recording's channel name finds its electrode contact (card IS-J1): ordered match tiers,
 * every one a named rule with its evidence, and a refusal wherever a name could mean two things.
 *
 * A wrong join is worse than no join, so the module only ever does three things:
 * 1. It tries the tiers in order, and the first tier with a hit decides. `exact` is the file's own
 *    name; `normalized` rewrites the channel name by rules that change no letter of the contact
 *    (whitespace, a leading type word, zeros in front of the index); `suffix` removes one trailing
 *    reference token; `close` is the tier for a one-character difference and has no rule today,
 *    because the only surveyed candidate is right in one dataset and wrong in another. A tier with
 *    two different readings as candidates refuses (`ambiguous_name`); it never takes the first and
 *    never falls to a lower tier.
 * 2. It joins only on what the survey of real recordings shows (`.context/research-ieeg-channel-names.md`).
 *    Each rule below names its pattern, a real example and the datasets that need it; every pattern
 *    the survey saw and this module does not join is in `PENDING_PATTERNS` with the reason. Adding
 *    a pattern is one entry here plus a test row.
 * 3. It lets an exact name keep its contact. When another channel reaches the same contact through
 *    a lower tier, or two differently written channels reach it through the same non-exact tier,
 *    `settleClaims` refuses them (`duplicate_contact`), so a derived channel (a `_rms` copy) never
 *    takes the contact of the channel it was derived from.
 *
 * Everything here is pure and takes names, not files: `geometry.ts` owns contacts and positions and
 * calls `matchName` and `settleClaims`.
 */

/** How a channel's name reached its contact, from the strictest tier to the loosest. */
export type MatchKind = "exact" | "normalized" | "suffix" | "close";

export const MATCH_KINDS: readonly MatchKind[] = ["exact", "normalized", "suffix", "close"];

/** The tier's place in the order; a smaller number is a stricter match. */
export function tierOf(kind: MatchKind): number {
  return MATCH_KINDS.indexOf(kind);
}

/** The small tag beside a channel name that joined by a non-exact tier; nothing is said for `exact`. */
export const MATCH_KIND_TAGS: Record<Exclude<MatchKind, "exact">, string> = {
  normalized: "normalized match",
  suffix: "suffix match",
  close: "approximate name match",
};

/** The tag for a kind, or null for `exact` (two identical names need none). */
export function matchTag(kind: MatchKind): string | null {
  return kind === "exact" ? null : MATCH_KIND_TAGS[kind];
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The contact names of one space, with a lookup that tolerates leading zeros in the index. */
export interface NameIndex {
  /** Contact names in file order; a name the file repeats appears once per row. */
  names: readonly string[];
  /** How many rows carry exactly this name. */
  count(name: string): number;
  /** Distinct contact names equal to `form`, or, when `zeros` is set and none is, equal to it apart from leading zeros in the index. */
  find(form: string, zeros: boolean): string[];
}

/**
 * `LSF01` and `LSF1` have the same key: the trailing digit run loses its leading zeros (and keeps
 * one digit, so `A00` is `A0`). A name without trailing digits is its own key.
 */
export function zeroKey(name: string): string {
  const m = /^(.*?)(\d+)$/.exec(name);
  if (!m) return name;
  const digits = m[2].replace(/^0+(?=\d)/, "");
  return `${m[1]}${digits}`;
}

export function buildNameIndex(names: readonly string[]): NameIndex {
  const counts = new Map<string, number>();
  const byKey = new Map<string, string[]>();
  for (const name of names) {
    const seen = counts.get(name) ?? 0;
    counts.set(name, seen + 1);
    if (seen === 0) {
      const key = zeroKey(name);
      const group = byKey.get(key);
      if (group) group.push(name);
      else byKey.set(key, [name]);
    }
  }
  return {
    names,
    count: (name) => counts.get(name) ?? 0,
    find(form, zeros) {
      if (counts.has(form)) return [form];
      return zeros ? [...(byKey.get(zeroKey(form)) ?? [])] : [];
    },
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

interface RuleFacts {
  /** Stable word for tests, notes and the join's `rule` field. */
  id: string;
  /** The pattern in words. */
  pattern: string;
  /** A real channel name and the contact it must join. */
  example: { channel: string; contact: string };
  /** The datasets of the survey whose channels need it. */
  datasets: readonly string[];
  /** What the panel says about channels joined by this rule, as a sentence fragment about the names. */
  sentence: string;
}

/** `normalized`: rewrite the channel's name; no letter of the contact is ever changed. */
export interface TransformRule extends RuleFacts {
  kind: "normalized";
  form: "transform";
  /** The rewritten name, or null when the rule does not apply to this name. */
  apply(name: string): string | null;
}

/** `normalized`: compare the index with its leading zeros removed on both sides. */
export interface ZeroRule extends RuleFacts {
  kind: "normalized";
  form: "zeros";
}

/** `suffix`: remove one trailing token; what is left must be one contact's whole name. */
export interface SuffixRule extends RuleFacts {
  kind: "suffix";
  form: "strip";
  /** The name without the token, or null when this name does not end in it. */
  strip(name: string): string | null;
}

/** `close`: a restricted one-character difference, written as the names it would read. */
export interface CloseRule extends RuleFacts {
  kind: "close";
  form: "variants";
  /** Every name this one differs from by the rule's single edit. */
  variants(name: string): string[];
}

export type MatchRule = TransformRule | ZeroRule | SuffixRule | CloseRule;

/**
 * A leading type word followed by one space (`EEG A1-Ref`, `POL A3`): the EDF+ signal-label
 * convention and its polygraph variant. Case-sensitive, and only these words: the rest of the label
 * must be the contact name.
 */
const TYPE_PREFIX = /^(?:EEG|POL) (\S.*)$/;

/**
 * A reference token after the contact name: `-REF1`, `-Ref1` (a reference named in the label, any
 * case, with or without a number), or `-` and four or more digits (`-20000`, `-2000`). Fewer digits
 * stay unread: `A1-2` is a bipolar pair written in short form, and `T7-1` a repeat counter.
 */
const REFERENCE_NAME = /^(.+?)-ref\d*$/i;
const AVERAGE_REFERENCE = /^(.+?)-AV$/;
const NUMERIC_TAIL = /^(.+?)-([1-9]\d{3,})$/;

/**
 * The rules, in the order they are tried inside their tier. Tiers run `normalized`, `suffix`,
 * `close`. The `datasets` and examples are the survey's: every example is a real channel and a real
 * contact of that dataset, committed under `test/fixtures/ieeg-channel-names/`.
 */
export const MATCH_RULES: readonly MatchRule[] = [
  {
    id: "whitespace",
    kind: "normalized",
    form: "transform",
    pattern:
      "a space (or other whitespace) inside or around the name: the shaft, a space, then the index",
    example: { channel: "LENT 1", contact: "LENT1" },
    datasets: ["on004473"],
    sentence: "channel names carry whitespace the electrodes file does not",
    apply: (name) => {
      const squeezed = name.replace(/\s+/g, "");
      return squeezed !== name && squeezed !== "" ? squeezed : null;
    },
  },
  {
    id: "type_prefix",
    kind: "normalized",
    form: "transform",
    pattern: "a leading signal-type word and one space before the contact name (EEG or POL)",
    example: { channel: "POL A3", contact: "A3" },
    datasets: [
      "on004551",
      "on005007",
      "on005670",
      "on005931",
      "on005545",
      "on006233",
      "on006910",
      "on006914",
    ],
    sentence: "channel names start with a signal-type word the electrodes file does not have",
    apply: (name) => TYPE_PREFIX.exec(name)?.[1] ?? null,
  },
  {
    id: "leading_zeros",
    kind: "normalized",
    form: "zeros",
    pattern: "the same shaft and the same index, written with or without leading zeros",
    example: { channel: "LSF1", contact: "LSF01" },
    datasets: ["on003848", "on004194"],
    sentence:
      "channel names write the contact index with other leading zeros than the electrodes file",
  },
  {
    id: "reference_name",
    kind: "suffix",
    form: "strip",
    pattern:
      "the contact name, a hyphen, then a reference named in the label (REF or Ref, with or without a number)",
    example: { channel: "O1-REF1", contact: "O1" },
    datasets: ["nm000379", "on004551", "on005007", "on005670"],
    sentence: "channel names end in a named reference after the contact name",
    strip: (name) => REFERENCE_NAME.exec(name)?.[1] ?? null,
  },
  {
    id: "average_reference",
    kind: "suffix",
    form: "strip",
    pattern: "the contact name, a hyphen, then AV (the average reference)",
    example: { channel: "A1-AV", contact: "A1" },
    datasets: ["on005398", "on005931", "on006107", "on007118", "on007119", "on007120"],
    sentence: "channel names end in the average reference after the contact name",
    strip: (name) => AVERAGE_REFERENCE.exec(name)?.[1] ?? null,
  },
  {
    id: "numeric_tail",
    kind: "suffix",
    form: "strip",
    pattern:
      "the contact name, a hyphen, then four or more digits that no contact name continues with",
    example: { channel: "LTP1-20000", contact: "LTP1" },
    datasets: ["on005415"],
    sentence: "channel names end in a numeric tail after the contact name",
    strip: (name) => NUMERIC_TAIL.exec(name)?.[1] ?? null,
  },
];

export function ruleById(id: string): MatchRule | undefined {
  return MATCH_RULES.find((r) => r.id === id);
}

/**
 * A pattern the survey saw and this module does not join, with why. A later card turns one into a
 * rule by moving it into `MATCH_RULES` with a test row.
 */
export interface PendingPattern {
  id: string;
  pattern: string;
  /** Real channel names, and the contact names they would have to join (empty: none exists). */
  example: { channels: readonly string[]; contacts: readonly string[] };
  datasets: readonly string[];
  /** Why no rule joins it today. */
  reason: string;
}

export const PENDING_PATTERNS: readonly PendingPattern[] = [
  {
    id: "case_only",
    pattern: "the channel and the contact differ only in letter case",
    example: { channels: ["CH1", "CH2"], contacts: ["Ch1", "Ch2"] },
    datasets: ["on004624"],
    reason:
      "its labels run CH0 to CH35 against contacts Ch1 to Ch32, so the numbering may start at 0 in the labels and at 1 in the file; a case-folded join could pair CH1 with the wrong contact, and nothing in the dataset says which",
  },
  {
    id: "generic_index",
    pattern: "channels named only by their position (ch001, ch002, ...), contacts named by shaft",
    example: { channels: ["ch001", "ch002"], contacts: ["SA1", "SA2"] },
    datasets: ["nm000377"],
    reason:
      "the channel name carries no part of the contact name, so any join would rest on the order of the rows, which the dataset does not state",
  },
  {
    id: "lead_name",
    pattern: "a channel named for a whole lead while the file lists its contacts one by one",
    example: { channels: ["Ant", "Cen", "Pos"], contacts: ["Ant_d10a", "Ant_d07a", "Ant_d05a"] },
    datasets: ["nm000436"],
    reason: "one channel stands for several contacts and nothing says which one it recorded",
  },
  {
    id: "derived_copy",
    pattern: "a derived channel (a root-mean-square copy) next to the channel it was derived from",
    example: { channels: ["AD1_rms", "FA1_rms"], contacts: ["AD1", "FA1"] },
    datasets: ["nm000463"],
    reason:
      "the copy is a computed signal, not a recording of the contact, and the original already owns the contact; the claim rule refuses it even if a suffix rule existed",
  },
  {
    id: "polarity_marker",
    pattern: "a dollar sign between the type word and the contact name",
    example: { channels: ["POL $A11"], contacts: ["A11"] },
    datasets: ["on004551", "on005007"],
    reason: "the marker has no stated meaning in the dataset, so removing it would be a guess",
  },
  {
    id: "repeat_counter",
    pattern: "a hyphen and one digit after the name of a repeated lead (T7-0, T7-1)",
    example: { channels: ["T7-0", "T7-1"], contacts: [] },
    datasets: ["nm000373"],
    reason:
      "one digit after a hyphen is also how a bipolar pair is shortened (A1-2) and how repeats are counted, and the file holds no contact of that name",
  },
  {
    id: "seeg_prefix",
    pattern: "a leading SEEG and one space before the contact name",
    example: { channels: [], contacts: ["A1"] },
    datasets: [],
    reason:
      "no surveyed label starts with SEEG (EEG and POL do, rows S4 to S6); adding the word to the type_prefix rule is a one-word change once a dataset shows it",
  },
  {
    id: "unicode_lookalike",
    pattern: "a typographic prime or apostrophe where the file has an ASCII apostrophe",
    example: { channels: [], contacts: ["AL'8"] },
    datasets: [],
    reason:
      "no surveyed channel or contact holds a character outside ASCII, so there is nothing to read; in SEEG notation a prime marks the left side, so a rule must map only lookalike code points and never delete the mark",
  },
  {
    id: "doubled_letter",
    pattern:
      "one shaft letter written twice in a row where the file has it once, with the same index",
    example: { channels: ["mmAL1", "DHAA01"], contacts: ["mAL1", "DHA01"] },
    datasets: ["on003374", "nm000454"],
    reason:
      "the same edit is right in one dataset and wrong in the other: on003374 writes mmAL1 for contact mAL1, while nm000454 records a real shaft DHAA that the file lacks and whose contacts DHA01 to DHA04 belong to another shaft, so a join would put four channels on the wrong shaft",
  },
  {
    id: "edit_distance",
    pattern: "any other one-letter difference in the shaft name (a substitution, a missing letter)",
    example: { channels: [], contacts: ["mAL1", "mAR1"] },
    datasets: [],
    reason:
      "left and right shafts differ by one letter (AL and AR), so a general edit-distance join would put a contact on the wrong hemisphere; no survey row needs one",
  },
  {
    id: "bare_index",
    pattern: "channels named only by the contact index (1, 2, 26, 107)",
    example: {
      channels: ["26", "27", "107", "1", "2"],
      contacts: ["LMTG-26", "LMTG-27", "RMTG-107", "iEEG1", "iEEG2"],
    },
    datasets: ["on006136", "on005953"],
    reason:
      "the channel carries no shaft, so naming the contact whose name ends in the same number would be a guess",
  },
  {
    id: "prime_for_side",
    pattern: "a prime after the shaft letter (A'1) where the file writes the side as a letter",
    example: { channels: ["POL A'1", "POL H'1"], contacts: ["AR1"] },
    datasets: ["on005670"],
    reason:
      "reading the prime as left or right is a convention of SEEG notation that the dataset does not state, and a wrong reading would join the opposite hemisphere",
  },
];

// ---------------------------------------------------------------------------
// Matching one name
// ---------------------------------------------------------------------------

export type NameMatch =
  | {
      kind: "match";
      matchKind: Exclude<MatchKind, "exact">;
      /** The ids of the rules that read the name, joined with `+` in the order they were applied. */
      rule: string;
      /** One contact, or two for a bipolar pair read after a rewrite (`POL A1-A2`). */
      contacts: [string] | [string, string];
    }
  /** Two or more different readings are candidates at the tier that first had any. */
  | { kind: "ambiguous"; matchKind: Exclude<MatchKind, "exact">; candidates: string[] }
  | { kind: "none" };

/** The rules a match is made with; a test may pass a table of its own (the tier list is data). */
export type RuleTable = readonly MatchRule[];

interface Form {
  text: string;
  /** Rule ids applied, in order; empty for the name as it stands. */
  via: string[];
}

/** The name as it stands, then every rewrite of it by one or more transforms, in rule order. */
function normalizedForms(name: string, rules: RuleTable): Form[] {
  let forms: Form[] = [{ text: name, via: [] }];
  for (const rule of rules) {
    if (rule.form !== "transform") continue;
    const next: Form[] = [];
    for (const f of forms) {
      const rewritten = rule.apply(f.text);
      if (rewritten !== null) next.push({ text: rewritten, via: [...f.via, rule.id] });
    }
    forms = [...forms, ...next];
  }
  return forms;
}

/** One way of reading a name: a contact, or two for a bipolar pair, and the rules it took. */
interface Reading {
  contacts: [string] | [string, string];
  via: string[];
}

/**
 * Every split of `text` at a hyphen whose two trimmed halves are different contact names: a
 * bipolar pair. More than one split is more than one reading.
 */
export function splitPairs(text: string, index: NameIndex): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "-") continue;
    const left = text.slice(0, i).trim();
    const right = text.slice(i + 1).trim();
    if (
      left !== "" &&
      right !== "" &&
      left !== right &&
      index.count(left) > 0 &&
      index.count(right) > 0
    ) {
      pairs.push([left, right]);
    }
  }
  return pairs;
}

/**
 * The contacts a form reads as: the contact of exactly that name or, only when there is none, the
 * contacts that differ from it by leading zeros in the index (the zero-tolerant reading).
 */
function reads(form: string, index: NameIndex, via: string[], zeros: boolean): Reading[] {
  const exact = index.find(form, false);
  if (exact.length > 0) return exact.map((contact) => ({ contacts: [contact], via }));
  if (!zeros) return [];
  return index.find(form, true).map((contact) => ({ contacts: [contact], via: [...via, ZERO_ID] }));
}

const ZERO_ID = "leading_zeros";

function decide(readings: Reading[], matchKind: Exclude<MatchKind, "exact">): NameMatch {
  const keyOf = (r: Reading) => r.contacts.join("|");
  const distinct = new Map<string, Reading>();
  for (const r of readings) {
    const have = distinct.get(keyOf(r));
    // The chain with the fewest rewrites names the join.
    if (!have || r.via.length < have.via.length) distinct.set(keyOf(r), r);
  }
  if (distinct.size > 1) {
    const candidates = [...new Set([...distinct.values()].flatMap((r) => r.contacts))];
    return { kind: "ambiguous", matchKind, candidates };
  }
  const only = [...distinct.values()][0];
  return { kind: "match", matchKind, rule: only.via.join("+"), contacts: only.contacts };
}

/**
 * `LTP1-20000`'s tail could continue the shaft instead of naming a reference: when the shaft with
 * the tail's digits as its index is itself a contact (`LTP20000`), the name reads two ways.
 */
function continuation(rest: string, form: string, index: NameIndex): string[] {
  const digits = form.slice(rest.length + 1);
  const shaft = rest.replace(/\d+$/, "");
  return index.find(`${shaft}${digits}`, false);
}

/**
 * True when `contact` is `name` with exactly one character removed from the shaft (the part before
 * the trailing digits) and both end in the same digits, character for character. A substitution
 * (`AL1` for `AR1`), two removals, or any change to the index is false.
 */
export function isOneShaftDeletion(name: string, contact: string): boolean {
  const digits = (x: string) => /\d*$/.exec(x)?.[0] ?? "";
  if (digits(name) !== digits(contact)) return false;
  const head = name.slice(0, name.length - digits(name).length);
  const rest = contact.slice(0, contact.length - digits(contact).length);
  if (head.length !== rest.length + 1) return false;
  for (let i = 0; i < head.length; i++) {
    if (`${head.slice(0, i)}${head.slice(i + 1)}` === rest) return true;
  }
  return false;
}

/**
 * Match one channel name to contacts by the non-exact tiers, after the caller has tried `exact`
 * and the bipolar split of the name as it stands. Tiers run in order and the first tier with any
 * reading decides: one distinct reading is a match; two or more are `ambiguous` and the name joins
 * nothing.
 */
export function matchName(
  channel: string,
  index: NameIndex,
  rules: RuleTable = MATCH_RULES,
): NameMatch {
  const forms = normalizedForms(channel, rules);
  const zeros = rules.some((r) => r.form === "zeros");

  // `normalized`: a rewrite by the transforms, the zero-tolerant comparison, or both; and, after a
  // rewrite, a bipolar pair of exact names. The bare name compared exactly is the `exact` tier's.
  const normalized: Reading[] = [];
  for (const f of forms) {
    if (f.via.length === 0) {
      if (zeros && index.find(f.text, false).length === 0) {
        normalized.push(...reads(f.text, index, f.via, true));
      }
    } else {
      normalized.push(...reads(f.text, index, f.via, zeros));
      for (const pair of splitPairs(f.text, index)) normalized.push({ contacts: pair, via: f.via });
    }
  }
  if (normalized.length > 0) return decide(normalized, "normalized");

  // `suffix`: any form of the name (rewritten or not), then one token off its end.
  const suffixed: Reading[] = [];
  for (const f of forms) {
    for (const rule of rules) {
      if (rule.form !== "strip") continue;
      const rest = rule.strip(f.text);
      if (rest === null || rest === "") continue;
      const via = [...f.via, rule.id];
      suffixed.push(...reads(rest, index, via, zeros));
      if (rule.id === "numeric_tail") {
        // The tail may be a contact's index on the same shaft: then the name reads two ways.
        for (const contact of continuation(rest, f.text, index)) {
          suffixed.push({ contacts: [contact], via });
        }
      }
    }
  }
  if (suffixed.length > 0) return decide(suffixed, "suffix");

  // `close`: the one restricted edit of a rule, compared exactly, and re-checked here whatever the
  // rule proposed: the contact must be the name with exactly one shaft character removed and the
  // same trailing index, so no rule can join across shafts (AL and AR) or across two edits.
  const close: Reading[] = [];
  for (const rule of rules) {
    if (rule.form !== "variants") continue;
    for (const variant of rule.variants(channel)) {
      for (const contact of index.find(variant, false)) {
        if (isOneShaftDeletion(channel, contact)) {
          close.push({ contacts: [contact], via: [rule.id] });
        }
      }
    }
  }
  if (close.length > 0) return decide(close, "close");

  return { kind: "none" };
}

/** The sentences for a join's rule id (a chain such as `type_prefix+reference_name` has one per rule). */
export function ruleSentences(rule: string): string[] {
  return rule.split("+").flatMap((id) => {
    const found = ruleById(id);
    return found ? [found.sentence] : [];
  });
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** One channel's single-contact join, before claims are settled. */
export interface Claim {
  /** Index of the channel in the caller's list. */
  channel: number;
  /** The channel's name as the recording gave it. */
  label: string;
  contact: string;
  kind: MatchKind;
}

/**
 * Settle who owns each contact. A contact is claimed by channels; the strictest tier among its
 * claimants wins, provided one distinct channel name holds it (the same name twice is the same
 * claimant). Every claim below the winner's tier is refused, and when two differently written names
 * tie at a non-exact tier nobody wins: neither can be said to be the contact. Returns the indices
 * of the channels whose claim is refused.
 */
export function settleClaims(claims: readonly Claim[]): Set<number> {
  const refused = new Set<number>();
  const byContact = new Map<string, Claim[]>();
  for (const c of claims) {
    const group = byContact.get(c.contact);
    if (group) group.push(c);
    else byContact.set(c.contact, [c]);
  }
  for (const group of byContact.values()) {
    if (new Set(group.map((c) => c.label)).size < 2) continue;
    const best = Math.min(...group.map((c) => tierOf(c.kind)));
    const top = group.filter((c) => tierOf(c.kind) === best);
    const topLabels = new Set(top.map((c) => c.label));
    for (const c of group) {
      const wins = tierOf(c.kind) === best && topLabels.size === 1;
      if (!wins) refused.add(c.channel);
    }
  }
  return refused;
}
