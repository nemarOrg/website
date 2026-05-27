import { describe, expect, it } from "vitest";
import { parseParticipantsTsv, participantsUrl } from "./participants";

describe("parseParticipantsTsv", () => {
  it("parses a well-formed HBN-style TSV", () => {
    const tsv = [
      "participant_id\trelease_number\tsex\tage",
      "sub-001\tR5\tM\t8.2",
      "sub-002\tR5\tF\t11.5",
      "sub-003\tR5\tM\t9.0",
      "sub-004\tR5\tF\t10.8",
    ].join("\n");
    const out = parseParticipantsTsv(tsv);
    expect(out.total).toBe(4);
    expect(out.ages).toEqual([8.2, 11.5, 9.0, 10.8]);
    expect(out.sexes).toEqual(["M", "F", "M", "F"]);
    expect(out.sexCounts).toEqual({ M: 2, F: 2, O: 0 });
  });

  it("falls back to the deprecated `gender` column when `sex` is absent", () => {
    const tsv = ["participant_id\tgender\tage", "sub-001\tMale\t30", "sub-002\tFemale\t28"].join(
      "\n",
    );
    const out = parseParticipantsTsv(tsv);
    expect(out.sexes).toEqual(["M", "F"]);
    expect(out.sexCounts).toEqual({ M: 1, F: 1, O: 0 });
  });

  it("normalizes sex tokens (M/m/Male/male/1 → M; F/f/Female/female/2 → F; else O)", () => {
    const tsv = [
      "participant_id\tsex\tage",
      "sub-001\tM\t10",
      "sub-002\tm\t10",
      "sub-003\tMale\t10",
      "sub-004\tmale\t10",
      "sub-005\t1\t10",
      "sub-006\tF\t10",
      "sub-007\tFemale\t10",
      "sub-008\t2\t10",
      "sub-009\tOther\t10",
      "sub-010\tnon-binary\t10",
    ].join("\n");
    const out = parseParticipantsTsv(tsv);
    expect(out.sexes).toEqual(["M", "M", "M", "M", "M", "F", "F", "F", "O", "O"]);
    expect(out.sexCounts).toEqual({ M: 5, F: 3, O: 2 });
  });

  it("treats blank, n/a, NA as sex=null (excluded from sexCounts)", () => {
    const tsv = [
      "participant_id\tsex\tage",
      "sub-001\t\t10",
      "sub-002\tn/a\t10",
      "sub-003\tNA\t10",
      "sub-004\tM\t10",
    ].join("\n");
    const out = parseParticipantsTsv(tsv);
    expect(out.sexes).toEqual([null, null, null, "M"]);
    expect(out.sexCounts).toEqual({ M: 1, F: 0, O: 0 });
  });

  it("skips rows whose age is n/a / empty / non-numeric (sex still tallied)", () => {
    const tsv = [
      "participant_id\tsex\tage",
      "sub-001\tM\t10",
      "sub-002\tF\tn/a",
      "sub-003\tM\t",
      "sub-004\tF\tunknown",
      "sub-005\tM\t12.3",
    ].join("\n");
    const out = parseParticipantsTsv(tsv);
    expect(out.ages).toEqual([10, 12.3]);
    expect(out.sexes).toEqual(["M", "F", "M", "F", "M"]);
    expect(out.sexCounts).toEqual({ M: 3, F: 2, O: 0 });
  });

  it("returns zeroed data for header-only input", () => {
    const out = parseParticipantsTsv("participant_id\tsex\tage");
    expect(out.total).toBe(0);
    expect(out.ages).toEqual([]);
    expect(out.sexes).toEqual([]);
    expect(out.sexCounts).toEqual({ M: 0, F: 0, O: 0 });
  });

  it("returns zeroed data for empty string", () => {
    const out = parseParticipantsTsv("");
    expect(out.total).toBe(0);
    expect(out.ages).toEqual([]);
    expect(out.sexes).toEqual([]);
  });

  it("tolerates whitespace + case in header tokens", () => {
    const tsv = ["participant_id\t  Sex  \t  AGE ", "sub-001\tM\t8"].join("\n");
    const out = parseParticipantsTsv(tsv);
    expect(out.sexes).toEqual(["M"]);
    expect(out.ages).toEqual([8]);
  });

  it("counts rows but produces empty arrays when neither sex nor age columns exist", () => {
    const tsv = ["participant_id\thandedness", "sub-001\tright", "sub-002\tleft"].join("\n");
    const out = parseParticipantsTsv(tsv);
    expect(out.total).toBe(2);
    expect(out.ages).toEqual([]);
    expect(out.sexes).toEqual([]);
    expect(out.sexCounts).toEqual({ M: 0, F: 0, O: 0 });
  });

  it("handles CRLF line endings", () => {
    const tsv = "participant_id\tsex\tage\r\nsub-001\tM\t10\r\nsub-002\tF\t12\r\n";
    const out = parseParticipantsTsv(tsv);
    expect(out.total).toBe(2);
    expect(out.sexes).toEqual(["M", "F"]);
  });
});

describe("participantsUrl", () => {
  it("composes the canonical data.nemar.org path", () => {
    expect(participantsUrl("on005509", "v1.0.0")).toBe(
      "https://data.nemar.org/on005509/v1.0.0/participants.tsv",
    );
  });

  it("encodes the dataset id + version segments", () => {
    expect(participantsUrl("on/005", "v1.0.0/beta")).toBe(
      "https://data.nemar.org/on%2F005/v1.0.0%2Fbeta/participants.tsv",
    );
  });

  it("respects an explicit dataBase override + strips trailing slash", () => {
    expect(participantsUrl("on005509", "v1.0.0", "http://localhost:8787/")).toBe(
      "http://localhost:8787/on005509/v1.0.0/participants.tsv",
    );
  });
});
