import { describe, expect, it } from "vitest";
import {
  type ChannelAnnotation,
  type TimeAnnotation,
  assignOverlapLanes,
  channelsTsvFilename,
  createChannelAnnotation,
  createTimeAnnotation,
  emptyAnnotationSet,
  eventsTsvFilename,
  findTimeOverlaps,
  formatHed,
  formatSeconds,
  hedShortForm,
  isAnnotationSetEmpty,
  newAnnotationId,
  normalizeRange,
  recordingStem,
  removeChannelAnnotation,
  removeTimeAnnotation,
  serializeChannelsTsv,
  serializeEventsTsv,
  sortChannelAnnotations,
  sortTimeAnnotations,
  timeAnnotationsInWindow,
  timeAnnotationsOverlap,
  upsertChannelAnnotation,
  upsertChannelAnnotations,
  upsertTimeAnnotation,
} from "./annotations";

/** Realistic tags: the paths the generated bundle actually carries. */
const SEIZURE = "sc:Episode/Epileptic-seizure";
const SPIKE = "sc:Feature-property/Signal-morphology-property/Spike";
const BLINK =
  "Property/Data-property/Data-artifact/Biological-artifact/Eye-artifact/Eye-blink-artifact";
const LINE_NOISE =
  "Property/Data-property/Data-artifact/Nonbiological-artifact/Line-noise-artifact";

const AT = 1_750_000_000_000; // fixed "now" so createdAt/updatedAt are stable

function timeAnnotation(
  id: string,
  onsetS: number,
  durationS: number,
  extra: Partial<TimeAnnotation> = {},
): TimeAnnotation {
  return createTimeAnnotation(
    { id, onsetS, durationS, hedTags: extra.hedTags, description: extra.description },
    AT,
  );
}

describe("newAnnotationId", () => {
  it("produces distinct ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newAnnotationId()));
    expect(ids.size).toBe(200);
  });
});

describe("normalizeRange", () => {
  it("keeps a forward drag as-is", () => {
    expect(normalizeRange(10, 14.5)).toEqual({ onsetS: 10, durationS: 4.5 });
  });

  it("treats a backwards drag as the same range", () => {
    expect(normalizeRange(14.5, 10)).toEqual({ onsetS: 10, durationS: 4.5 });
  });

  it("turns a click (no travel) into a zero-duration marker", () => {
    expect(normalizeRange(7.25, 7.25)).toEqual({ onsetS: 7.25, durationS: 0 });
  });

  it("clamps a drag that ran off the left edge without stretching it", () => {
    expect(normalizeRange(-3, 2)).toEqual({ onsetS: 0, durationS: 2 });
  });

  it("collapses a wholly negative drag to a marker at zero", () => {
    expect(normalizeRange(-9, -4)).toEqual({ onsetS: 0, durationS: 0 });
  });
});

describe("createTimeAnnotation", () => {
  it("clamps a negative onset and duration", () => {
    const a = createTimeAnnotation({ onsetS: -5, durationS: -2 }, AT);
    expect(a.onsetS).toBe(0);
    expect(a.durationS).toBe(0);
  });

  it("replaces a non-finite number rather than storing NaN", () => {
    const a = createTimeAnnotation({ onsetS: Number.NaN, durationS: Number.NaN }, AT);
    expect(a.onsetS).toBe(0);
    expect(a.durationS).toBe(0);
  });

  it("de-duplicates tags but keeps pick order", () => {
    const a = createTimeAnnotation(
      { onsetS: 1, durationS: 0, hedTags: [SPIKE, SEIZURE, SPIKE, "  "] },
      AT,
    );
    expect(a.hedTags).toEqual([SPIKE, SEIZURE]);
  });

  it("strips tabs and newlines from free text so a cell cannot break the table", () => {
    const a = createTimeAnnotation(
      { onsetS: 1, durationS: 0, description: "left\ttemporal\nrun of  spikes " },
      AT,
    );
    expect(a.description).toBe("left temporal run of spikes");
  });

  it("stamps createdAt and updatedAt from the supplied clock", () => {
    const a = createTimeAnnotation({ onsetS: 1, durationS: 0 }, AT);
    expect(a.createdAt).toBe(AT);
    expect(a.updatedAt).toBe(AT);
  });
});

describe("createChannelAnnotation", () => {
  it("defaults to bad, which is what the montage marking means", () => {
    expect(createChannelAnnotation({ channel: "T7" }, AT).status).toBe("bad");
  });

  it("trims the channel label", () => {
    expect(createChannelAnnotation({ channel: " Fp1 " }, AT).channel).toBe("Fp1");
  });

  it("keeps an explicit good status", () => {
    expect(createChannelAnnotation({ channel: "Cz", status: "good" }, AT).status).toBe("good");
  });
});

describe("sorting", () => {
  it("orders time annotations by onset, then duration, then id", () => {
    const list = [
      timeAnnotation("c", 12, 3),
      timeAnnotation("a", 4, 2),
      timeAnnotation("b", 4, 0),
      timeAnnotation("d", 4, 0),
    ];
    expect(sortTimeAnnotations(list).map((a) => a.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("does not mutate the input list", () => {
    const list = [timeAnnotation("b", 9, 0), timeAnnotation("a", 1, 0)];
    sortTimeAnnotations(list);
    expect(list.map((a) => a.id)).toEqual(["b", "a"]);
  });

  it("orders channel annotations by label", () => {
    const list = [
      createChannelAnnotation({ id: "1", channel: "T8" }, AT),
      createChannelAnnotation({ id: "2", channel: "Fp1" }, AT),
      createChannelAnnotation({ id: "3", channel: "Cz" }, AT),
    ];
    expect(sortChannelAnnotations(list).map((a) => a.channel)).toEqual(["Cz", "Fp1", "T8"]);
  });
});

describe("upsert and remove", () => {
  it("replaces a time annotation with the same id", () => {
    const first = timeAnnotation("x", 5, 1);
    const list = upsertTimeAnnotation([], first);
    const edited = timeAnnotation("x", 5, 4, { hedTags: [SEIZURE] });
    const next = upsertTimeAnnotation(list, edited);
    expect(next).toHaveLength(1);
    expect(next[0].durationS).toBe(4);
  });

  it("keeps the result sorted after an insert", () => {
    let list: TimeAnnotation[] = [];
    list = upsertTimeAnnotation(list, timeAnnotation("late", 30, 0));
    list = upsertTimeAnnotation(list, timeAnnotation("early", 2, 0));
    expect(list.map((a) => a.id)).toEqual(["early", "late"]);
  });

  it("removes by id and leaves the rest alone", () => {
    const list = [timeAnnotation("a", 1, 0), timeAnnotation("b", 2, 0)];
    expect(removeTimeAnnotation(list, "a").map((x) => x.id)).toEqual(["b"]);
    expect(removeTimeAnnotation(list, "missing")).toHaveLength(2);
  });

  it("keeps at most one channel annotation per channel", () => {
    let list: ChannelAnnotation[] = [];
    list = upsertChannelAnnotation(list, createChannelAnnotation({ channel: "T7" }, AT));
    list = upsertChannelAnnotation(
      list,
      createChannelAnnotation({ channel: "T7", hedTags: [LINE_NOISE] }, AT),
    );
    expect(list).toHaveLength(1);
    expect(list[0].hedTags).toEqual([LINE_NOISE]);
  });

  it("applies one description to a whole selection", () => {
    const list = upsertChannelAnnotations(
      [],
      ["T7", "T8", "Fp1"],
      { hedTags: [LINE_NOISE], description: "50 Hz pickup" },
      AT,
    );
    expect(list.map((a) => a.channel)).toEqual(["Fp1", "T7", "T8"]);
    for (const a of list) {
      expect(a.hedTags).toEqual([LINE_NOISE]);
      expect(a.description).toBe("50 Hz pickup");
      expect(a.status).toBe("bad");
    }
  });

  it("preserves id and createdAt when re-annotating an existing channel", () => {
    const first = upsertChannelAnnotations([], ["T7"], { description: "noisy" }, AT);
    const second = upsertChannelAnnotations(first, ["T7"], { description: "flat" }, AT + 60_000);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].createdAt).toBe(AT);
    expect(second[0].updatedAt).toBe(AT + 60_000);
    expect(second[0].description).toBe("flat");
  });

  it("removes a channel annotation by id", () => {
    const list = upsertChannelAnnotations([], ["T7", "T8"], {}, AT);
    expect(removeChannelAnnotation(list, list[0].id).map((a) => a.channel)).toEqual(["T8"]);
  });
});

describe("timeAnnotationsInWindow", () => {
  const list = [
    timeAnnotation("before", 1, 2), // 1..3
    timeAnnotation("straddle-start", 8, 4), // 8..12
    timeAnnotation("inside", 12, 1), // 12..13
    timeAnnotation("marker-inside", 14, 0),
    timeAnnotation("marker-after", 25, 0),
  ];

  it("keeps spans that intersect the window", () => {
    const ids = timeAnnotationsInWindow(list, 10, 20).map((a) => a.id);
    expect(ids).toEqual(["straddle-start", "inside", "marker-inside"]);
  });

  it("excludes an annotation that ends before the window", () => {
    expect(timeAnnotationsInWindow(list, 10, 20).some((a) => a.id === "before")).toBe(false);
  });

  it("excludes an annotation that starts at or after the window end", () => {
    expect(timeAnnotationsInWindow(list, 10, 14).map((a) => a.id)).toEqual([
      "straddle-start",
      "inside",
    ]);
  });
});

describe("overlap", () => {
  it("counts two spans sharing seconds as overlapping", () => {
    expect(timeAnnotationsOverlap(timeAnnotation("a", 0, 10), timeAnnotation("b", 5, 10))).toBe(
      true,
    );
  });

  it("does not count spans that merely touch", () => {
    expect(timeAnnotationsOverlap(timeAnnotation("a", 0, 5), timeAnnotation("b", 5, 5))).toBe(
      false,
    );
  });

  it("counts two markers at the same instant as overlapping", () => {
    expect(timeAnnotationsOverlap(timeAnnotation("a", 3, 0), timeAnnotation("b", 3, 0))).toBe(true);
  });

  it("finds every overlapping neighbour but not itself", () => {
    const seizure = timeAnnotation("seizure", 10, 40);
    const list = [
      seizure,
      timeAnnotation("spike-1", 12, 0.08),
      timeAnnotation("spike-2", 30, 0.08),
      timeAnnotation("elsewhere", 200, 5),
    ];
    expect(findTimeOverlaps(list, seizure).map((a) => a.id)).toEqual(["spike-1", "spike-2"]);
  });
});

describe("assignOverlapLanes", () => {
  it("puts non-overlapping annotations in the same lane", () => {
    const lanes = assignOverlapLanes([timeAnnotation("a", 0, 5), timeAnnotation("b", 10, 5)]);
    expect(lanes.get("a")).toBe(0);
    expect(lanes.get("b")).toBe(0);
  });

  it("stacks a spike marked inside a seizure onto its own lane", () => {
    const lanes = assignOverlapLanes([
      timeAnnotation("seizure", 10, 40),
      timeAnnotation("spike", 12, 0.08),
    ]);
    expect(lanes.get("seizure")).toBe(0);
    expect(lanes.get("spike")).toBe(1);
  });

  it("gives two markers at the same instant separate lanes", () => {
    const lanes = assignOverlapLanes([timeAnnotation("a", 4, 0), timeAnnotation("b", 4, 0)]);
    expect(new Set([lanes.get("a"), lanes.get("b")]).size).toBe(2);
  });

  it("reuses a lane once its occupant has ended", () => {
    const lanes = assignOverlapLanes([
      timeAnnotation("a", 0, 10),
      timeAnnotation("b", 5, 10),
      timeAnnotation("c", 20, 5),
    ]);
    expect(lanes.get("a")).toBe(0);
    expect(lanes.get("b")).toBe(1);
    expect(lanes.get("c")).toBe(0);
  });

  it("covers every annotation", () => {
    const list = [timeAnnotation("a", 0, 3), timeAnnotation("b", 1, 3), timeAnnotation("c", 2, 3)];
    const lanes = assignOverlapLanes(list);
    expect(lanes.size).toBe(3);
    expect(new Set(lanes.values()).size).toBe(3);
  });
});

describe("formatSeconds", () => {
  it("prints an integer without a decimal point", () => {
    expect(formatSeconds(0)).toBe("0");
    expect(formatSeconds(12)).toBe("12");
    expect(formatSeconds(1000)).toBe("1000");
  });

  it("strips trailing zeros", () => {
    expect(formatSeconds(1.5)).toBe("1.5");
    expect(formatSeconds(20.1)).toBe("20.1");
  });

  it("rounds to 0.1 ms", () => {
    expect(formatSeconds(1.23456789)).toBe("1.2346");
    expect(formatSeconds(0.00004)).toBe("0");
  });

  it("does not leak float noise into the cell", () => {
    expect(formatSeconds(0.1 + 0.2)).toBe("0.3");
  });

  it("falls back to 0 for a non-finite value", () => {
    expect(formatSeconds(Number.NaN)).toBe("0");
    expect(formatSeconds(Number.POSITIVE_INFINITY)).toBe("0");
  });

  it("never writes a negative zero into a cell", () => {
    // A value just below zero rounds to -0, which stringifies as "-0" — a cell
    // no reader expects in an onset column.
    expect(formatSeconds(-0.00001)).toBe("0");
    expect(formatSeconds(-0)).toBe("0");
  });
});

describe("formatHed", () => {
  it("joins SHORT-FORM tags with the comma HED specifies", () => {
    expect(formatHed([SEIZURE, SPIKE])).toBe("sc:Epileptic-seizure, sc:Spike");
  });

  it("writes n/a when there are none", () => {
    expect(formatHed([])).toBe("n/a");
  });
});

describe("hedShortForm", () => {
  it("keeps the library prefix on the leaf", () => {
    expect(hedShortForm("sc:Episode/Epileptic-seizure")).toBe("sc:Epileptic-seizure");
    expect(hedShortForm("sc:Sleep-and-drowsiness/Sleep-spindles")).toBe("sc:Sleep-spindles");
  });

  it("reduces a base-HED path to its bare leaf", () => {
    expect(
      hedShortForm(
        "Property/Data-property/Data-artifact/Biological-artifact/Eye-artifact/Eye-blink-artifact",
      ),
    ).toBe("Eye-blink-artifact");
  });

  it("leaves an already-short tag alone", () => {
    expect(hedShortForm("Spike")).toBe("Spike");
    expect(hedShortForm("sc:Spike")).toBe("sc:Spike");
  });
});

describe("serializeEventsTsv", () => {
  it("writes the BIDS header with onset and duration first", () => {
    const [header] = serializeEventsTsv([]).split("\n");
    expect(header).toBe("onset\tduration\tHED\tdescription");
  });

  it("writes a header-only file for an empty set", () => {
    expect(serializeEventsTsv([])).toBe("onset\tduration\tHED\tdescription\n");
  });

  it("writes a marker as duration 0 and a span as its length", () => {
    const text = serializeEventsTsv([
      timeAnnotation("m", 12.5, 0, { hedTags: [SPIKE] }),
      timeAnnotation("s", 40, 12.25, { hedTags: [SEIZURE], description: "left temporal onset" }),
    ]);
    expect(text.split("\n")).toEqual([
      "onset\tduration\tHED\tdescription",
      "12.5\t0\tsc:Spike\tn/a",
      "40\t12.25\tsc:Epileptic-seizure\tleft temporal onset",
      "",
    ]);
  });

  it("uses n/a for an annotation with no tags and no comment", () => {
    expect(serializeEventsTsv([timeAnnotation("a", 1, 0)])).toContain("1\t0\tn/a\tn/a");
  });

  it("sorts by onset regardless of insertion order", () => {
    const text = serializeEventsTsv([timeAnnotation("b", 90, 0), timeAnnotation("a", 3, 0)]);
    const rows = text.trim().split("\n").slice(1);
    expect(rows[0].startsWith("3\t")).toBe(true);
    expect(rows[1].startsWith("90\t")).toBe(true);
  });

  it("is byte-identical for the same set in a different order", () => {
    const a = timeAnnotation("a", 5, 1, { hedTags: [SPIKE] });
    const b = timeAnnotation("b", 2, 0, { hedTags: [BLINK] });
    expect(serializeEventsTsv([a, b])).toBe(serializeEventsTsv([b, a]));
  });

  it("ends with exactly one newline", () => {
    const text = serializeEventsTsv([timeAnnotation("a", 1, 0)]);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
  });

  it("never emits a tab from user text", () => {
    const text = serializeEventsTsv([
      timeAnnotation("a", 1, 0, { description: "col1\tcol2\nrow2" }),
    ]);
    const rows = text.trim().split("\n");
    expect(rows).toHaveLength(2);
    expect(rows[1].split("\t")).toHaveLength(4);
  });
});

describe("serializeChannelsTsv", () => {
  it("writes the BIDS channels header with name first", () => {
    expect(serializeChannelsTsv([])).toBe("name\tstatus\tstatus_description\tHED\n");
  });

  it("writes one row per channel, sorted by label", () => {
    const list = upsertChannelAnnotations(
      [],
      ["T8", "Fp1"],
      { hedTags: [LINE_NOISE], description: "50 Hz pickup" },
      AT,
    );
    expect(serializeChannelsTsv(list).split("\n")).toEqual([
      "name\tstatus\tstatus_description\tHED",
      // Short form in the file; the long form stays in the stored annotation.
      "Fp1\tbad\t50 Hz pickup\tLine-noise-artifact",
      "T8\tbad\t50 Hz pickup\tLine-noise-artifact",
      "",
    ]);
  });

  it("uses n/a for an untagged, undescribed channel", () => {
    const list = [createChannelAnnotation({ id: "1", channel: "Cz" }, AT)];
    expect(serializeChannelsTsv(list)).toContain("Cz\tbad\tn/a\tn/a");
  });

  it("keeps an explicit good status", () => {
    const list = [createChannelAnnotation({ id: "1", channel: "Cz", status: "good" }, AT)];
    expect(serializeChannelsTsv(list)).toContain("Cz\tgood\t");
  });
});

describe("recordingStem and filenames", () => {
  it("drops the directory, the extension and the BIDS suffix", () => {
    expect(recordingStem("sub-01/ses-1/eeg/sub-01_ses-1_task-rest_eeg.edf")).toBe(
      "sub-01_ses-1_task-rest",
    );
  });

  it("handles a run entity", () => {
    expect(recordingStem("sub-05/eeg/sub-05_task-oddball_run-02_eeg.set")).toBe(
      "sub-05_task-oddball_run-02",
    );
  });

  it("handles a directory-format recording", () => {
    expect(recordingStem("sub-02/ieeg/sub-02_task-seizure_ieeg.mefd")).toBe("sub-02_task-seizure");
  });

  it("leaves a non-BIDS name usable", () => {
    expect(recordingStem("recording.bdf")).toBe("recording");
  });

  it("never returns an empty stem", () => {
    expect(recordingStem("")).toBe("recording");
  });

  it("builds both download filenames", () => {
    const path = "sub-01/eeg/sub-01_task-rest_eeg.edf";
    expect(eventsTsvFilename(path)).toBe("sub-01_task-rest_events.tsv");
    // Not `_channels.tsv`: the file is a partial one to merge, and a name that
    // claims to be the recording's channels table invites replacing it.
    expect(channelsTsvFilename(path)).toBe("sub-01_task-rest_channels-annotations.tsv");
  });
});

describe("emptyAnnotationSet", () => {
  it("starts empty and reports so", () => {
    const set = emptyAnnotationSet();
    expect(isAnnotationSetEmpty(set)).toBe(true);
  });

  it("stops being empty once either kind has an entry", () => {
    expect(isAnnotationSetEmpty({ time: [timeAnnotation("a", 1, 0)], channels: [] })).toBe(false);
    expect(
      isAnnotationSetEmpty({
        time: [],
        channels: [createChannelAnnotation({ channel: "T7" }, AT)],
      }),
    ).toBe(false);
  });

  it("returns a fresh object each call", () => {
    const a = emptyAnnotationSet();
    a.time.push(timeAnnotation("x", 1, 0));
    expect(emptyAnnotationSet().time).toHaveLength(0);
  });
});
