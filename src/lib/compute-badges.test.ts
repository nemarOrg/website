import { describe, expect, it } from "vitest";
import { COMPUTE_BADGE_TONES_IN_USE, jobBadge, sourceLabel } from "./compute-badges";
import { COMPUTE_JOB_SOURCES, COMPUTE_JOB_STATES } from "./compute-contract";

describe("jobBadge", () => {
  it.each([
    ["created", "Created", "neutral", "neutral"],
    ["uploading", "Uploading", "info", "progress"],
    ["submitted", "Submitted", "info", "progress"],
    ["queued", "Queued", "info", "progress"],
    ["running", "Running", "info", "progress"],
    ["archiving", "Archiving", "info", "progress"],
    ["finished", "Finished", "success", "ok"],
    ["failed", "Failed", "danger", "error"],
    ["cancelled", "Cancelled", "neutral", "neutral"],
    ["unreported", "Unreported", "warning", "warn"],
  ])("%s reads %s as %s with the %s icon", (state, label, tone, icon) => {
    expect(jobBadge(state)).toEqual({ label, tone, icon, known: true });
  });

  it("covers every state the contract lists", () => {
    for (const state of COMPUTE_JOB_STATES) expect(jobBadge(state).known, state).toBe(true);
  });

  it("uses five tones, and no two tones share an icon", () => {
    expect([...COMPUTE_BADGE_TONES_IN_USE].sort()).toEqual([
      "danger",
      "info",
      "neutral",
      "success",
      "warning",
    ]);
    const icons = COMPUTE_BADGE_TONES_IN_USE.map((tone) => {
      const state = COMPUTE_JOB_STATES.find((s) => jobBadge(s).tone === tone) as string;
      return jobBadge(state).icon;
    });
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("renders a state this build does not know as its raw word in a neutral pill", () => {
    expect(jobBadge("paused")).toEqual({
      label: "paused",
      tone: "neutral",
      icon: "neutral",
      known: false,
    });
  });

  it("does not mistake an object key for a state", () => {
    for (const word of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const badge = jobBadge(word);
      expect(badge.known, word).toBe(false);
      expect(badge.label, word).toBe(word);
      expect(badge.tone, word).toBe("neutral");
    }
  });

  it("escapes control and direction characters in an unknown word", () => {
    expect(jobBadge("a‮b\u0007").label).toBe("a\\u202eb\\x07");
  });

  it("gives an empty word a defined answer", () => {
    expect(jobBadge("").label).toBe("Unknown");
  });
});

describe("sourceLabel", () => {
  it("has plain words for the four front doors, and none says who pays", () => {
    expect(COMPUTE_JOB_SOURCES.map(sourceLabel)).toEqual([
      "Command line",
      "Website",
      "Partner site",
      "NEMAR pipeline",
    ]);
  });

  it("prints a source it does not know as the escaped raw word", () => {
    expect(sourceLabel("robot")).toBe("robot");
    expect(sourceLabel("constructor")).toBe("constructor");
    expect(sourceLabel("x‮")).toBe("x\\u202e");
  });
});
