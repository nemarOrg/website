import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAV_ORDER,
  NAV_ORDER_STORAGE_KEY,
  type RecordingEntry,
  buildRecordingList,
  firstRecording,
  naturalCompare,
  normalizeNavOrder,
  orderedRecordings,
  parseRecordingPath,
  readNavOrder,
  recordingPosition,
  selectRecording,
  stepRecording,
  subjectValues,
  taskValues,
  writeNavOrder,
} from "./recording-nav";

/** Paths in the shape `index.json` lists them: BIDS-relative, no leading
 *  slash, and (after website#252) sometimes a directory. */
const SESSIONED = [
  "sub-01/ses-01/eeg/sub-01_ses-01_task-oddball_run-01_eeg.bdf",
  "sub-01/ses-01/eeg/sub-01_ses-01_task-oddball_run-02_eeg.bdf",
  "sub-01/ses-02/eeg/sub-01_ses-02_task-oddball_run-01_eeg.bdf",
  "sub-02/ses-01/eeg/sub-02_ses-01_task-oddball_run-01_eeg.bdf",
];

const TWO_TASKS = [
  "sub-01/eeg/sub-01_task-rest_eeg.set",
  "sub-01/eeg/sub-01_task-oddball_run-01_eeg.set",
  "sub-01/eeg/sub-01_task-oddball_run-02_eeg.set",
  "sub-02/eeg/sub-02_task-rest_eeg.set",
  "sub-02/eeg/sub-02_task-oddball_run-01_eeg.set",
];

const paths = (list: RecordingEntry[]): string[] => list.map((e) => e.path);

describe("parseRecordingPath", () => {
  it("reads entities from a plain single-session file", () => {
    const e = parseRecordingPath("sub-01/eeg/sub-01_task-rest_eeg.set");
    expect(e.sub).toBe("01");
    expect(e.task).toBe("rest");
    expect(e.ses).toBeNull();
    expect(e.run).toBeNull();
    expect(e.name).toBe("sub-01_task-rest_eeg.set");
    expect(e.parsed).toBe(true);
  });

  it("reads ses, acq, run and recording entities", () => {
    const e = parseRecordingPath(
      "sub-emu001/ses-01/ieeg/sub-emu001_ses-01_task-seizure_acq-hfo_run-02_recording-full_ieeg.mefd",
    );
    expect(e.sub).toBe("emu001");
    expect(e.ses).toBe("01");
    expect(e.task).toBe("seizure");
    expect(e.acq).toBe("hfo");
    expect(e.run).toBe("02");
    expect(e.recording).toBe("full");
  });

  it("parses a directory recording without looking at extensions", () => {
    const ctf = parseRecordingPath("sub-03/meg/sub-03_task-somatosensory_meg.ds");
    expect(ctf.sub).toBe("03");
    expect(ctf.task).toBe("somatosensory");
    expect(ctf.name).toBe("sub-03_task-somatosensory_meg.ds");
    const mef = parseRecordingPath("sub-04/ieeg/sub-04_task-rest_run-01_ieeg.mefd");
    expect(mef.run).toBe("01");
    // Extensionless (4D/BTi) directory recordings parse the same way.
    const bti = parseRecordingPath("sub-05/meg/sub-05_task-rest_meg");
    expect(bti.sub).toBe("05");
    expect(bti.task).toBe("rest");
  });

  it("keeps dashes inside a label", () => {
    const e = parseRecordingPath("sub-01/eeg/sub-01_task-rest-eyes-open_eeg.set");
    expect(e.task).toBe("rest-eyes-open");
  });

  it("inherits sub/ses from directories when the filename omits them", () => {
    const e = parseRecordingPath("sub-07/ses-pre/eeg/task-rest_eeg.edf");
    expect(e.sub).toBe("07");
    expect(e.ses).toBe("pre");
    expect(e.task).toBe("rest");
  });

  it("lets the filename win over the directory when they disagree", () => {
    const e = parseRecordingPath("sub-07/eeg/sub-08_task-rest_eeg.edf");
    expect(e.sub).toBe("08");
  });

  it("ignores entities it does not track", () => {
    const e = parseRecordingPath("sub-01/eeg/sub-01_task-rest_split-01_desc-clean_eeg.set");
    expect(e.sub).toBe("01");
    expect(e.task).toBe("rest");
    // `split`/`desc` are simply not fields on the entry.
    expect(Object.keys(e).sort()).toEqual(
      ["acq", "index", "name", "parsed", "path", "recording", "run", "ses", "sub", "task"].sort(),
    );
  });

  it("marks a non-BIDS path unparsed with every entity null", () => {
    const e = parseRecordingPath("derivatives/cleaned/recording001.edf");
    expect(e.parsed).toBe(false);
    expect(e.sub).toBeNull();
    expect(e.task).toBeNull();
    expect(e.name).toBe("recording001.edf");
  });

  it("survives an empty path", () => {
    const e = parseRecordingPath("");
    expect(e.parsed).toBe(false);
    expect(e.name).toBe("");
  });
});

describe("buildRecordingList", () => {
  it("keeps source order in the index field", () => {
    const list = buildRecordingList(TWO_TASKS);
    expect(list.map((e) => e.index)).toEqual([0, 1, 2, 3, 4]);
    expect(paths(list)).toEqual(TWO_TASKS);
  });

  it("skips empty entries", () => {
    const list = buildRecordingList(["", "sub-01/eeg/sub-01_task-rest_eeg.set", ""]);
    expect(list).toHaveLength(1);
    expect(list[0].index).toBe(0);
  });

  it("accepts a Set (the zarr index's available-path shape)", () => {
    const list = buildRecordingList(new Set(TWO_TASKS));
    expect(paths(list)).toEqual(TWO_TASKS);
  });
});

describe("naturalCompare", () => {
  it("orders numbers numerically, not lexically", () => {
    expect(naturalCompare("2", "10")).toBeLessThan(0);
    expect(naturalCompare("run-9", "run-10")).toBeLessThan(0);
    expect(naturalCompare("01", "2")).toBeLessThan(0);
  });

  it("orders mixed labels sensibly", () => {
    expect(naturalCompare("NDARAB2", "NDARAB10")).toBeLessThan(0);
    expect(naturalCompare("emu001", "emu002")).toBeLessThan(0);
    expect(naturalCompare("rest", "oddball")).toBeGreaterThan(0);
  });

  it("is a total order (equal-valued spellings still separate)", () => {
    expect(naturalCompare("01", "01")).toBe(0);
    expect(naturalCompare("1", "01")).not.toBe(0);
    expect(naturalCompare("1", "01")).toBe(-naturalCompare("01", "1"));
  });
});

describe("orderedRecordings", () => {
  it("walks runs, then tasks, then subjects by default", () => {
    const list = buildRecordingList(TWO_TASKS);
    expect(paths(orderedRecordings(list, "runs"))).toEqual([
      "sub-01/eeg/sub-01_task-oddball_run-01_eeg.set",
      "sub-01/eeg/sub-01_task-oddball_run-02_eeg.set",
      "sub-01/eeg/sub-01_task-rest_eeg.set",
      "sub-02/eeg/sub-02_task-oddball_run-01_eeg.set",
      "sub-02/eeg/sub-02_task-rest_eeg.set",
    ]);
  });

  it("walks subjects first when asked", () => {
    const list = buildRecordingList(TWO_TASKS);
    expect(paths(orderedRecordings(list, "subjects"))).toEqual([
      "sub-01/eeg/sub-01_task-oddball_run-01_eeg.set",
      "sub-02/eeg/sub-02_task-oddball_run-01_eeg.set",
      "sub-01/eeg/sub-01_task-oddball_run-02_eeg.set",
      "sub-01/eeg/sub-01_task-rest_eeg.set",
      "sub-02/eeg/sub-02_task-rest_eeg.set",
    ]);
  });

  it("returns the index order untouched for file order", () => {
    const list = buildRecordingList(TWO_TASKS);
    expect(paths(orderedRecordings(list, "file"))).toEqual(TWO_TASKS);
  });

  it("orders sessions inside a subject, before task", () => {
    const list = buildRecordingList(SESSIONED);
    expect(paths(orderedRecordings(list, "runs"))).toEqual([
      "sub-01/ses-01/eeg/sub-01_ses-01_task-oddball_run-01_eeg.bdf",
      "sub-01/ses-01/eeg/sub-01_ses-01_task-oddball_run-02_eeg.bdf",
      "sub-01/ses-02/eeg/sub-01_ses-02_task-oddball_run-01_eeg.bdf",
      "sub-02/ses-01/eeg/sub-02_ses-01_task-oddball_run-01_eeg.bdf",
    ]);
  });

  // What "subjects first" means once sessions exist: the subject moves
  // fastest, so ses-01 is walked across the cohort before ses-02 starts.
  it("holds the session while walking subjects in subjects-first order", () => {
    const list = buildRecordingList(SESSIONED);
    expect(paths(orderedRecordings(list, "subjects"))).toEqual([
      "sub-01/ses-01/eeg/sub-01_ses-01_task-oddball_run-01_eeg.bdf",
      "sub-02/ses-01/eeg/sub-02_ses-01_task-oddball_run-01_eeg.bdf",
      "sub-01/ses-02/eeg/sub-01_ses-02_task-oddball_run-01_eeg.bdf",
      "sub-01/ses-01/eeg/sub-01_ses-01_task-oddball_run-02_eeg.bdf",
    ]);
  });

  it("sorts runs numerically past 9", () => {
    const list = buildRecordingList([
      "sub-01/eeg/sub-01_task-rest_run-10_eeg.set",
      "sub-01/eeg/sub-01_task-rest_run-2_eeg.set",
      "sub-01/eeg/sub-01_task-rest_run-1_eeg.set",
    ]);
    expect(orderedRecordings(list, "runs").map((e) => e.run)).toEqual(["1", "2", "10"]);
  });

  it("puts a recording with no run entity first in its group", () => {
    const list = buildRecordingList([
      "sub-01/eeg/sub-01_task-rest_run-01_eeg.set",
      "sub-01/eeg/sub-01_task-rest_eeg.set",
    ]);
    expect(orderedRecordings(list, "runs").map((e) => e.run)).toEqual([null, "01"]);
  });

  it("sorts unparsed paths after parsed ones, in source order", () => {
    const list = buildRecordingList([
      "loose-b.edf",
      "sub-02/eeg/sub-02_task-rest_eeg.set",
      "loose-a.edf",
      "sub-01/eeg/sub-01_task-rest_eeg.set",
    ]);
    expect(paths(orderedRecordings(list, "runs"))).toEqual([
      "sub-01/eeg/sub-01_task-rest_eeg.set",
      "sub-02/eeg/sub-02_task-rest_eeg.set",
      "loose-b.edf",
      "loose-a.edf",
    ]);
  });

  it("degrades to plain file order when nothing parses", () => {
    const raw = ["c.edf", "a.edf", "b.edf"];
    const list = buildRecordingList(raw);
    expect(paths(orderedRecordings(list, "runs"))).toEqual(raw);
    expect(paths(orderedRecordings(list, "subjects"))).toEqual(raw);
  });

  it("does not mutate the input list", () => {
    const list = buildRecordingList(TWO_TASKS);
    orderedRecordings(list, "runs");
    expect(paths(list)).toEqual(TWO_TASKS);
  });

  it("keeps directory and file recordings in one sequence", () => {
    const list = buildRecordingList([
      "sub-02/ieeg/sub-02_task-rest_ieeg.mefd",
      "sub-01/eeg/sub-01_task-rest_eeg.set",
      "sub-03/meg/sub-03_task-rest_meg.ds",
    ]);
    expect(orderedRecordings(list, "runs").map((e) => e.sub)).toEqual(["01", "02", "03"]);
  });
});

describe("stepRecording", () => {
  const list = buildRecordingList(TWO_TASKS);

  it("moves to the next run inside a task", () => {
    const next = stepRecording(list, "sub-01/eeg/sub-01_task-oddball_run-01_eeg.set", "runs", 1);
    expect(next?.path).toBe("sub-01/eeg/sub-01_task-oddball_run-02_eeg.set");
  });

  it("rolls past the last run into the next task of the same subject", () => {
    const next = stepRecording(list, "sub-01/eeg/sub-01_task-oddball_run-02_eeg.set", "runs", 1);
    expect(next?.task).toBe("rest");
    expect(next?.sub).toBe("01");
  });

  it("moves to the next subject in subjects-first order", () => {
    const next = stepRecording(
      list,
      "sub-01/eeg/sub-01_task-oddball_run-01_eeg.set",
      "subjects",
      1,
    );
    expect(next?.sub).toBe("02");
    expect(next?.task).toBe("oddball");
  });

  it("steps backwards", () => {
    const prev = stepRecording(list, "sub-02/eeg/sub-02_task-rest_eeg.set", "runs", -1);
    expect(prev?.path).toBe("sub-02/eeg/sub-02_task-oddball_run-01_eeg.set");
  });

  it("returns null at both ends rather than wrapping", () => {
    expect(
      stepRecording(list, "sub-01/eeg/sub-01_task-oddball_run-01_eeg.set", "runs", -1),
    ).toBeNull();
    expect(stepRecording(list, "sub-02/eeg/sub-02_task-rest_eeg.set", "runs", 1)).toBeNull();
  });

  it("returns null for a path that is not in the list", () => {
    expect(stepRecording(list, "sub-99/eeg/sub-99_task-rest_eeg.set", "runs", 1)).toBeNull();
  });

  it("follows the index order under file order", () => {
    const next = stepRecording(list, TWO_TASKS[0], "file", 1);
    expect(next?.path).toBe(TWO_TASKS[1]);
  });
});

describe("recordingPosition", () => {
  it("reports the position in the ordered list", () => {
    const ordered = orderedRecordings(buildRecordingList(TWO_TASKS), "runs");
    expect(recordingPosition(ordered, "sub-01/eeg/sub-01_task-rest_eeg.set")).toBe(2);
    expect(recordingPosition(ordered, "nope")).toBe(-1);
  });
});

describe("firstRecording", () => {
  it("returns null for an empty list", () => {
    expect(firstRecording([])).toBeNull();
  });

  it("picks the first recording in the default (runs) order", () => {
    // sub-01/ses-01/run-01 sorts before sub-01/ses-02 and sub-02, regardless
    // of the source (index) order.
    const list = buildRecordingList([...SESSIONED].reverse());
    const first = firstRecording(list);
    expect(first?.path).toBe(SESSIONED[0]);
  });

  it("follows the requested nav order, not always the default", () => {
    const list = buildRecordingList(TWO_TASKS);
    expect(firstRecording(list, "runs")?.path).toBe(
      "sub-01/eeg/sub-01_task-oddball_run-01_eeg.set",
    );
    expect(firstRecording(list, "file")?.path).toBe(TWO_TASKS[0]);
    expect(firstRecording(list, "subjects")?.path).toBe(
      "sub-01/eeg/sub-01_task-oddball_run-01_eeg.set",
    );
  });

  it("picks a directory (.mefd) recording when it sorts first", () => {
    const list = buildRecordingList([
      "sub-04/ieeg/sub-04_task-rest_run-02_ieeg.mefd",
      "sub-04/ieeg/sub-04_task-rest_run-01_ieeg.mefd",
    ]);
    const first = firstRecording(list, "runs");
    expect(first?.path).toBe("sub-04/ieeg/sub-04_task-rest_run-01_ieeg.mefd");
    expect(first?.name).toBe("sub-04_task-rest_run-01_ieeg.mefd");
  });

  it("mixes directory and file recordings, ordering by entities not shape", () => {
    const list = buildRecordingList([
      "sub-02/meg/sub-02_task-rest_meg.ds",
      "sub-01/ieeg/sub-01_task-rest_ieeg.mefd",
    ]);
    expect(firstRecording(list, "runs")?.path).toBe("sub-01/ieeg/sub-01_task-rest_ieeg.mefd");
  });

  it("still returns an entry when nothing parses (degrades to source order)", () => {
    const list = buildRecordingList(["derivatives/summary.json", "code/convert.py"]);
    expect(firstRecording(list)?.path).toBe("derivatives/summary.json");
  });
});

describe("subjectValues / taskValues", () => {
  it("lists distinct subjects, naturally sorted", () => {
    const list = buildRecordingList([
      "sub-10/eeg/sub-10_task-rest_eeg.set",
      "sub-2/eeg/sub-2_task-rest_eeg.set",
      "sub-2/eeg/sub-2_task-oddball_eeg.set",
    ]);
    expect(subjectValues(list)).toEqual(["2", "10"]);
  });

  it("returns no subjects for an unparseable dataset", () => {
    expect(subjectValues(buildRecordingList(["a.edf", "b.edf"]))).toEqual([]);
  });

  it("lists every task when no subject is given", () => {
    expect(taskValues(buildRecordingList(TWO_TASKS))).toEqual(["oddball", "rest"]);
  });

  it("scopes tasks to one subject so every option resolves", () => {
    const list = buildRecordingList([...TWO_TASKS, "sub-03/eeg/sub-03_task-sleep_eeg.set"]);
    expect(taskValues(list, "03")).toEqual(["sleep"]);
    expect(taskValues(list, "01")).toEqual(["oddball", "rest"]);
    expect(taskValues(list, "99")).toEqual([]);
  });
});

describe("selectRecording", () => {
  const list = buildRecordingList([...TWO_TASKS, "sub-03/eeg/sub-03_task-sleep_eeg.set"]);

  it("finds the first recording of a (subject, task) pair", () => {
    const hit = selectRecording(list, { sub: "01", task: "oddball" });
    expect(hit?.path).toBe("sub-01/eeg/sub-01_task-oddball_run-01_eeg.set");
  });

  it("honours the iteration order when several match", () => {
    const hit = selectRecording(list, { sub: "01" }, "file");
    expect(hit?.path).toBe("sub-01/eeg/sub-01_task-rest_eeg.set");
  });

  it("keeps the subject when it has no such task", () => {
    const hit = selectRecording(list, { sub: "03", task: "oddball" }, "runs", "sub");
    expect(hit?.sub).toBe("03");
    expect(hit?.task).toBe("sleep");
  });

  it("keeps the task when the pick came from the task dropdown", () => {
    const hit = selectRecording(list, { sub: "03", task: "oddball" }, "runs", "task");
    expect(hit?.task).toBe("oddball");
    expect(hit?.sub).toBe("01");
  });

  it("matches on a single coordinate", () => {
    expect(selectRecording(list, { task: "sleep" })?.sub).toBe("03");
    expect(selectRecording(list, { sub: "02" })?.sub).toBe("02");
  });

  it("returns the first recording overall when nothing is specified", () => {
    expect(selectRecording(list, {}, "file")?.path).toBe(TWO_TASKS[0]);
  });

  it("returns null when neither coordinate exists", () => {
    expect(selectRecording(list, { sub: "99", task: "nope" })).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(selectRecording([], { sub: "01" })).toBeNull();
  });
});

// Split recordings are the real case where two entries tie on every tracked
// entity: BIDS splits an oversized recording into `_split-01`, `_split-02`,
// and `split` is not one of the six entities this module orders by. The
// dropdowns can only ever land on the first of such a group; prev/next is what
// reaches the rest, so both halves of that contract are pinned here.
describe("recordings that tie on every tracked entity", () => {
  const SPLIT = [
    "sub-01/eeg/sub-01_task-rest_split-01_eeg.set",
    "sub-01/eeg/sub-01_task-rest_split-02_eeg.set",
    "sub-01/eeg/sub-01_task-rest_split-03_eeg.set",
  ];
  const list = buildRecordingList(SPLIT);

  it("keeps them in source order under every entity order", () => {
    expect(paths(orderedRecordings(list, "runs"))).toEqual(SPLIT);
    expect(paths(orderedRecordings(list, "subjects"))).toEqual(SPLIT);
    expect(paths(orderedRecordings(list, "file"))).toEqual(SPLIT);
  });

  it("resolves a dropdown pick to the first of the group", () => {
    expect(selectRecording(list, { sub: "01", task: "rest" })?.path).toBe(SPLIT[0]);
  });

  it("reaches the rest of the group with prev/next", () => {
    expect(stepRecording(list, SPLIT[0], "runs", 1)?.path).toBe(SPLIT[1]);
    expect(stepRecording(list, SPLIT[1], "runs", 1)?.path).toBe(SPLIT[2]);
    expect(stepRecording(list, SPLIT[2], "runs", -1)?.path).toBe(SPLIT[1]);
  });

  it("counts every split as its own position", () => {
    const ordered = orderedRecordings(list, "runs");
    expect(ordered).toHaveLength(3);
    expect(recordingPosition(ordered, SPLIT[2])).toBe(2);
  });
});

describe("nav order persistence", () => {
  // A real Storage-shaped object over a Map, per the repo's no-mocks policy:
  // the code under test exercises the same getItem/setItem contract the browser
  // provides, with no branch bypassed.
  function freshStorage(): Storage {
    const store = new Map<string, string>();
    return {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k: string) => store.get(k) ?? null,
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => void store.delete(k),
      setItem: (k: string, v: string) => void store.set(k, v),
    } as Storage;
  }

  it("normalizes known values and rejects everything else", () => {
    expect(normalizeNavOrder("runs")).toBe("runs");
    expect(normalizeNavOrder("subjects")).toBe("subjects");
    expect(normalizeNavOrder("file")).toBe("file");
    expect(normalizeNavOrder("sideways")).toBeNull();
    expect(normalizeNavOrder(null)).toBeNull();
    expect(normalizeNavOrder(3)).toBeNull();
  });

  it("round-trips through storage", () => {
    const storage = freshStorage();
    expect(writeNavOrder("subjects", () => storage)).toBe(true);
    expect(storage.getItem(NAV_ORDER_STORAGE_KEY)).toBe("subjects");
    expect(readNavOrder(() => storage)).toBe("subjects");
  });

  it("falls back to the default for an empty or corrupt value", () => {
    const storage = freshStorage();
    expect(readNavOrder(() => storage)).toBe(DEFAULT_NAV_ORDER);
    storage.setItem(NAV_ORDER_STORAGE_KEY, "sideways");
    expect(readNavOrder(() => storage)).toBe(DEFAULT_NAV_ORDER);
  });

  it("survives storage that throws on access (private mode)", () => {
    const boom = () => {
      throw new DOMException("denied", "SecurityError");
    };
    expect(readNavOrder(boom)).toBe(DEFAULT_NAV_ORDER);
    expect(writeNavOrder("file", boom)).toBe(false);
  });

  it("reports a failed write when storage is absent", () => {
    expect(writeNavOrder("file", () => null)).toBe(false);
    expect(readNavOrder(() => null)).toBe(DEFAULT_NAV_ORDER);
  });

  it("survives a storage whose setItem throws (quota exceeded)", () => {
    const storage = {
      ...freshStorage(),
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    } as unknown as Storage;
    expect(writeNavOrder("file", () => storage)).toBe(false);
  });
});
