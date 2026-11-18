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
