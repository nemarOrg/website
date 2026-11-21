import { describe, expect, it } from "vitest";
import { CASES, type Loaded, load } from "../../../test/ieeg-channel-fixtures";
import { nodeFs, repoPath, sha256Hex } from "../../../test/node";
import {
  type Claim,
  MATCH_KINDS,
  MATCH_KIND_TAGS,
  MATCH_RULES,
  type MatchRule,
  PENDING_PATTERNS,
  buildNameIndex,
  isOneShaftDeletion,
  matchName,
  matchTag,
  ruleById,
  ruleSentences,
  settleClaims,
  zeroKey,
} from "./channel-match";
import { type ChannelJoin, type Contact, type SpaceGeometry, joinChannels } from "./geometry";

/**
 * Real files only. Every recording below is a public one, read through the module's own resolver
 * over a reader on the committed files of test/fixtures/ieeg-channel-names (SOURCES.json names
 * dataset, version, path and SHA-256 of each; the Zarr channel labels are excerpts of the store's
 * group metadata, each with the hash of the full upstream response).
 *
 * Inputs that are known answers rather than files say so where they appear: contact rows added to
 * a real space to make two readings of one name (no surveyed file has two such contacts), channel
 * labels composed from a real space's contact names, and rule tables that add a rule the module
 * does not have, so the engine's refusals can be shown on real names.
 */

const fs = await nodeFs();
const FIX = "test/fixtures/ieeg-channel-names";

const names = (space: SpaceGeometry) => new Set(space.contacts.map((c) => c.name));
const contactOf = (space: SpaceGeometry, name: string): Contact => {
  const found = space.contacts.find((c) => c.name === name);
  expect(found, `contact ${name}`).toBeDefined();
  return found as Contact;
};

/** A real space with one more contact row, copied from a real row under a new name (a known answer). */
function withContact(space: SpaceGeometry, from: string, name: string): SpaceGeometry {
  const row = contactOf(space, from);
  return {
    ...space,
    contacts: [...space.contacts, { ...row, name, row: space.contacts.length }],
  };
}

/** A space of a few contacts, each a real row of `space` copied under the name wanted (a known answer). */
function spaceNamed(space: SpaceGeometry, rows: [from: string, name: string][]): SpaceGeometry {
  return {
    ...space,
    contacts: rows.map(([from, name], row) => ({ ...contactOf(space, from), name, row })),
  };
}

const byChannel = (joins: ChannelJoin[]) => new Map(joins.map((j) => [j.channel, j]));

describe("the tier list is data, and each rule carries its evidence", () => {
  it("every rule names a pattern, a sentence, an example and at least one dataset, once", () => {
    const ids = MATCH_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of MATCH_RULES) {
      expect(r.pattern.length, r.id).toBeGreaterThan(20);
      expect(r.sentence.length, r.id).toBeGreaterThan(20);
      expect(r.example.channel && r.example.contact, r.id).toBeTruthy();
      expect(r.datasets.length, r.id).toBeGreaterThan(0);
      expect(r.sentence, r.id).not.toMatch(/—/);
    }
    // A rule's tier follows from its form.
    for (const r of MATCH_RULES) {
      const expected = {
        transform: "normalized",
        zeros: "normalized",
        strip: "suffix",
        variants: "close",
      };
      expect(r.kind, r.id).toBe(expected[r.form]);
    }
  });

  it("every rule's example is a real channel and a real contact, and it joins by that rule", async () => {
    const loaded = new Map<string, Loaded>();
    for (const key of Object.keys(CASES)) loaded.set(key, await load(key));
    for (const rule of MATCH_RULES) {
      const homes = Object.entries(CASES).filter(([, c]) => rule.datasets.includes(c.id));
      const home = homes.find(([key]) => {
        const l = loaded.get(key) as Loaded;
        return l.labels.includes(rule.example.channel) && names(l.space).has(rule.example.contact);
      });
      expect(home, `${rule.id}: ${rule.example.channel} in the committed recordings`).toBeDefined();
      const l = loaded.get((home as [string, unknown])[0]) as Loaded;
      const join = byChannel(joinChannels(l.space, l.labels)).get(
        rule.example.channel,
      ) as ChannelJoin;
      expect(join.matchKind, rule.id).toBe(rule.kind);
      expect(join.rule?.split("+"), rule.id).toContain(rule.id);
      expect(join.contacts).toContain(rule.example.contact);
    }
  });

  it("the sentences say what the name does, not what it means: -AV and -REF are read as references, no dataset states it", () => {
    expect((ruleById("average_reference") as MatchRule).sentence).toBe(
      "channel names end in -AV, read as the average reference",
    );
    expect((ruleById("reference_name") as MatchRule).sentence).toBe(
      "channel names end in REF or Ref with an optional number, read as a reference",
    );
    expect((ruleById("numeric_tail") as MatchRule).sentence).toBe(
      "channel names end in a numeric tail after the contact name",
    );
    for (const id of ["average_reference", "reference_name"]) {
      expect((ruleById(id) as MatchRule).pattern, id).toContain("read as");
    }
  });

  it("the tiers run in the order the card names, and only a non-exact kind has a tag", () => {
    expect(MATCH_KINDS).toEqual(["exact", "normalized", "suffix", "close"]);
    expect(matchTag("exact")).toBeNull();
    for (const kind of ["normalized", "suffix", "close"] as const) {
      expect(matchTag(kind)).toBe(MATCH_KIND_TAGS[kind]);
    }
    expect(MATCH_KIND_TAGS.close).toBe("approximate name match");
  });

  it("a chain of rules has one sentence per rule", () => {
    expect(ruleSentences("type_prefix+reference_name")).toEqual([
      (ruleById("type_prefix") as MatchRule).sentence,
      (ruleById("reference_name") as MatchRule).sentence,
    ]);
    expect(ruleSentences("no_such_rule")).toEqual([]);
  });
});

describe("suffix: on005415's numeric tail", () => {
  it("LTP1-20000 joins LTP1 as a suffix match, and every channel of the store whose name is a contact plus the tail does", async () => {
    const { space, labels } = await load("on005415-72");
    const joins = byChannel(joinChannels(space, labels));
    const j = joins.get("LTP1-20000") as ChannelJoin;
    expect(j).toMatchObject({
      status: "located",
      contacts: ["LTP1"],
      cause: null,
      matchKind: "suffix",
      rule: "numeric_tail",
    });
    expect(j.position).toEqual(contactOf(space, "LTP1").position);

    // Independent count: labels that are a contact's name, a hyphen and five digits.
    const contactNames = names(space);
    const expected = labels.filter((l) => /-\d{5}$/.test(l) && contactNames.has(l.slice(0, -6)));
    const joined = [...joins.values()].filter((x) => x.status === "located");
    expect(joined.map((x) => x.channel).sort()).toEqual([...expected].sort());
    expect(joined.length).toBeGreaterThan(150);
    for (const x of joined) expect(x.matchKind).toBe("suffix");
    // What is left has no contact: the electrodes file lacks those rows and the ECG channels are not contacts.
    for (const x of joins.values()) {
      if (x.status === "unlocated") expect(x.cause).toBe("no_contact");
    }
    expect(joins.get("EKG+RES1-20000")).toMatchObject({ status: "unlocated", cause: "no_contact" });
  });

  it("a recording that mixes -20000 and -2000 joins both, each to its own contact", async () => {
    const { space, labels } = await load("on005415-86");
    const joins = byChannel(joinChannels(space, labels));
    const short = labels.filter((l) => l.endsWith("-2000"));
    expect(short.length).toBeGreaterThan(0);
    for (const l of short) {
      expect(joins.get(l), l).toMatchObject({
        status: "located",
        contacts: [l.slice(0, -5)],
        matchKind: "suffix",
      });
    }
  });

  it("the tail of a real bipolar pair is never swallowed: nm000360's LA3-LA4 stays unlocated", async () => {
    const { space, labels } = await load("nm000360");
    expect(labels).toContain("LA3-LA4");
    expect(names(space).has("LA3")).toBe(true);
    expect(names(space).has("LA4")).toBe(false);
    const j = byChannel(joinChannels(space, labels)).get("LA3-LA4") as ChannelJoin;
    expect(j).toMatchObject({ status: "unlocated", cause: "no_contact", matchKind: null });
  });

  it("a single digit after the hyphen is not a reference: nm000373's T7-1 stays unlocated", async () => {
    const { space, labels } = await load("nm000373");
    expect(labels).toContain("T7-1");
    const joins = byChannel(joinChannels(space, labels));
    expect(joins.get("T7-1")?.status).toBe("unlocated");
    expect(joins.get("T7-0")?.status).toBe("unlocated");
  });
});

describe("bipolar keeps its priority when both halves are contacts", () => {
  it("on005415's contacts: a suffix channel and a true bipolar pair, side by side", async () => {
    const { space } = await load("on005415-72");
    // LTP1-LTP2 is composed from two real contact names (a known-answer label).
    const joins = joinChannels(space, ["LTP1-20000", "LTP1-LTP2"]);
    expect(joins[0]).toMatchObject({ status: "located", matchKind: "suffix", contacts: ["LTP1"] });
    const a = contactOf(space, "LTP1").position as readonly number[];
    const b = contactOf(space, "LTP2").position as readonly number[];
    expect(joins[1]).toMatchObject({
      status: "bipolar",
      contacts: ["LTP1", "LTP2"],
      matchKind: "exact",
      rule: null,
    });
    expect(joins[1].position).toEqual([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  });

  it("on005522's real bipolar channels are exact pairs at their midpoints, not suffix reads", async () => {
    const { space, labels } = await load("on005522");
    const joins = joinChannels(space, labels);
    expect(joins.every((j) => j.status === "bipolar" && j.matchKind === "exact")).toBe(true);
    expect(joins.every((j) => j.rule === null)).toBe(true);
    const first = joins[0];
    expect(first.channel).toBe("LAF1-LAF2");
    expect(first.contacts).toEqual(["LAF1", "LAF2"]);
  });

  it("when the reference's own name is a contact too, the pair wins over the suffix reading (known-answer contact AV)", async () => {
    const { space } = await load("on005522");
    // Without a contact named AV, LAF1-AV is LAF1 referenced to the average: a suffix match.
    expect(joinChannels(space, ["LAF1-AV"])[0]).toMatchObject({
      status: "located",
      contacts: ["LAF1"],
      matchKind: "suffix",
      rule: "average_reference",
    });
    // With a contact named AV (a row copied from a real one), both halves resolve: a bipolar pair.
    const both = withContact(space, "LAF2", "AV");
    expect(joinChannels(both, ["LAF1-AV"])[0]).toMatchObject({
      status: "bipolar",
      contacts: ["LAF1", "AV"],
      matchKind: "exact",
    });
  });
});

describe("normalized: whitespace, a leading type word, zeros in the index", () => {
  it("on004473: LENT 1 joins LENT1 by whitespace, and Event joins nothing", async () => {
    const { space, labels } = await load("on004473");
    const joins = byChannel(joinChannels(space, labels));
    expect(joins.get("LENT 1")).toMatchObject({
      status: "located",
      contacts: ["LENT1"],
      matchKind: "normalized",
      rule: "whitespace",
    });
    expect(joins.get("Event")).toMatchObject({ status: "unlocated", cause: "no_contact" });
    const spaced = labels.filter((l) => / \d+$/.test(l) && names(space).has(l.replace(" ", "")));
    expect(spaced.length).toBeGreaterThan(50);
    for (const l of spaced) expect(joins.get(l)?.contacts, l).toEqual([l.replace(" ", "")]);
  });

  it("on004551: POL A3 joins A3 and EEG A1-Ref joins A1, each by the rules it took", async () => {
    const { space, labels } = await load("on004551");
    const joins = byChannel(joinChannels(space, labels));
    expect(joins.get("POL A3")).toMatchObject({
      contacts: ["A3"],
      matchKind: "normalized",
      rule: "type_prefix",
    });
    expect(joins.get("EEG A1-Ref")).toMatchObject({
      contacts: ["A1"],
      matchKind: "suffix",
      rule: "type_prefix+reference_name",
    });
  });

  it("on005007: a POL channel that is not a contact (POL ECG) joins nothing", async () => {
    const { space, labels } = await load("on005007");
    const joins = byChannel(joinChannels(space, labels));
    expect(joins.get("POL ECG")?.status).toBe("unlocated");
  });

  it("on006233: POL A1-A2 is a bipolar pair after the type word, marked as a normalized join", async () => {
    const { space, labels } = await load("on006233");
    const j = byChannel(joinChannels(space, labels)).get("POL A1-A2") as ChannelJoin;
    const a = contactOf(space, "A1").position as readonly number[];
    const b = contactOf(space, "A2").position as readonly number[];
    expect(j).toMatchObject({
      status: "bipolar",
      contacts: ["A1", "A2"],
      matchKind: "normalized",
      rule: "type_prefix",
    });
    expect(j.position).toEqual([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
  });

  it("on005931: POL A1-AV joins A1 through the type word and the average reference", async () => {
    const { space, labels } = await load("on005931");
    expect(byChannel(joinChannels(space, labels)).get("POL A1-AV")).toMatchObject({
      contacts: ["A1"],
      matchKind: "suffix",
      rule: "type_prefix+average_reference",
    });
  });

  it("on004194: LSF1 joins LSF01; on003848: the zeros are read the other way too (el063 reaches el63, which has no position)", async () => {
    const a = await load("on004194");
    expect(byChannel(joinChannels(a.space, a.labels)).get("LSF1")).toMatchObject({
      contacts: ["LSF01"],
      matchKind: "normalized",
      rule: "leading_zeros",
    });
    const b = await load("on003848");
    const joins = byChannel(joinChannels(b.space, b.labels));
    // The channel writes the index with a zero the file does not. The contact it reaches has n/a
    // coordinates, so it stays unlocated, with that contact named and its own cause.
    expect(joins.get("el063")).toMatchObject({
      status: "unlocated",
      cause: "no_position",
      contacts: ["el63"],
    });
    expect(contactOf(b.space, "el63").position).toBeNull();
    expect(joins.get("FEL1")).toMatchObject({ contacts: ["FEL01"], rule: "leading_zeros" });
  });

  it("zeros never move a letter or a digit: LSF10 stays LSF10", async () => {
    const { space } = await load("on004194");
    expect(joinChannels(space, ["LSF10", "LSF100", "LSF1x"]).map((j) => j.contacts)).toEqual([
      ["LSF10"],
      [],
      [],
    ]);
  });

  it("nm000379: O1-REF1 joins O1 by the named reference", async () => {
    const { space, labels } = await load("nm000379");
    expect(byChannel(joinChannels(space, labels)).get("O1-REF1")).toMatchObject({
      contacts: ["O1"],
      matchKind: "suffix",
      rule: "reference_name",
    });
  });

  it("on007118: A1-AV joins A1 by the average reference", async () => {
    const { space, labels } = await load("on007118");
    const joins = joinChannels(space, labels);
    expect(joins.filter((j) => j.status === "located").length).toBe(labels.length);
    expect(joins[0]).toMatchObject({
      channel: "A1-AV",
      contacts: ["A1"],
      rule: "average_reference",
    });
  });
});

describe("ambiguity refuses", () => {
  it("two contacts that one normalized reading reaches make the channel ambiguous_name, never the first (known-answer contact LSF001)", async () => {
    const { space } = await load("on004194");
    expect(joinChannels(space, ["LSF1"])[0]).toMatchObject({ contacts: ["LSF01"] });
    const both = withContact(space, "LSF01", "LSF001");
    const j = joinChannels(both, ["LSF1"])[0];
    expect(j).toEqual({
      channel: "LSF1",
      status: "unlocated",
      contacts: ["LSF01", "LSF001"],
      position: null,
      cause: "ambiguous_name",
      matchKind: null,
      rule: null,
    });
    // The pure matcher says the same, with the tier it was ambiguous at.
    expect(matchName("LSF1", buildNameIndex(both.contacts.map((c) => c.name)))).toEqual({
      kind: "ambiguous",
      matchKind: "normalized",
      candidates: ["LSF01", "LSF001"],
    });
  });

  it("a numeric tail that continues the shaft reads two ways and joins nothing (known-answer contact LTP20000)", async () => {
    const { space } = await load("on005415-72");
    expect(joinChannels(space, ["LTP1-20000"])[0]).toMatchObject({ contacts: ["LTP1"] });
    const both = withContact(space, "LTP1", "LTP20000");
    const j = joinChannels(both, ["LTP1-20000"])[0];
    expect(j).toMatchObject({ status: "unlocated", cause: "ambiguous_name" });
    expect([...j.contacts].sort()).toEqual(["LTP1", "LTP20000"]);
  });

  it("a name that two zero variants share is ambiguous, one that only one shares is a match", () => {
    const index = buildNameIndex(["A01", "A001", "B01"]);
    expect(matchName("A0001", index)).toEqual({
      kind: "ambiguous",
      matchKind: "normalized",
      candidates: ["A01", "A001"],
    });
    expect(matchName("B1", index)).toEqual({
      kind: "match",
      matchKind: "normalized",
      rule: "leading_zeros",
      contacts: ["B01"],
    });
    // Ambiguity at the suffix tier too: the tail comes off, and what is left reads two ways.
    expect(matchName("A0001-REF1", index)).toMatchObject({
      kind: "ambiguous",
      matchKind: "suffix",
    });
  });
});

describe("close: the tier exists, no rule joins today, and the engine guards every candidate", () => {
  // Rule tables of a test's own (the tier list is data). Each adds a `close` rule the module does
  // not ship; the engine's own check still decides what may join.
  const rule = (id: string, variants: (n: string) => string[]): MatchRule => ({
    id,
    kind: "close",
    form: "variants",
    pattern: "a test rule that proposes names",
    example: { channel: "x", contact: "y" },
    datasets: [],
    sentence: "channel names differ from the contact names",
    variants,
  });

  it("on003374: a deleted shaft letter joins as close; a shaft swapped or two letters deleted does not", async () => {
    const { space } = await load("on003374");
    expect([...names(space)].sort()).toEqual(["mAL1", "mAL2", "mAR1", "mAR2"]);
    const dropFirst = rule("drop_first", (n) => [n.slice(1)]);
    const swapShaft = rule("swap_shaft", () => ["mAL1"]);
    const table = [...MATCH_RULES, dropFirst];
    // mmAL1 -> mAL1: one letter removed from the shaft, the index untouched.
    expect(joinChannels(space, ["mmAL1"], table)[0]).toMatchObject({
      status: "located",
      contacts: ["mAL1"],
      matchKind: "close",
      rule: "drop_first",
    });
    // Another shaft: the rule proposes mAL1 for mBL1, a substitution, and the guard refuses.
    expect(joinChannels(space, ["mBL1"], [...MATCH_RULES, swapShaft])[0]).toMatchObject({
      status: "unlocated",
      cause: "no_contact",
    });
    // Two edits away: mmmAL1 is two letters from mAL1.
    expect(joinChannels(space, ["mmmAL1"], [...MATCH_RULES, swapShaft])[0].status).toBe(
      "unlocated",
    );
    // A different index never joins.
    expect(joinChannels(space, ["mmAL3"], table)[0].status).toBe("unlocated");
    // Without the rule, nothing joins: the shipped table has no close rule.
    expect(joinChannels(space, ["mmAL1"])[0]).toMatchObject({
      status: "unlocated",
      cause: "no_contact",
    });
  });

  it("two candidates at the close tier tie, and the channel is ambiguous_name (real contacts mAL1 and mAR1)", async () => {
    const { space } = await load("on003374");
    const anyDeletion = rule("any_deletion", (n) => {
      const out: string[] = [];
      for (let i = 0; i < n.length; i++) out.push(`${n.slice(0, i)}${n.slice(i + 1)}`);
      return out;
    });
    // mALR1 loses one letter to become mAR1 or mAL1: both are contacts.
    const j = joinChannels(space, ["mALR1"], [...MATCH_RULES, anyDeletion])[0];
    expect(j).toMatchObject({ status: "unlocated", cause: "ambiguous_name" });
    expect([...j.contacts].sort()).toEqual(["mAL1", "mAR1"]);
  });

  it("the guard is exactly one removed shaft character with the same index", () => {
    expect(isOneShaftDeletion("mmAL1", "mAL1")).toBe(true);
    expect(isOneShaftDeletion("mBL1", "mAL1")).toBe(false);
    expect(isOneShaftDeletion("mmmAL1", "mAL1")).toBe(false);
    expect(isOneShaftDeletion("mmAL2", "mAL1")).toBe(false);
    expect(isOneShaftDeletion("mAL1", "mAL1")).toBe(false);
    expect(isOneShaftDeletion("mAL11", "mAL1")).toBe(false);
  });

  it("nm000454: the doubled-letter edit that is right in on003374 would put DHAA01 on the wrong shaft", async () => {
    const { space, labels } = await load("nm000454");
    expect(labels).toContain("DHAA01");
    expect(names(space).has("DHA01")).toBe(true);
    const doubled = rule("doubled", (n) => {
      const out: string[] = [];
      for (let i = 0; i + 1 < n.length; i++) {
        if (n[i] === n[i + 1]) out.push(`${n.slice(0, i)}${n.slice(i + 1)}`);
      }
      return out;
    });
    // With the rule, the channel of a real shaft DHAA lands on contacts of shaft DHA: the evidence
    // that no such rule ships. The shipped table leaves it unlocated.
    expect(joinChannels(space, ["DHAA01"], [...MATCH_RULES, doubled])[0]).toMatchObject({
      matchKind: "close",
      contacts: ["DHA01"],
    });
    expect(joinChannels(space, ["DHAA01"])[0]).toMatchObject({ status: "unlocated" });
    const { space: s2, labels: l2 } = await load("on003374");
    expect(l2).toContain("mmAL1");
    expect(joinChannels(s2, ["mmAL1"])[0].status).toBe("unlocated");
  });
});

describe("a name that only nearly fits a rule joins nothing (known-answer names, contacts A1 and A3)", () => {
  // Two contacts copied from real rows of on005522 under the names the rules read. Every name below
  // is a near miss of a rule's anchor: with the contact present, a loosened anchor would join it.
  const near = [
    "A1-2",
    "A1-9",
    "A1-999",
    "pol A3",
    "Eeg A3",
    "POLA3",
    "XEEG A3",
    "A1-AVG",
    "A1-AV2",
    "A1-av",
    "A1-Reference",
    "A1-Ref+3",
  ];

  it("each near miss is unlocated, and each real form beside it joins", async () => {
    const { space } = await load("on005522");
    const known = spaceNamed(space, [
      ["LAF1", "A1"],
      ["LAF2", "A3"],
    ]);
    for (const name of near) {
      expect(joinChannels(known, [name])[0], name).toMatchObject({
        status: "unlocated",
        cause: "no_contact",
        matchKind: null,
      });
    }
    // The same contacts, the forms the rules do read (one at a time: five forms of A1 in one list
    // would be five claims on one contact, and rightly refuse each other).
    const real: [string, string][] = [
      ["A1-AV", "suffix"],
      ["A1-REF1", "suffix"],
      ["A1-Ref", "suffix"],
      ["A1-20000", "suffix"],
      ["A1-2000", "suffix"],
      ["POL A3", "normalized"],
      ["EEG A3", "normalized"],
      ["EEG  A3", "normalized"],
      ["EEGA3", "normalized"],
    ];
    for (const [name, kind] of real) {
      expect(joinChannels(known, [name])[0], name).toMatchObject({
        status: "located",
        matchKind: kind,
      });
    }
  });
});

describe("zeros never carry a name across shafts", () => {
  it("contacts L1 and L0: L01 is shaft L0 with index 1 as far as the file can say, so it does not join L1", async () => {
    const { space } = await load("on005522");
    const both = spaceNamed(space, [
      ["LAF1", "L1"],
      ["LAF2", "L0"],
    ]);
    expect(joinChannels(both, ["L01"])[0]).toMatchObject({
      status: "unlocated",
      cause: "no_contact",
    });
    // The same padding, with no contact L0 in the file, is only padding.
    const alone = spaceNamed(space, [["LAF1", "L1"]]);
    expect(joinChannels(alone, ["L01"])[0]).toMatchObject({
      status: "located",
      contacts: ["L1"],
      matchKind: "normalized",
      rule: "leading_zeros",
    });
  });

  it("the same guard reads the other direction: contacts L01 and L0, channel L1", async () => {
    const { space } = await load("on005522");
    const both = spaceNamed(space, [
      ["LAF1", "L01"],
      ["LAF2", "L0"],
    ]);
    expect(joinChannels(both, ["L1"])[0]).toMatchObject({ status: "unlocated" });
    const alone = spaceNamed(space, [["LAF1", "L01"]]);
    expect(joinChannels(alone, ["L1"])[0]).toMatchObject({
      contacts: ["L01"],
      rule: "leading_zeros",
    });
  });

  it("the surveyed padding is untouched: LSF1 for LSF01 and el063 for el63", async () => {
    const a = await load("on004194");
    expect(joinChannels(a.space, ["LSF1"])[0]).toMatchObject({ contacts: ["LSF01"] });
    expect(buildNameIndex(["el63"]).find("el063", true)).toEqual(["el63"]);
  });
});

describe("claims: an exact name keeps its contact", () => {
  it("nm000463: AD1_rms never takes the contact of the channel it was derived from", async () => {
    const { space, labels } = await load("nm000463");
    expect(labels).toContain("AD1");
    expect(labels).toContain("AD1_rms");
    // As shipped no rule reads _rms: the copy has no contact.
    const plain = byChannel(joinChannels(space, labels));
    expect(plain.get("AD1")).toMatchObject({ status: "located", matchKind: "exact" });
    expect(plain.get("AD1_rms")).toMatchObject({ status: "unlocated", cause: "no_contact" });
    // Add a rule that would read it (a table of the test's own): the claim still refuses it.
    const rms: MatchRule = {
      id: "rms_copy",
      kind: "suffix",
      form: "strip",
      pattern: "a test rule that removes _rms",
      example: { channel: "AD1_rms", contact: "AD1" },
      datasets: [],
      sentence: "channel names end in _rms",
      strip: (n) => (n.endsWith("_rms") ? n.slice(0, -4) : null),
    };
    const joins = byChannel(joinChannels(space, labels, [...MATCH_RULES, rms]));
    expect(joins.get("AD1")).toMatchObject({
      status: "located",
      matchKind: "exact",
      contacts: ["AD1"],
    });
    expect(joins.get("AD1_rms")).toMatchObject({
      status: "unlocated",
      cause: "duplicate_contact",
      contacts: ["AD1"],
      matchKind: null,
    });
    for (const j of joins.values()) {
      if (j.channel.endsWith("_rms")) expect(j.cause).toBe("duplicate_contact");
    }
  });

  it("two differently written names that reach one contact through the same tier both lose it", async () => {
    const { space } = await load("on005415-72");
    const joins = joinChannels(space, ["LTP1-20000", "LTP1-30000", "LTP2-20000"]);
    expect(joins[0]).toMatchObject({ status: "unlocated", cause: "duplicate_contact" });
    expect(joins[1]).toMatchObject({ status: "unlocated", cause: "duplicate_contact" });
    expect(joins[2]).toMatchObject({ status: "located", contacts: ["LTP2"], matchKind: "suffix" });
  });

  it("the same name twice is one claimant: both stay joined", async () => {
    const { space } = await load("on005415-72");
    const joins = joinChannels(space, ["LTP1-20000", "LTP1-20000"]);
    expect(joins.every((j) => j.status === "located" && j.contacts[0] === "LTP1")).toBe(true);
  });

  it("an exact channel and a suffix channel of one contact: the exact one keeps it", async () => {
    const { space } = await load("on005415-72");
    const joins = joinChannels(space, ["LTP1", "LTP1-20000"]);
    expect(joins[0]).toMatchObject({ status: "located", matchKind: "exact" });
    expect(joins[1]).toMatchObject({ status: "unlocated", cause: "duplicate_contact" });
  });

  it("settleClaims: the strictest tier wins when one name holds it; ties at a non-exact tier refuse all", () => {
    const claim = (channel: number, label: string, kind: Claim["kind"]): Claim => ({
      channel,
      label,
      contacts: ["C1"],
      kind,
    });
    expect(settleClaims([claim(0, "C1", "exact"), claim(1, "C1-x", "suffix")])).toEqual(
      new Set([1]),
    );
    expect(settleClaims([claim(0, "a", "suffix"), claim(1, "b", "suffix")])).toEqual(
      new Set([0, 1]),
    );
    expect(settleClaims([claim(0, "a", "suffix"), claim(1, "a", "suffix")])).toEqual(new Set());
    expect(
      settleClaims([claim(0, "a", "normalized"), claim(1, "b", "suffix"), claim(2, "c", "suffix")]),
    ).toEqual(new Set([1, 2]));
    expect(settleClaims([claim(0, "a", "suffix")])).toEqual(new Set());
  });

  it("settleClaims: a name repeated at the winning tier is one claimant, and the looser claim still loses", () => {
    const claim = (channel: number, label: string, kind: Claim["kind"]): Claim => ({
      channel,
      label,
      contacts: ["C1"],
      kind,
    });
    // The same label twice at the strictest tier wins together; only the lower tier is refused.
    expect(
      settleClaims([claim(0, "a", "suffix"), claim(1, "a", "suffix"), claim(2, "b", "close")]),
    ).toEqual(new Set([2]));
    expect(
      settleClaims([claim(0, "C1", "exact"), claim(1, "C1", "exact"), claim(2, "C1-x", "suffix")]),
    ).toEqual(new Set([2]));
  });

  it("on005415: LTP1 twice keeps both, and LTP1-20000 beside them is refused", async () => {
    const { space } = await load("on005415-72");
    const joins = joinChannels(space, ["LTP1", "LTP1", "LTP1-20000"]);
    expect(joins[0]).toMatchObject({ status: "located", matchKind: "exact" });
    expect(joins[1]).toMatchObject({ status: "located", matchKind: "exact" });
    expect(joins[2]).toMatchObject({ status: "unlocated", cause: "duplicate_contact" });
    // The same suffix name twice is one claimant.
    const twice = joinChannels(space, ["LTP1-20000", "LTP1-20000", "LTP1-30000"]);
    expect(twice.map((j) => j.status)).toEqual(["unlocated", "unlocated", "unlocated"]);
    expect(joinChannels(space, ["LTP1-20000", "LTP1-20000"]).map((j) => j.status)).toEqual([
      "located",
      "located",
    ]);
  });
});

describe("bipolar pairs are claimed too", () => {
  it("on006233: POL A1-A2 does not take the pair that A1-A2 already holds (duplicate_contact, as for one contact)", async () => {
    const { space } = await load("on006233");
    const joins = joinChannels(space, ["A1-A2", "POL A1-A2"]);
    expect(joins[0]).toMatchObject({
      status: "bipolar",
      matchKind: "exact",
      contacts: ["A1", "A2"],
    });
    expect(joins[1]).toEqual({
      channel: "POL A1-A2",
      status: "unlocated",
      contacts: ["A1", "A2"],
      position: null,
      cause: "duplicate_contact",
      matchKind: null,
      rule: null,
    });
    // On its own it joins, as before.
    expect(joinChannels(space, ["POL A1-A2"])[0]).toMatchObject({
      status: "bipolar",
      matchKind: "normalized",
    });
  });

  it("two exact pairs on the same contacts (A1-A2 and A2-A1) both stay, as they do today", async () => {
    const { space } = await load("on006233");
    const joins = joinChannels(space, ["A1-A2", "A2-A1"]);
    expect(joins.map((j) => [j.status, j.matchKind])).toEqual([
      ["bipolar", "exact"],
      ["bipolar", "exact"],
    ]);
  });

  it("opposite polarities: exact A1-A2 and A2-A1 both stay, non-exact POL A1-A2 and POL A2-A1 both refuse (known-answer labels on real contacts)", async () => {
    const { space } = await load("on006233");
    // The refusal is the safe side: two non-exact spellings of one pair cannot be told apart from
    // a duplicate, even when they may be two real channels of opposite polarity. Exact names are
    // unambiguous, so both stay. The pair is keyed by its sorted contacts; this pins both halves.
    const refused = joinChannels(space, ["POL A1-A2", "POL A2-A1"]);
    for (const j of refused) {
      expect(j, j.channel).toMatchObject({
        status: "unlocated",
        cause: "duplicate_contact",
        matchKind: null,
        rule: null,
      });
      expect([...j.contacts].sort()).toEqual(["A1", "A2"]);
    }
    const stay = joinChannels(space, ["A1-A2", "A2-A1"]);
    expect(stay.map((j) => [j.status, j.matchKind])).toEqual([
      ["bipolar", "exact"],
      ["bipolar", "exact"],
    ]);
    // An exact pair also keeps the pair from a non-exact spelling of the opposite polarity.
    const mixed = joinChannels(space, ["A1-A2", "POL A2-A1"]);
    expect(mixed[0]).toMatchObject({ status: "bipolar", matchKind: "exact" });
    expect(mixed[1]).toMatchObject({ status: "unlocated", cause: "duplicate_contact" });
    // Alone, either opposite spelling joins.
    expect(joinChannels(space, ["POL A2-A1"])[0]).toMatchObject({
      status: "bipolar",
      contacts: ["A2", "A1"],
      matchKind: "normalized",
    });
  });

  it("two differently written non-exact names for one pair both lose it", async () => {
    const { space } = await load("on006233");
    const joins = joinChannels(space, ["POL A1-A2", "EEG A1-A2", "POL A3-A4"]);
    expect(joins[0]).toMatchObject({ status: "unlocated", cause: "duplicate_contact" });
    expect(joins[1]).toMatchObject({ status: "unlocated", cause: "duplicate_contact" });
    expect(joins[2]).toMatchObject({ status: "bipolar", contacts: ["A3", "A4"] });
  });

  it("a contact and a pair never compete: A1 and POL A1-A2 both join", async () => {
    const { space } = await load("on006233");
    const joins = joinChannels(space, ["A1", "POL A1-A2"]);
    expect(joins.map((j) => j.status)).toEqual(["located", "bipolar"]);
  });
});

describe("what the survey saw and this module does not join", () => {
  it("every pending pattern has a reason, a pattern, an example and a unique id", () => {
    const ids = PENDING_PATTERNS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(ruleById(id), `${id} is both a rule and pending`).toBeUndefined();
    for (const p of PENDING_PATTERNS) {
      expect(p.pattern.length, p.id).toBeGreaterThan(15);
      expect(p.reason.length, p.id).toBeGreaterThan(60);
      expect(p.example.channels.length + p.example.contacts.length, p.id).toBeGreaterThan(0);
    }
  });

  it("each pending example is real, and the module leaves its channels unlocated", async () => {
    const homes = new Map<string, string[]>();
    for (const [key, c] of Object.entries(CASES))
      homes.set(c.id, [...(homes.get(c.id) ?? []), key]);
    for (const p of PENDING_PATTERNS) {
      const keys = p.datasets.flatMap((d) => homes.get(d) ?? []);
      if (p.datasets.length === 0) continue;
      expect(
        keys.length,
        `${p.id}: a committed recording of ${p.datasets.join(", ")}`,
      ).toBeGreaterThan(0);
      const seenChannels = new Set<string>();
      const seenContacts = new Set<string>();
      for (const key of keys) {
        const l = await load(key);
        const joins = byChannel(joinChannels(l.space, l.labels));
        for (const ch of p.example.channels) {
          if (!l.labels.includes(ch)) continue;
          seenChannels.add(ch);
          expect(joins.get(ch)?.status, `${p.id}: ${ch} in ${key}`).toBe("unlocated");
        }
        for (const c of p.example.contacts) if (names(l.space).has(c)) seenContacts.add(c);
      }
      for (const ch of p.example.channels) {
        expect(seenChannels.has(ch), `${p.id}: channel ${ch} is in a committed recording`).toBe(
          true,
        );
      }
      for (const c of p.example.contacts) {
        expect(seenContacts.has(c), `${p.id}: contact ${c} is in a committed electrodes file`).toBe(
          true,
        );
      }
    }
  });

  it("on004624: CH1 stays unlocated although Ch1 is a contact, because the labels start at CH0", async () => {
    const { space, labels } = await load("on004624");
    // The evidence as the pending entry states it: CH0 to CH31 and four state_* channels, 36 in all,
    // against contacts Ch1 to Ch32.
    const ch = labels.filter((l) => /^CH\d+$/.test(l)).map((l) => Number(l.slice(2)));
    expect([Math.min(...ch), Math.max(...ch), ch.length]).toEqual([0, 31, 32]);
    expect(labels.filter((l) => l.startsWith("state_"))).toHaveLength(4);
    expect(labels).toHaveLength(36);
    expect(names(space).size).toBe(32);
    const reason = (PENDING_PATTERNS.find((p) => p.id === "case_only") as { reason: string })
      .reason;
    expect(reason).toContain("CH0 to CH31");
    expect(reason).toContain("state_*");
    expect(reason).toContain("36 in all");
    expect(reason).not.toContain("CH35");
    expect(labels).toContain("CH0");
    expect(labels).toContain("CH1");
    expect(names(space).has("Ch1")).toBe(true);
    expect(names(space).has("Ch0")).toBe(false);
    expect(byChannel(joinChannels(space, labels)).get("CH1")?.status).toBe("unlocated");
  });

  it("channels named only by position or by lead join nothing (nm000377, nm000436, on006136, on005953, on005670)", async () => {
    for (const key of ["nm000377", "nm000436", "on006136", "on005953"]) {
      const { space, labels } = await load(key);
      const joins = joinChannels(space, labels);
      expect(joins.filter((j) => j.status !== "unlocated").length, key).toBe(0);
    }
    const { space, labels } = await load("on005670");
    expect(byChannel(joinChannels(space, labels)).get("POL A'1")?.status).toBe("unlocated");
  });
});

describe("a join that is exact today is exact now", () => {
  it("over every committed recording, an exact name or an exact pair joins as before", async () => {
    let exact = 0;
    let pairs = 0;
    for (const key of Object.keys(CASES)) {
      const { space, labels } = await load(key);
      const contactNames = names(space);
      const counts = new Map<string, number>();
      for (const c of space.contacts) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
      for (const j of joinChannels(space, labels)) {
        if (contactNames.has(j.channel) && counts.get(j.channel) === 1) {
          const position = contactOf(space, j.channel).position;
          if (position === null) continue;
          expect(j, `${key}: ${j.channel}`).toMatchObject({
            status: "located",
            matchKind: "exact",
            rule: null,
            contacts: [j.channel],
          });
          exact += 1;
          continue;
        }
        const splits: [string, string][] = [];
        for (let i = 0; i < j.channel.length; i++) {
          if (j.channel[i] !== "-") continue;
          const l = j.channel.slice(0, i).trim();
          const r = j.channel.slice(i + 1).trim();
          if (l && r && l !== r && contactNames.has(l) && contactNames.has(r)) splits.push([l, r]);
        }
        if (splits.length === 1 && !contactNames.has(j.channel) && j.status === "bipolar") {
          expect(j.matchKind, `${key}: ${j.channel}`).toBe("exact");
          expect(j.contacts).toEqual(splits[0]);
          pairs += 1;
        }
      }
    }
    expect(exact).toBeGreaterThan(500);
    expect(pairs).toBeGreaterThan(50);
  });
});

describe("names and indexes", () => {
  it("zeroKey drops leading zeros of the trailing index and keeps one digit", () => {
    expect(zeroKey("LSF01")).toBe("LSF1");
    expect(zeroKey("LSF1")).toBe("LSF1");
    expect(zeroKey("A00")).toBe("A0");
    expect(zeroKey("A10")).toBe("A10");
    expect(zeroKey("A")).toBe("A");
    expect(zeroKey("0")).toBe("0");
    expect(zeroKey("A0B1")).toBe("A0B1");
  });

  it("the index counts every row of a name and finds zero variants only when asked", () => {
    const index = buildNameIndex(["A1", "A1", "B01"]);
    expect(index.count("A1")).toBe(2);
    expect(index.count("B01")).toBe(1);
    expect(index.find("B1", false)).toEqual([]);
    expect(index.find("B1", true)).toEqual(["B01"]);
    expect(index.find("A1", true)).toEqual(["A1"]);
  });
});

describe("fixture provenance", () => {
  interface Source {
    dataset: string;
    version: string;
    kind: "file" | "listing" | "zarr-labels";
    path: string;
    stored_as: string;
    url: string;
    bytes: number;
    sha256: string;
    upstream_sha256?: string;
  }
  const sources = JSON.parse(fs.readFileSync(repoPath(`${FIX}/SOURCES.json`), "utf8")) as {
    files: Source[];
  };

  it("names dataset, version, path, URL and SHA-256 for every file, and each hash recomputes", async () => {
    expect(sources.files.length).toBeGreaterThan(100);
    for (const s of sources.files) {
      expect(s.dataset && s.version && s.path && s.url && s.sha256, s.stored_as).toBeTruthy();
      expect(s.url, s.stored_as).toMatch(/^https:\/\/(data|zarr)\.nemar\.org\//);
      const bytes = fs.readFileSync(repoPath(`${FIX}/${s.stored_as}`));
      expect(bytes.byteLength, s.stored_as).toBe(s.bytes);
      expect(await sha256Hex(bytes), s.stored_as).toBe(s.sha256);
      if (s.kind === "zarr-labels")
        expect(s.upstream_sha256, s.stored_as).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("lists every file under the fixture directory", () => {
    const listed = new Set(sources.files.map((s) => s.stored_as));
    const walk = (dir: string): string[] =>
      fs.readdirSync(repoPath(`${FIX}/${dir}`)).flatMap((entry) => {
        const rel = dir === "" ? entry : `${dir}/${entry}`;
        return fs.statSync(repoPath(`${FIX}/${rel}`)).isDirectory() ? walk(rel) : [rel];
      });
    const onDisk = walk("").filter((p) => p !== "SOURCES.json");
    expect(onDisk.sort()).toEqual([...listed].sort());
  });

  it("holds at most 1 MB", () => {
    expect(sources.files.reduce((n, s) => n + s.bytes, 0)).toBeLessThan(1024 * 1024);
  });
});
