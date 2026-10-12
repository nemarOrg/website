import { describe, expect, it } from "vitest";
import { FORM_DEFAULTS, pruneFormEntries } from "./filter-form";
import { defaultFilterState, filterStateFromURL, filterStateToURL } from "./filters";

type Entries = [string, string][];
const parse = (e: Entries) => filterStateFromURL(new URLSearchParams(e));

describe("the filter form's pruned address means what the unpruned one did", () => {
  it("knows the server's defaults", () => {
    const d = defaultFilterState();
    expect(FORM_DEFAULTS).toEqual({ modality_op: d.modalityOp, sort: d.sort });
  });

  // What the real sidebar + header search + sort control submit, field by field.
  const untouched: Entries = [
    ["q", ""],
    ["modality_op", "OR"],
    ["p_min", ""],
    ["p_max", ""],
    ["density", ""],
    ["es", ""],
    ["sort", "newest"],
  ];
  it("prunes an untouched form to nothing", () => {
    expect(pruneFormEntries(untouched)).toEqual([]);
    expect(filterStateToURL(parse(untouched)).toString()).toBe("");
  });

  it.each<[string, Entries]>([
    ["a chip", [...untouched, ["modality", "MEG"]]],
    [
      "AND across two modalities",
      [
        ["modality_op", "AND"],
        ["modality", "EEG"],
        ["modality", "MEG"],
        ["sort", "newest"],
      ],
    ],
    ["a non-default sort", [...untouched.filter(([n]) => n !== "sort"), ["sort", "oldest"]]],
    [
      "a search with a license and a range",
      [
        ["q", "oddball"],
        ["license", "public"],
        ["p_min", "10"],
        ["p_max", ""],
        ["modality_op", "OR"],
      ],
    ],
    ["has_hed and has_viewer", [...untouched, ["has_hed", "1"], ["has_viewer", "1"]]],
  ])("keeps the meaning of %s", (_name, entries) => {
    expect(parse(pruneFormEntries(entries) as Entries)).toEqual(parse(entries));
  });
});
