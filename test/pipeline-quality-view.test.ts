/**
 * A run's quality on the admin Pipelines tab (website phase W9, #588): the guard, the sentences and
 * the view model, on answers captured from the REAL nemar-cli routes
 * (`scripts/capture-run-quality-fixtures.mjs`, test/fixtures/compute/admin-run-quality/): a current
 * derivative of a public dataset, a canary of the same, an expired canary of a dataset that is not
 * public, a run in progress and a run deferred for its serving index.
 */

import { describe, expect, it } from "vitest";
import { parseRunDetail } from "../src/lib/compute-pipeline-api";
import {
  COMPUTE_RUN_QUALITY_RECORDINGS_STATES,
  COMPUTE_RUN_QUALITY_STATES,
} from "../src/lib/compute-pipeline-contract";
import { parseRunQuality } from "../src/lib/pipeline-quality-api";
import {
  ADMIN_VIEW_SENTENCES,
  PIPELINE_QUALITY_LABELS,
  RECORDINGS_SENTENCES,
  RUN_QUALITY_SENTENCES,
} from "../src/lib/pipeline-quality-labels";
import {
  deferralOf,
  deferralText,
  drawableRecordings,
  nextPageHref,
  pickRecording,
  publicHref,
  recordingParam,
  recordingsSentence,
  runQualitySentence,
  runQualityView,
  splitViews,
} from "../src/lib/pipeline-quality-view";
import { QUALITY_ADMIN_ROUTE_WORDS } from "../src/lib/quality-views/admin-route-contract";
import { PANEL_SENTENCES } from "../src/lib/quality-views/panel-words";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const DIR = "test/fixtures/compute/admin-run-quality";
const load = (label: string) => {
  const raw = JSON.parse(fs.readFileSync(repoPath(`${DIR}/${label}.json`), "utf8"));
  return { quality: parseRunQuality(raw.quality.body), run: parseRunDetail(raw.run.body).run };
};
const current = load("current");
const canary = load("canary");
const expired = load("expired");
const inProgress = load("in_progress");
const deferred = load("deferred");

describe("every word has a sentence", () => {
  it("each run-quality word", () => {
    expect(Object.keys(RUN_QUALITY_SENTENCES).sort()).toEqual(
      [...COMPUTE_RUN_QUALITY_STATES].sort(),
    );
    for (const word of COMPUTE_RUN_QUALITY_STATES)
      expect(runQualitySentence(word).known).toBe(true);
  });

  it("each recordings word", () => {
    expect(Object.keys(RECORDINGS_SENTENCES).sort()).toEqual(
      [...COMPUTE_RUN_QUALITY_RECORDINGS_STATES].sort(),
    );
  });

  it("each word of the admin mount, from the admin words or the panel's", () => {
    for (const word of Object.keys(QUALITY_ADMIN_ROUTE_WORDS)) {
      expect(
        Object.hasOwn(ADMIN_VIEW_SENTENCES, word) || Object.hasOwn(PANEL_SENTENCES, word),
        word,
      ).toBe(true);
    }
  });

  it("an unknown word is shown as text in a neutral sentence", () => {
    const s = runQualitySentence("brand_new<b>");
    expect(s.known).toBe(false);
    expect(s.text).toContain("brand new");
    expect(recordingsSentence("odd_word")).toContain("odd word");
  });
});

describe("the captured answers", () => {
  it("are the five states the backend seeded", () => {
    expect([current, canary, expired, inProgress, deferred].map((x) => x.quality.quality)).toEqual([
      "current",
      "canary",
      "expired",
      "run_in_progress",
      "run_not_succeeded",
    ]);
  });

  it("refuses an answer missing a required key, never reading it as empty", () => {
    const raw = JSON.parse(fs.readFileSync(repoPath(`${DIR}/current.json`), "utf8")).quality.body;
    for (const key of ["dataset_public", "quality", "recordings", "derivative"]) {
      const broken = { ...raw };
      delete broken[key];
      expect(() => parseRunQuality(broken), key).toThrow();
    }
  });
});

describe("the public link", () => {
  it("is given for a current derivative of a public dataset", () => {
    expect(publicHref(current.quality)).toBe(`/dataset/${current.quality.dataset_id}`);
    expect(runQualityView(current.quality).notPublic).toBe(false);
  });

  it("is never given for a canary, even of a public dataset", () => {
    expect(canary.quality.dataset_public).toBe(true);
    expect(publicHref(canary.quality)).toBeNull();
  });

  it("is never given for a dataset that is not public, as a concealed anonymous deposit is", () => {
    // A concealed deposit (nemar-cli ADR 0065) fails the backend's gate, so it is not public.
    const concealed = { ...current.quality, dataset_public: false };
    expect(publicHref(concealed)).toBeNull();
    const view = runQualityView(concealed);
    expect(view.notPublic).toBe(true);
    expect(view.publicHref).toBeNull();
  });

  it("is never built from a dataset id that is not one", () => {
    expect(publicHref({ ...current.quality, dataset_id: "../admin" })).toBeNull();
  });
});

describe("dates, states and deferral", () => {
  it("an expired canary says when it expired", () => {
    const view = runQualityView(expired.quality);
    expect(view.sentence).toBe(RUN_QUALITY_SENTENCES.expired);
    expect(view.facts).toContainEqual([
      PIPELINE_QUALITY_LABELS.fieldExpired,
      "2026-01-01 00:00:00 UTC",
    ]);
    expect(view.notPublic).toBe(true);
  });

  it("a canary in date says when it will expire", () => {
    const view = runQualityView(canary.quality);
    expect(view.facts.some(([k]) => k === PIPELINE_QUALITY_LABELS.fieldExpires)).toBe(true);
    expect(view.facts.some(([k]) => k === PIPELINE_QUALITY_LABELS.fieldExpired)).toBe(false);
  });

  it("a run in progress has its sentence and no derivative facts", () => {
    const view = runQualityView(inProgress.quality);
    expect(view.sentence).toBe(RUN_QUALITY_SENTENCES.run_in_progress);
    expect(view.facts).toEqual([[PIPELINE_QUALITY_LABELS.fieldState, "run in progress"]]);
  });

  it("a deferred run says it is deferred, and when it goes ahead when that is served", () => {
    const d = deferralOf(deferred.run);
    expect(d).not.toBeNull();
    expect(deferralText(d!)).toContain(PIPELINE_QUALITY_LABELS.deferredUnknown);
    expect(deferralText(d!)).toContain(`${deferred.run.created_at} UTC`);
    const served = deferralOf({
      ...deferred.run,
      runs_without_index_after: "2026-11-27T05:56:23.000Z",
    });
    expect(deferralText(served!)).toContain(
      `${PIPELINE_QUALITY_LABELS.deferredAfter} 2026-11-27T05:56:23.000Z.`,
    );
    expect(deferralOf(current.run)).toBeNull();
  });
});

describe("recordings", () => {
  it("offers only recording paths, and picks the one asked for when listed", () => {
    const listed = drawableRecordings(current.quality);
    expect(listed).toEqual(["sub-CUCOV076/eeg/sub-CUCOV076_task-COVID_eeg.edf"]);
    expect(pickRecording(listed, listed[0])).toBe(listed[0]);
    expect(pickRecording(listed, "sub-02/eeg/sub-02_eeg.edf")).toBe(listed[0]);
    expect(pickRecording([], null)).toBeNull();
    const hostile = {
      ...current.quality,
      recordings: {
        ...current.quality.recordings,
        items: [
          { path: "../x_eeg.edf" },
          { path: "a/b_channels.tsv" },
          ...current.quality.recordings.items,
        ],
      },
    };
    expect(drawableRecordings(hostile)).toEqual(listed);
  });

  it("takes a query value only when it is a recording path", () => {
    expect(recordingParam("sub-01/eeg/sub-01_eeg.edf")).toBe("sub-01/eeg/sub-01_eeg.edf");
    for (const bad of [null, "", "../sub-01_eeg.edf", "sub-01/eeg/x.tsv", "https://x/y_eeg.edf"]) {
      expect(recordingParam(bad)).toBeNull();
    }
  });

  it("links the next page with the cursor encoded, and only a recording-path cursor", () => {
    const q = current.quality;
    expect(nextPageHref(8, q)).toBeNull();
    const more = {
      ...q,
      recordings: { ...q.recordings, next_after: "sub-01/eeg/sub-01 a_eeg.edf" },
    };
    expect(nextPageHref(8, more)).toBe(
      "/admin/pipelines/runs/8/quality?after=sub-01%2Feeg%2Fsub-01+a_eeg.edf",
    );
    const bad = { ...q, recordings: { ...q.recordings, next_after: "javascript:alert(1)" } };
    expect(nextPageHref(8, bad)).toBeNull();
  });
});

describe("views", () => {
  it("splits stored views from computed ones by their inputs", () => {
    const views = [
      { key: "spectrum", kind: "nemar.spectrum", data: [] },
      { key: "icactivity", kind: "nemar.ic-activity", inputs: [] },
      { key: "icmaps", kind: "nemar.ic-maps", data: [] },
      { key: "midsegment", kind: "nemar.signal-window", inputs: [] },
    ];
    const { stored, computed } = splitViews(views);
    expect(stored.map((v) => v.key)).toEqual(["spectrum", "icmaps"]);
    expect(computed.map((v) => v.key)).toEqual(["icactivity", "midsegment"]);
  });
});
