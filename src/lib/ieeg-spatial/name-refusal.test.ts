import { describe, expect, it } from "vitest";
import { type Loaded, load } from "../../../test/ieeg-channel-fixtures";
import { joinChannels } from "./geometry";
import {
  NAME_SAMPLE_LIMIT,
  NO_RULE_SENTENCE,
  UNLOCATED_PHRASES,
  closedByNaming,
  nameRefusal,
  unlocatedCauseHeads,
  visibleName,
} from "./name-refusal";

/**
 * Real recordings only: nm000377 (the store names its channels ch001 to ch128, the electrodes file
 * names contacts SA1, SA2, ...) and on004624 (the labels run CH0 to CH35, the file's contacts Ch1
 * to Ch32), both read by the module's own resolver over the committed files of
 * test/fixtures/ieeg-channel-names. The positive control is on005522, whose channels all join.
 * The one input chosen by hand is the label list of the missing-coordinates case, which is the
 * real labels of on005415 whose join says the contact has no position.
 */

const joinsOf = (l: Loaded) => joinChannels(l.space, l.labels);

describe("a recording closed by its channel names", () => {
  it("nm000377: no channel joins, none for want of a position", async () => {
    const l = await load("nm000377");
    const joins = joinsOf(l);
    expect(joins).toHaveLength(128);
    expect(joins.every((j) => j.cause === "no_contact")).toBe(true);
    expect(closedByNaming(joins, 0)).toBe(true);
  });

  it("on004624: no channel joins either", async () => {
    const l = await load("on004624");
    expect(closedByNaming(joinsOf(l), 0)).toBe(true);
  });

  it("is never said of a recording some channel of which is located", async () => {
    const l = await load("on005522");
    const joins = joinsOf(l);
    const located = joins.filter((j) => j.status !== "unlocated").length;
    expect(located).toBeGreaterThan(0);
    expect(closedByNaming(joins, located)).toBe(false);
    // 128 unlocated channels and one located: the names do join something.
    const nm = joinsOf(await load("nm000377"));
    expect(closedByNaming(nm, 1)).toBe(false);
  });

  it("is never said when a name did join a contact that has no position (a missing-coordinates cause)", async () => {
    const l = await load("on005415-86");
    const joins = joinsOf(l);
    const noPosition = joins.filter((j) => j.cause === "no_position").map((j) => j.channel);
    expect(noPosition.length).toBeGreaterThan(0);
    // Only the channels the real file leaves without a position: every one is unlocated, but not by name.
    const only = joinChannels(l.space, noPosition);
    expect(only.every((j) => j.status === "unlocated")).toBe(true);
    expect(closedByNaming(only, 0)).toBe(false);
    // And one name that matches nothing beside them does not turn it into a naming problem.
    const mixed = joinChannels(l.space, [...noPosition, "zz-no-such-channel"]);
    expect(mixed.map((j) => j.cause)).toContain("no_contact");
    expect(closedByNaming(mixed, 0)).toBe(false);
  });

  it("is never said of an empty recording", async () => {
    const l = await load("nm000377");
    expect(closedByNaming(joinChannels(l.space, []), 0)).toBe(false);
  });
});

describe("what the refusal lists", () => {
  it("nm000377: the first 12 channel names and the first 12 contact names, as recorded, with their counts", async () => {
    const l = await load("nm000377");
    const r = nameRefusal(
      joinsOf(l),
      l.space.contacts.map((c) => c.name),
    );
    expect(NAME_SAMPLE_LIMIT).toBe(12);
    expect(r.channels.total).toBe(128);
    expect(r.channels.names).toEqual([
      "ch001",
      "ch002",
      "ch003",
      "ch004",
      "ch005",
      "ch006",
      "ch007",
      "ch008",
      "ch009",
      "ch010",
      "ch011",
      "ch012",
    ]);
    expect(r.channels.heading).toBe("Channels in the recording, as named there (first 12 of 128)");
    expect(r.contacts.total).toBe(94);
    expect(r.contacts.names).toEqual([
      "SA1",
      "SA2",
      "SA3",
      "SA4",
      "SA5",
      "SA6",
      "SA7",
      "SA8",
      "SA9",
      "SA10",
      "SB1",
      "SB2",
    ]);
    expect(r.contacts.heading).toBe(
      "Contacts in the electrodes file, as named there (first 12 of 94)",
    );
  });

  it("on004624: the names keep their case and digits exactly (CH0 against Ch1)", async () => {
    const l = await load("on004624");
    const r = nameRefusal(
      joinsOf(l),
      l.space.contacts.map((c) => c.name),
    );
    expect(r.channels.total).toBe(36);
    expect(r.channels.names.slice(0, 3)).toEqual(["CH0", "CH1", "CH10"]);
    expect(r.contacts.total).toBe(32);
    expect(r.contacts.names.slice(0, 3)).toEqual(["Ch1", "Ch2", "Ch3"]);
  });

  it("says 'all N' instead of a first-12 count when the whole list fits", async () => {
    const l = await load("nm000436");
    const joins = joinsOf(l);
    expect(joins.length).toBeLessThanOrEqual(NAME_SAMPLE_LIMIT);
    const r = nameRefusal(joins, ["A1", "A2"]);
    expect(r.channels.heading).toBe(
      `Channels in the recording, as named there (all ${joins.length})`,
    );
    expect(r.contacts.heading).toBe("Contacts in the electrodes file, as named there (all 2)");
    expect(r.channels.names).toHaveLength(joins.length);
  });

  it("states the cause in the notes' words, once per cause, with its count and no names", async () => {
    const l = await load("nm000377");
    const joins = joinsOf(l);
    expect(unlocatedCauseHeads(joins)).toEqual([
      {
        cause: "no_contact",
        count: 128,
        head: "128 unlocated channels, no contact of that name in the electrodes file",
      },
    ]);
    expect(UNLOCATED_PHRASES.no_contact).toBe("no contact of that name in the electrodes file");
    const r = nameRefusal(
      joins,
      l.space.contacts.map((c) => c.name),
    );
    expect(r.causes).toEqual([
      "128 unlocated channels, no contact of that name in the electrodes file.",
    ]);
  });

  it("says plainly that no rule joined these names and nothing was guessed", async () => {
    expect(NO_RULE_SENTENCE).toBe("No rule joined these names; nothing was guessed.");
    const l = await load("on004624");
    const r = nameRefusal(
      joinsOf(l),
      l.space.contacts.map((c) => c.name),
    );
    expect(r.verdict).toBe("No rule joined these names; nothing was guessed.");
  });

  it("a channel that fits two contacts shows the candidates in parentheses after its own name (known-answer contact LSF001 added to on004194)", async () => {
    const l = await load("on004194");
    const lsf01 = l.space.contacts.find((c) => c.name === "LSF01");
    expect(lsf01).toBeDefined();
    const both = {
      ...l.space,
      contacts: [
        ...l.space.contacts,
        { ...(lsf01 as (typeof l.space.contacts)[number]), name: "LSF001" },
      ],
    };
    const joins = joinChannels(both, ["LSF1", "zz-none"]);
    expect(joins[0]).toMatchObject({ cause: "ambiguous_name", contacts: ["LSF01", "LSF001"] });
    const r = nameRefusal(
      joins,
      both.contacts.map((c) => c.name),
    );
    expect(r.channels.names).toEqual(["LSF1 (fits LSF01 and LSF001)", "zz-none"]);
    // The channel's own name is still first, as recorded; the contacts are listed as the file names them.
    expect(r.contacts.names[0]).toBe(both.contacts[0].name);
    expect(r.causes).toEqual([
      "1 unlocated channel, the name fits more than one contact equally well.",
      "1 unlocated channel, no contact of that name in the electrodes file.",
    ]);
  });
});

describe("names a reader cannot tell apart or cannot see", () => {
  it("shows characters that do not display as escapes, and says so", () => {
    // A zero-width space, a control character, a right-to-left override and an isolate, a no-break space.
    expect(visibleName("Ch\u200B1")).toEqual({
      text: "Ch\\u{200B}1",
      note: "shown with an escape: U+200B",
    });
    expect(visibleName("A\u00011").text).toBe("A\\u{0001}1");
    expect(visibleName("A\u202E1").text).toBe("A\\u{202E}1");
    expect(visibleName("\u2067x\u2069").text).toBe("\\u{2067}x\\u{2069}");
    expect(visibleName("A\u00A01").text).toBe("A\\u{00A0}1");
    expect(visibleName("A\uFEFF1").text).toBe("A\\u{FEFF}1");
    expect(visibleName("A\u00AD1").text).toBe("A\\u{00AD}1");
    // Several: each distinct one is listed once.
    expect(visibleName("\u200B\u200B\u200E").note).toBe("shown with an escape: U+200B, U+200E");
  });

  it("leaves what displays alone: ordinary spaces, digits and ASCII punctuation are the recorded text", () => {
    for (const name of ["LENT 1", "EEG A1-Ref", "Ch1", "A1-A2", "ch_001", "O1-REF1", "SA10"]) {
      expect(visibleName(name)).toEqual({ text: name, note: null });
    }
  });

  it("keeps a right-to-left name in its logical order and says it has characters beyond ASCII", () => {
    const r = visibleName("\u05D0\u05D11");
    expect(r.text).toBe("\u05D0\u05D11");
    expect(r.note).toBe("non-ASCII: U+05D0, U+05D1");
    // Never more than four code points are listed, then how many more.
    expect(visibleName("\u05D0\u05D1\u05D2\u05D3\u05D4\u05D5").note).toBe(
      "non-ASCII: U+05D0, U+05D1, U+05D2, U+05D3 and 2 more",
    );
  });

  it("never reads a lookalike as the contact it resembles: a Cyrillic A is its own name, shown as written and flagged (real contact LAF1 of on005522)", async () => {
    const l = await load("on005522");
    expect(l.space.contacts.some((c) => c.name === "LAF1")).toBe(true);
    const lookalike = "L\u0410F1";
    const joins = joinChannels(l.space, [lookalike]);
    expect(joins[0]).toMatchObject({ status: "unlocated", cause: "no_contact" });
    expect(closedByNaming(joins, 0)).toBe(true);
    const r = nameRefusal(
      joins,
      l.space.contacts.map((c) => c.name),
    );
    // The channel is listed as recorded (the lookalike itself), with the flag that says why it differs.
    expect(r.channels.names).toEqual([lookalike]);
    expect(r.channels.notes).toEqual(["non-ASCII: U+0410"]);
    expect(r.contacts.names[0]).toBe(l.space.contacts[0].name);
    expect(r.contacts.notes.every((n) => n === null)).toBe(true);
  });

  it("applies to both lists, in step with their names", async () => {
    const l = await load("on005522");
    const names = l.space.contacts.map((c) => c.name);
    names[1] = "LAF\u200B2";
    const r = nameRefusal(joinChannels(l.space, ["X1", "X\u202E2"]), names);
    expect(r.channels.names).toEqual(["X1", "X\\u{202E}2"]);
    expect(r.channels.notes).toEqual([null, "shown with an escape: U+202E"]);
    expect(r.contacts.names[1]).toBe("LAF\\u{200B}2");
    expect(r.contacts.notes[1]).toBe("shown with an escape: U+200B");
    expect(r.contacts.notes).toHaveLength(r.contacts.names.length);
  });
});
