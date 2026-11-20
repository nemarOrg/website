import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { repoPath } from "../../../test/node";
import { buildNameIndex, matchName, splitPairs, zeroKey } from "./channel-match";
import { type ChannelJoin, type SpaceGeometry, joinChannels } from "./geometry";

/**
 * The channel-electrode name map after the 2026-11-20 owner decision: collaborator pull requests
 * rename the rows of channels.tsv to the labels of the recording headers (`A1` to `POL A1-AV`,
 * `EEG G_03-REF`, `EEGGA_01REF`, `EEG M2-Ref`) while electrodes.tsv keeps the contact names
 * (`A1`, `G03`, `GA01`).
 *
 * Real files only. test/fixtures/ieeg-channel-renames holds, per dataset, the name columns of
 * recordings' channels.tsv and electrodes.tsv as they stand on the `fix-20261018` pull request of
 * the nemarDatasets repository (commit and SHA-256 of each whole file in the fixture). Rows the
 * rules must refuse are the files' own rows too (`POL $A11`, `POL DC01`); the few known-answer
 * names, marked as such, are for refusals no surveyed file shows.
 */

interface Recording {
  channels_path: string;
  electrodes_path: string;
  channels: string[];
  contacts: string[];
}
interface Fixture {
  dataset: string;
  commit: string;
  recordings: Recording[];
}

const DIR = repoPath("test/fixtures/ieeg-channel-renames");
const EXPECTED = `${DIR}/_expected-joins.json`;
/** SHA-256 of `_expected-joins.json`; the same file and digest are asserted in nemar-cli. */
const EXPECTED_SHA256 = "9a9aa2aa451f27ef98bdac2ad897d4cbe484e3e0ba59a39acc3b6ca210be580f";
const fixtures: Fixture[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
  .sort()
  .map((f) => JSON.parse(readFileSync(`${DIR}/${f}`, "utf8")) as Fixture);

function spaceOf(contacts: readonly string[]): SpaceGeometry {
  return {
    contacts: contacts.map((name, row) => ({
      name,
      position: [row, 0, 0] as const,
      row,
    })),
  } as unknown as SpaceGeometry;
}

const located = (joins: ChannelJoin[]) => joins.filter((j) => j.status !== "unlocated");

/** The recording of a dataset whose channels file ends with `suffix`. */
function recording(dataset: string, suffix: string): Recording {
  const fixture = fixtures.find((f) => f.dataset === dataset);
  const found = fixture?.recordings.find((r) => r.channels_path.endsWith(suffix));
  expect(found, `${dataset} ${suffix}`).toBeDefined();
  return found as Recording;
}

/**
 * Per recording: channels, contacts, channels joined by their exact name alone, channels joined by
 * the rules, bipolar channels among them, and the distinct contacts they reach. The exact column is
 * what the renamed files lose; the located columns are what the map gives back.
 */
const TABLE: [dataset: string, file: string, counts: number[]][] = [
  [
    "on004194",
    "sub-p04_ses-nyuecog01_task-prf_acq-clinical_run-01_channels.tsv",
    [124, 104, 0, 104, 0, 104],
  ],
  [
    "on004194",
    "sub-p05_ses-nyuecog01_task-prf_acq-clinical_run-01_channels.tsv",
    [206, 174, 0, 174, 0, 174],
  ],
  ["on004551", "sub-012_ses-01_task-sleep_run-01_channels.tsv", [123, 108, 0, 108, 0, 108]],
  ["on005007", "sub-06_ses-01_task-namingtask_run-01_channels.tsv", [88, 44, 0, 44, 0, 44]],
  ["on005007", "sub-13_ses-01_task-namingtask_run-01_channels.tsv", [103, 67, 0, 67, 0, 67]],
  ["on005545", "sub-48_ses-01_task-auditory_run-01_channels.tsv", [49, 118, 0, 47, 47, 54]],
  ["on005545", "sub-84_ses-03_task-auditory_run-01_channels.tsv", [66, 132, 0, 64, 64, 64]],
  ["on005931", "sub-06_ses-02_task-game_run-01_channels.tsv", [64, 95, 0, 62, 0, 62]],
  ["on006107", "sub-29_ses-01_task-sws_run-01_channels.tsv", [106, 106, 0, 106, 0, 106]],
  ["on006233", "sub-045_ses-3_task-picture_channels.tsv", [49, 112, 0, 47, 47, 55]],
  ["on006914", "sub-045_ses-3_task-picture_channels.tsv", [49, 112, 0, 47, 47, 55]],
];

describe("the renamed channels of the fix-20261018 pull requests find their contacts", () => {
  it("carries a fixture for every dataset of the decision", () => {
    expect(fixtures.map((f) => f.dataset)).toEqual([
      "on004194",
      "on004551",
      "on005007",
      "on005545",
      "on005931",
      "on006107",
      "on006233",
      "on006914",
    ]);
  });

  for (const [dataset, file, counts] of TABLE) {
    it(`${dataset} ${file}: the exact name joins ${counts[2]}, the rules join ${counts[3]}`, () => {
      const r = recording(dataset, file);
      const space = spaceOf(r.contacts);
      const exact = joinChannels(space, r.channels, []);
      const joins = joinChannels(space, r.channels);
      const reached = new Set(located(joins).flatMap((j) => j.contacts));
      expect([
        r.channels.length,
        r.contacts.length,
        located(exact).length,
        located(joins).length,
        joins.filter((j) => j.status === "bipolar").length,
        reached.size,
      ]).toEqual(counts);
    });
  }

  it("gives, channel by channel, the join map both repositories commit (digest pinned)", () => {
    const raw = readFileSync(EXPECTED);
    expect(createHash("sha256").update(raw).digest("hex")).toBe(EXPECTED_SHA256);
    const expected = JSON.parse(raw.toString("utf8")) as Record<
      string,
      Record<string, string[] | "refused">
    >;
    const actual: typeof expected = {};
    for (const f of fixtures) {
      for (const r of f.recordings) {
        const map: Record<string, string[] | "refused"> = {};
        for (const j of joinChannels(spaceOf(r.contacts), r.channels)) {
          map[j.channel] = j.status === "unlocated" ? "refused" : [...j.contacts].sort();
        }
        actual[`${f.dataset}/${r.channels_path}`] = map;
      }
    }
    expect(actual).toEqual(expected);
  });

  it("never puts a channel on a contact of another shaft, and no two names share one contact", () => {
    // Type word and reference token off, then the shaft letters alone: they must EQUAL the contact's
    // (per half for a bipolar pair), not merely contain them.
    const bare = (name: string) =>
      name.replace(/^(?:EEG|POL) */, "").replace(/(?:-ref\d*|-av|(?<=\d)ref\d*)$/i, "");
    const shaft = (name: string) => name.replace(/[^A-Za-z]/g, "").toUpperCase();
    for (const f of fixtures) {
      for (const r of f.recordings) {
        const joins = joinChannels(spaceOf(r.contacts), r.channels);
        const claimants = new Map<string, Set<string>>();
        for (const j of located(joins)) {
          const halves = j.contacts.length === 2 ? bare(j.channel).split("-") : [bare(j.channel)];
          expect(halves.length, `${f.dataset} ${j.channel}`).toBe(j.contacts.length);
          for (const [i, c] of j.contacts.entries()) {
            expect(shaft(halves[i]), `${f.dataset} ${j.channel}`).toBe(shaft(c));
            if (j.status === "located") {
              const names = claimants.get(c) ?? new Set<string>();
              names.add(j.channel);
              claimants.set(c, names);
            }
          }
        }
        for (const [contact, names] of claimants) {
          expect(names.size, `${f.dataset} ${contact}`).toBe(1);
        }
      }
    }
  });

  it("leaves unlocated only a channel that an independent reading finds no contact for", () => {
    // The reading here is written apart from the module's: lower case, type word and reference
    // token off, underscore and leading zeros off. A channel it reaches a contact for, or a pair of,
    // must be located; the rest (auxiliary channels, scalp channels, contacts the file lacks, the $
    // marker) are no_contact.
    const key = (name: string) =>
      name
        .replace(/^(pol|eeg)\s*/i, "")
        .replace(/(-ref\d*|-av|(?<=\d)ref\d*)$/i, "")
        .replace(/_/g, "")
        .toLowerCase()
        .replace(/(?<=\D)0+(?=\d+$)/, "");
    for (const f of fixtures) {
      for (const r of f.recordings) {
        const keys = new Set(r.contacts.map(key));
        for (const j of joinChannels(spaceOf(r.contacts), r.channels)) {
          const reads =
            keys.has(key(j.channel)) ||
            key(j.channel)
              .split("-")
              .filter((half) => half !== "")
              .every((half, _, all) => all.length === 2 && keys.has(half));
          if (j.status === "unlocated") {
            expect(j.cause, `${f.dataset} ${j.channel}`).toBe("no_contact");
            expect(reads, `${f.dataset} ${j.channel}`).toBe(false);
          } else {
            expect(reads, `${f.dataset} ${j.channel}`).toBe(true);
          }
        }
      }
    }
  });
});

describe("each rule on the names of the files", () => {
  const join = (r: Recording, name: string): ChannelJoin => {
    expect(r.channels, name).toContain(name);
    return joinChannels(spaceOf(r.contacts), [name])[0];
  };
  const p04 = recording(
    "on004194",
    "sub-p04_ses-nyuecog01_task-prf_acq-clinical_run-01_channels.tsv",
  );
  const p05 = recording(
    "on004194",
    "sub-p05_ses-nyuecog01_task-prf_acq-clinical_run-01_channels.tsv",
  );

  it("reads an underscore before the index, a type word and a reference as G_03 for G03 (on004194)", () => {
    expect(join(p04, "EEG G_03-REF")).toMatchObject({
      status: "located",
      contacts: ["G03"],
      matchKind: "suffix",
      rule: "type_prefix+reference_name+leading_zeros",
    });
  });

  it("reads EEG run into the shaft and REF with no hyphen as GA_01 for GA01 (on004194)", () => {
    expect(join(p05, "EEGGA_01REF")).toMatchObject({
      status: "located",
      contacts: ["GA01"],
      matchKind: "suffix",
      rule: "type_prefix+reference_name+leading_zeros",
    });
  });

  it("reads POL A3 and EEG A1-Ref for A3 and A1 (on004551)", () => {
    const r = recording("on004551", "sub-012_ses-01_task-sleep_run-01_channels.tsv");
    expect(join(r, "POL A3")).toMatchObject({ contacts: ["A3"], matchKind: "normalized" });
    expect(join(r, "EEG A1-Ref")).toMatchObject({ contacts: ["A1"], matchKind: "suffix" });
  });

  it("reads EEG A2-Ref for A2, and leaves EEG M2-Ref unlocated where the file has no M2 (on005007)", () => {
    const r = recording("on005007", "sub-06_ses-01_task-namingtask_run-01_channels.tsv");
    expect(join(r, "EEG A2-Ref")).toMatchObject({ contacts: ["A2"], matchKind: "suffix" });
    expect(r.contacts).not.toContain("M2");
    expect(join(r, "EEG M2-Ref")).toMatchObject({ status: "unlocated", cause: "no_contact" });
  });

  it("reads a bipolar channel as its two contacts, with the midpoint of the pair (on005545, on006233)", () => {
    const r = recording("on005545", "sub-48_ses-01_task-auditory_run-01_channels.tsv");
    const pair = join(r, "POL A1-A2");
    expect(pair).toMatchObject({
      status: "bipolar",
      contacts: ["A1", "A2"],
      matchKind: "normalized",
    });
    const space = spaceOf(r.contacts);
    const a1 = space.contacts[r.contacts.indexOf("A1")].position as readonly number[];
    const a2 = space.contacts[r.contacts.indexOf("A2")].position as readonly number[];
    expect(pair.position).toEqual([(a1[0] + a2[0]) / 2, (a1[1] + a2[1]) / 2, (a1[2] + a2[2]) / 2]);
    const six = recording("on006233", "sub-045_ses-3_task-picture_channels.tsv");
    expect(join(six, "POL B10-B18")).toMatchObject({ status: "bipolar", contacts: ["B10", "B18"] });
  });

  it("reads a bipolar channel written without the zeros the contacts carry: B1-B2 for B01 and B02 (on005545)", () => {
    const r = recording("on005545", "sub-84_ses-03_task-auditory_run-01_channels.tsv");
    expect(r.contacts).toEqual(expect.arrayContaining(["B01", "B02"]));
    expect(join(r, "POL B1-B2")).toMatchObject({
      status: "bipolar",
      contacts: ["B01", "B02"],
      matchKind: "normalized",
      rule: "type_prefix+leading_zeros",
    });
  });

  it("reads -AV after the type word and without it: POL B1-AV and A1-AV (on005931, on006107)", () => {
    const a = recording("on005931", "sub-06_ses-02_task-game_run-01_channels.tsv");
    expect(join(a, "POL B1-AV")).toMatchObject({
      contacts: ["B1"],
      rule: "type_prefix+average_reference",
    });
    const b = recording("on006107", "sub-29_ses-01_task-sws_run-01_channels.tsv");
    expect(join(b, "A1-AV")).toMatchObject({ contacts: ["A1"], rule: "average_reference" });
  });

  it("does not read the $ marker (the survey's polarity_marker stays a pending pattern, on004551)", () => {
    const r = recording("on004551", "sub-012_ses-01_task-sleep_run-01_channels.tsv");
    expect(join(r, "POL $A11")).toMatchObject({ status: "unlocated", cause: "no_contact" });
  });
});

describe("the pieces of the rule, with known-answer names beside the files' own", () => {
  it("zeroKey drops an underscore before the index and the zeros after it: G_03, G03 and G3 are one key", () => {
    expect(zeroKey("G_03")).toBe("G3");
    expect(zeroKey("G03")).toBe("G3");
    expect(zeroKey("G3")).toBe("G3");
    // An underscore inside a name, not before the index, stays (nm000436 names such as Ant_d10a).
    expect(zeroKey("Ant_d10a")).toBe("Ant_d10a");
    expect(zeroKey("Ant_d10")).toBe("Ant_d10");
    // An underscore after a digit is part of the name: G1_2 is not G12, GRID_1_2 is not GRID_12.
    expect(zeroKey("G1_2")).not.toBe(zeroKey("G12"));
    expect(zeroKey("GRID_1_2")).not.toBe(zeroKey("GRID_12"));
    expect(matchName("G12", buildNameIndex(["G1_2"]))).toEqual({ kind: "none" });
    expect(matchName("G1_2", buildNameIndex(["G12"]))).toEqual({ kind: "none" });
    expect(matchName("GRID_12", buildNameIndex(["GRID_1_2"]))).toEqual({ kind: "none" });
    expect(matchName("GRID_1_2", buildNameIndex(["GRID_12"]))).toEqual({ kind: "none" });
  });

  it("matches the other way round: a contact written G_03 is reached by the channel G03 and by G3", () => {
    const index = buildNameIndex(["G_03", "G_04"]);
    expect(matchName("G3", index)).toMatchObject({ kind: "match", contacts: ["G_03"] });
    expect(matchName("EEG G04-REF", index)).toMatchObject({ kind: "match", contacts: ["G_04"] });
  });

  it("reads only ASCII digits as digits (U+0661 is no index), as nemar-cli does", () => {
    expect(matchName("A\u0661", buildNameIndex(["A1"]))).toEqual({ kind: "none" });
    expect(matchName("A01REF", buildNameIndex(["A\u0661"]))).toEqual({ kind: "none" });
  });

  it("reads the upper-case type word, with EEG run into a letter but POL only with a space", () => {
    const index = buildNameIndex(["A1", "A3", "AR1"]);
    // No dataset writes another case: lower and mixed case stay unread (owner decision 2026-11-20).
    expect(matchName("pol A3", index)).toEqual({ kind: "none" });
    expect(matchName("Eeg A3", index)).toEqual({ kind: "none" });
    expect(matchName("EEGA3", index)).toMatchObject({ kind: "match", contacts: ["A3"] });
    // POLAR1 is no `POL AR1`: with no space the word is part of the name (known-answer name).
    expect(matchName("POLAR1", index)).toEqual({ kind: "none" });
    // A bare digit after EEG is an index, not a shaft.
    expect(matchName("EEG3", buildNameIndex(["3"]))).toEqual({ kind: "none" });
  });

  it("reads REF after the index only: GA_01REF, not a name that merely ends in REF", () => {
    const index = buildNameIndex(["GA01", "P", "LP1"]);
    expect(matchName("GA_01REF", index)).toMatchObject({
      kind: "match",
      contacts: ["GA01"],
      rule: "reference_name+leading_zeros",
    });
    // PREF is not P with a reference (known-answer name).
    expect(matchName("PREF", index)).toEqual({ kind: "none" });
  });

  it("splits a pair of exact names as before, and with zeros only when asked", () => {
    const index = buildNameIndex(["B01", "B02", "A1", "A2"]);
    expect(splitPairs("A1-A2", index)).toEqual([["A1", "A2"]]);
    expect(splitPairs("B1-B2", index)).toEqual([]);
    expect(splitPairs("B1-B2", index, true)).toEqual([["B01", "B02"]]);
    // A half that two contacts could be (B01 and B001) is no half.
    expect(splitPairs("B1-B2", buildNameIndex(["B01", "B001", "B02"]), true)).toEqual([]);
  });

  it("refuses two differently written channels that reach one contact, and an exact name keeps its own", () => {
    const space = spaceOf(["A1", "A2"]);
    const both = joinChannels(space, ["POL A1", "EEG A1"]);
    expect(both.map((j) => [j.status, j.cause])).toEqual([
      ["unlocated", "duplicate_contact"],
      ["unlocated", "duplicate_contact"],
    ]);
    const exact = joinChannels(space, ["A1", "POL A1"]);
    expect(exact.map((j) => j.status)).toEqual(["located", "unlocated"]);
  });
});
