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

export interface NameList {
  /** What the list is, and how many of how many it shows. */
  heading: string;
  /** At most `NAME_SAMPLE_LIMIT` names, as recorded. */
  names: string[];
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
  const shown = names.slice(0, NAME_SAMPLE_LIMIT);
  const count = total > shown.length ? `first ${shown.length} of ${total}` : `all ${total}`;
  return { heading: `${what} (${count})`, names: shown, total };
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
