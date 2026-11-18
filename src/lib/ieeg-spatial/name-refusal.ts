/**
 * The words of a recording closed by its channel names (card IS-Q2): the join found no contact for
 * any of the recording's channels, so the Brain panel cannot draw anything, and it says what it
 * saw instead of one generic sentence.
 *
 * What it shows is bounded and complete about what it hides: the first `NAME_SAMPLE_LIMIT` channel
 * names of the recording beside the first `NAME_SAMPLE_LIMIT` contact names of the electrodes file,
 * each as the dataset wrote it (nothing trimmed, re-cased or normalized, so a reader sees `CH0`
 * against `Ch1` as it is), with the counts the samples are taken from, the cause in the words the
 * panel's notes use for an unlocated channel, and the plain statement that no rule joined these
 * names and nothing was guessed. A channel name comes first; where the join gives a pair (a name
 * that fits two contacts, or whose contact another channel holds) the contact names follow it in
 * parentheses, as the notes write them.
 *
 * A refusal for want of a position is not this: when any channel named a contact that has no
 * position, coordinates are part of the cause, and the toggle keeps its disabled state and its
 * sentence. Pure; no DOM.
 */

import type { ChannelJoin, UnlocatedCause } from "./geometry";

/** How many names of each side the refusal lists. */
export const NAME_SAMPLE_LIMIT = 12;

/** What the refusal says about the rules, in words that cannot be read as a guess. */
export const NO_RULE_SENTENCE = "No rule joined these names; nothing was guessed.";

/** The cause of an unlocated channel in the panel's words: the notes and this refusal both read it. */
export const UNLOCATED_PHRASES: Record<UnlocatedCause, string> = {
  no_contact: "no contact of that name in the electrodes file",
  no_position: "the contact's position is not given",
  duplicate_contact:
    "the electrodes file lists the contact twice, or another channel already holds it",
  ambiguous_pair: "the name reads as two contacts in more than one way",
  ambiguous_name: "the name fits more than one contact equally well",
};

/**
 * An unlocated channel by its own name as the recording gave it. A name that fits two contacts
 * says which; a channel that lost its contact to another says whose it is.
 */
export function unlocatedChannelName(join: ChannelJoin): string {
  if (join.cause === "ambiguous_name")
    return `${join.channel} (fits ${join.contacts.join(" and ")})`;
  if (join.cause === "duplicate_contact" && join.contacts.length === 1) {
    return `${join.channel} (contact ${join.contacts[0]})`;
  }
  return join.channel;
}

/** One entry per cause, in the order the causes first appear: `3 unlocated channels, <phrase>`. */
export function unlocatedCauseHeads(
  joins: readonly ChannelJoin[],
): { cause: UnlocatedCause; count: number; head: string }[] {
  const counts = new Map<UnlocatedCause, number>();
  for (const join of joins) {
    if (join.cause !== null) counts.set(join.cause, (counts.get(join.cause) ?? 0) + 1);
  }
  return [...counts].map(([cause, count]) => ({
    cause,
    count,
    head: `${count} unlocated channel${count === 1 ? "" : "s"}, ${UNLOCATED_PHRASES[cause]}`,
  }));
}

/**
 * True when the join left the recording with no located channel and names are the only cause:
 * there is at least one channel, none is located, and none is unlocated for want of a position.
 */
export function closedByNaming(joins: readonly ChannelJoin[], located: number): boolean {
  return joins.length > 0 && located === 0 && joins.every((j) => j.cause !== "no_position");
}

/**
 * A name as the list shows it. Nothing is trimmed, re-cased or normalized; the only change is that
 * a character that does not display (a control, a zero-width or bidi control, a soft hyphen, a
 * byte order mark, a space that is not the ordinary one) is written as `\u{200B}`, so the reader
 * sees it, and a name with characters beyond ASCII carries a note saying which (a Cyrillic A looks
 * like a Latin one, and the two never join). The recorded name is the one in the dataset's file.
 */
export function visibleName(raw: string): { text: string; note: string | null } {
  const escaped = new Set<string>();
  const text = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Zs}]/gu, (ch) => {
    if (ch === " ") return ch;
    const hex = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    escaped.add(`U+${hex}`);
    return `\\u{${hex}}`;
  });
  const beyond = new Set<string>();
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x7e) beyond.add(`U+${code.toString(16).toUpperCase().padStart(4, "0")}`);
  }
  const notes: string[] = [];
  if (escaped.size > 0) notes.push(`shown with an escape: ${[...escaped].join(", ")}`);
  if (beyond.size > 0) {
    const listed = [...beyond].slice(0, 4).join(", ");
    const more = beyond.size > 4 ? ` and ${beyond.size - 4} more` : "";
    notes.push(`non-ASCII: ${listed}${more}`);
  }
  return { text, note: notes.length > 0 ? notes.join("; ") : null };
}

export interface NameList {
  /** What the list is, and how many of how many it shows. */
  heading: string;
  /** At most `NAME_SAMPLE_LIMIT` names, as recorded (`visibleName`: only what cannot display is escaped). */
  names: string[];
  /** Per name, in step: what is unusual about it (`visibleName`), or null. */
  notes: (string | null)[];
  /** How many there are in all. */
  total: number;
}

export interface NameRefusal {
  /** One line per cause, in the notes' words, each ending in a period. */
  causes: string[];
  channels: NameList;
  contacts: NameList;
  verdict: string;
}

function sample(what: string, names: readonly string[]): NameList {
  const total = names.length;
  const shown = names.slice(0, NAME_SAMPLE_LIMIT).map(visibleName);
  const count = total > shown.length ? `first ${shown.length} of ${total}` : `all ${total}`;
  return {
    heading: `${what} (${count})`,
    names: shown.map((n) => n.text),
    notes: shown.map((n) => n.note),
    total,
  };
}

/**
 * The lists and sentences of the refusal. `joins` are the recording's channels in order, as
 * `joinChannels` gave them; `contactNames` are the electrodes file's named rows in file order.
 */
export function nameRefusal(
  joins: readonly ChannelJoin[],
  contactNames: readonly string[],
): NameRefusal {
  return {
    causes: unlocatedCauseHeads(joins).map((c) => `${c.head}.`),
    channels: sample("Channels in the recording, as named there", joins.map(unlocatedChannelName)),
    contacts: sample("Contacts in the electrodes file, as named there", contactNames),
    verdict: NO_RULE_SENTENCE,
  };
}
