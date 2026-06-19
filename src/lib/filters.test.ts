import { describe, expect, it } from "vitest";
import {
  applyClientFilters,
  applyReservedKeyword,
  defaultFilterState,
  filterStateFromURL,
  filterStateToAPIQuery,
  filterStateToURL,
} from "./filters";
import type { Dataset } from "./types";

function mkDataset(over: Partial<Dataset>): Dataset {
  return {
    dataset_id: "nm000001",
    id: "nm000001",
    name: "Test",
    description: null,
    status: "active",
    visibility: "public",
    github_repo: null,
    concept_doi: null,
    doi: null,
    created_at: "",
    updated_at: "",
    owner_username: null,
    nemar_sync_status: null,
    source: "managed",
    source_type: "managed",
    source_id: null,
    modalities: "eeg",
    participants: 0,
    tasks: "",
    authors: "",
    file_size: 0,
    file_size_formatted: "",
    latest_version: null,
    ...over,
  };
}

describe("filterStateFromURL", () => {
  it("returns defaults for empty params", () => {
    const s = filterStateFromURL(new URLSearchParams());
    expect(s).toEqual(defaultFilterState());
  });
  it("parses modalities + AND/OR", () => {
    const s = filterStateFromURL(new URLSearchParams("modality=EEG,MEG&modality_op=AND"));
    expect(s.modalities).toEqual(["EEG", "MEG"]);
    expect(s.modalityOp).toBe("AND");
  });
  it("normalizes iEEG casing", () => {
    const s = filterStateFromURL(new URLSearchParams("modality=ieeg"));
    expect(s.modalities).toEqual(["iEEG"]);
  });
  it("parses the expanded NIRS and motion modalities", () => {
    const s = filterStateFromURL(new URLSearchParams("modality=nirs,motion"));
    expect(s.modalities).toEqual(["NIRS", "MOTION"]);
  });
  it("filters out unknown modalities", () => {
    const s = filterStateFromURL(new URLSearchParams("modality=EEG,FOO"));
    expect(s.modalities).toEqual(["EEG"]);
  });
  it("parses license tiers, dropping unknown tokens", () => {
    const s = filterStateFromURL(new URLSearchParams("license=public,noncommercial,bogus"));
    expect(s.licenseTiers).toEqual(["public", "noncommercial"]);
  });
  it("normalizes license tier casing and dedupes", () => {
    const s = filterStateFromURL(new URLSearchParams("license=PUBLIC,Attribution,public"));
    expect(s.licenseTiers).toEqual(["public", "attribution"]);
  });
  it("parses REPEATED license params (native checkbox-group form submit)", () => {
    // The sidebar GET form submits each checked box separately, not comma-joined.
    const s = filterStateFromURL(new URLSearchParams("license=sharealike&license=noncommercial"));
    expect(s.licenseTiers).toEqual(["sharealike", "noncommercial"]);
  });
  it("parses REPEATED modality params and dedupes across both encodings", () => {
    const s = filterStateFromURL(new URLSearchParams("modality=EEG&modality=MEG,EEG"));
    expect(s.modalities).toEqual(["EEG", "MEG"]);
  });
  it("ignores empty license values mixed with a valid one", () => {
    const s = filterStateFromURL(new URLSearchParams("license=&license=public"));
    expect(s.licenseTiers).toEqual(["public"]);
  });
  it("parses range filters", () => {
    const s = filterStateFromURL(new URLSearchParams("p_min=10&p_max=100"));
    expect(s.participants).toEqual({ min: 10, max: 100 });
  });
  it("parses flags", () => {
    const s = filterStateFromURL(new URLSearchParams("has_qa=1&has_hed=1"));
    expect(s.hasDataQuality).toBe(true);
    expect(s.hasHed).toBe(true);
    expect(s.has10_20).toBe(false);
  });
  it("clamps page to >=1", () => {
    expect(filterStateFromURL(new URLSearchParams("page=0")).page).toBe(1);
    expect(filterStateFromURL(new URLSearchParams("page=-3")).page).toBe(1);
    expect(filterStateFromURL(new URLSearchParams("page=4")).page).toBe(4);
  });
  it("falls back to newest for an unknown sort", () => {
    expect(filterStateFromURL(new URLSearchParams("sort=bogus")).sort).toBe("newest");
  });
  it("accepts the citations sort (#126)", () => {
    expect(filterStateFromURL(new URLSearchParams("sort=citations")).sort).toBe("citations");
  });
});

describe("filterStateToURL", () => {
  it("omits defaults", () => {
    const sp = filterStateToURL(defaultFilterState());
    expect(sp.toString()).toBe("");
  });
  it("serializes selected fields", () => {
    const s = defaultFilterState();
    s.q = "rest";
    s.modalities = ["EEG", "MEG"];
    s.modalityOp = "AND";
    s.participants = { min: 10, max: 100 };
    s.hasHed = true;
    s.sort = "participants";
    s.page = 2;
    const sp = filterStateToURL(s);
    expect(sp.get("q")).toBe("rest");
    expect(sp.get("modality")).toBe("EEG,MEG");
    expect(sp.get("modality_op")).toBe("AND");
    expect(sp.get("p_min")).toBe("10");
    expect(sp.get("p_max")).toBe("100");
    expect(sp.get("has_hed")).toBe("1");
    expect(sp.get("sort")).toBe("participants");
    expect(sp.get("page")).toBe("2");
  });
  it("serializes license tiers", () => {
    const s = defaultFilterState();
    s.licenseTiers = ["public", "attribution"];
    expect(filterStateToURL(s).get("license")).toBe("public,attribution");
  });
  it("roundtrips through URL", () => {
    const s = defaultFilterState();
    s.q = "motor";
    s.modalities = ["iEEG"];
    s.licenseTiers = ["sharealike", "noderiv"];
    s.participants = { min: 20, max: null };
    s.has10_20 = true;
    s.sort = "size";
    const parsed = filterStateFromURL(filterStateToURL(s));
    expect(parsed).toEqual({ ...s, pageSize: 10 });
  });
});

describe("filterStateToAPIQuery", () => {
  it("passes search through, sets large limit", () => {
    const s = defaultFilterState();
    s.q = "hbn";
    expect(filterStateToAPIQuery(s)).toEqual({ search: "hbn", sort: "newest", limit: 200 });
  });
  it("passes a single modality server-side", () => {
    const s = defaultFilterState();
    s.modalities = ["EEG"];
    expect(filterStateToAPIQuery(s)).toMatchObject({ modality: "EEG" });
  });
  it("omits modality when 2+ selected (post-filtered client-side)", () => {
    const s = defaultFilterState();
    s.modalities = ["EEG", "MEG"];
    const q = filterStateToAPIQuery(s);
    expect(q.modality).toBeUndefined();
  });
  it("passes license tiers server-side (OR, comma-joined)", () => {
    const s = defaultFilterState();
    s.licenseTiers = ["noncommercial", "noderiv"];
    expect(filterStateToAPIQuery(s).license).toBe("noncommercial,noderiv");
  });
  it("omits license when no tier is selected", () => {
    const q = filterStateToAPIQuery(defaultFilterState());
    expect(q.license).toBeUndefined();
  });
});

describe("applyClientFilters", () => {
  const datasets = [
    mkDataset({ dataset_id: "a", modalities: "eeg", participants: 10 }),
    mkDataset({ dataset_id: "b", modalities: "meg", participants: 50 }),
    mkDataset({ dataset_id: "c", modalities: "eeg,meg", participants: 100 }),
    mkDataset({ dataset_id: "d", modalities: "iEEG", participants: 5 }),
  ];

  it("OR across multiple modalities", () => {
    const s = defaultFilterState();
    s.modalities = ["EEG", "MEG"];
    const out = applyClientFilters(datasets, s).map((d) => d.dataset_id);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("AND across multiple modalities", () => {
    const s = defaultFilterState();
    s.modalities = ["EEG", "MEG"];
    s.modalityOp = "AND";
    const out = applyClientFilters(datasets, s).map((d) => d.dataset_id);
    expect(out).toEqual(["c"]);
  });

  it("does not apply modality filter when only one is selected (server already did)", () => {
    const s = defaultFilterState();
    s.modalities = ["EEG"];
    const out = applyClientFilters(datasets, s).map((d) => d.dataset_id);
    // All datasets pass through here because single-modality server-filtering
    // is delegated; client only applies multi-modality logic.
    expect(out).toEqual(["a", "b", "c", "d"]);
  });

  it("applies participant range", () => {
    const s = defaultFilterState();
    s.participants = { min: 20, max: null };
    const out = applyClientFilters(datasets, s).map((d) => d.dataset_id);
    expect(out).toEqual(["b", "c"]);
  });

  it("enforces a single modality client-side in search mode", () => {
    // The hybrid search endpoint doesn't filter by modality, so the search
    // path opts into client-side enforcement for even one selection.
    const s = defaultFilterState();
    s.modalities = ["EEG"];
    const out = applyClientFilters(datasets, s, { allModalitiesClientSide: true }).map(
      (d) => d.dataset_id,
    );
    expect(out).toEqual(["a", "c"]);
  });

  it("filters reduced search-result rows by modality + participants", () => {
    // applyClientFilters is generic over FilterableRow; the hybrid endpoint's
    // reduced projection (no license field) satisfies it.
    const results = [
      { id: "a", modalities: "eeg", participants: 10 },
      { id: "b", modalities: "meg", participants: 50 },
      { id: "c", modalities: "eeg,meg", participants: 100 },
    ];
    const s = defaultFilterState();
    s.modalities = ["EEG"];
    s.participants = { min: 50, max: null };
    const out = applyClientFilters(results, s, { allModalitiesClientSide: true }).map((r) => r.id);
    expect(out).toEqual(["c"]);
  });

  it("ignores license tiers (license is filtered server-side, not here)", () => {
    // License moved server-side via filterStateToAPIQuery; applyClientFilters
    // must not re-filter it (it no longer reads the license field at all).
    const s = defaultFilterState();
    s.licenseTiers = ["public"];
    const out = applyClientFilters(datasets, s).map((d) => d.dataset_id);
    expect(out).toEqual(["a", "b", "c", "d"]);
  });
});

describe("applyReservedKeyword", () => {
  it("flips EEG modality and reports consumed", () => {
    const s = defaultFilterState();
    const { state, consumed } = applyReservedKeyword(s, "eeg");
    expect(consumed).toBe(true);
    expect(state.modalities).toEqual(["EEG"]);
  });
  it("flips HED flag", () => {
    const s = defaultFilterState();
    const { state, consumed } = applyReservedKeyword(s, "HED");
    expect(consumed).toBe(true);
    expect(state.hasHed).toBe(true);
  });
  it("flips the expanded NIRS and motion modalities", () => {
    const nirs = applyReservedKeyword(defaultFilterState(), "nirs");
    expect(nirs.consumed).toBe(true);
    expect(nirs.state.modalities).toEqual(["NIRS"]);
    const motion = applyReservedKeyword(defaultFilterState(), "motion");
    expect(motion.consumed).toBe(true);
    expect(motion.state.modalities).toEqual(["MOTION"]);
  });
  it("does not consume non-reserved tokens", () => {
    const s = defaultFilterState();
    const { state, consumed } = applyReservedKeyword(s, "motor");
    expect(consumed).toBe(false);
    expect(state).toBe(s);
  });
  it("does not double-add an already-selected modality", () => {
    const s = defaultFilterState();
    s.modalities = ["EEG"];
    const { state } = applyReservedKeyword(s, "eeg");
    expect(state.modalities).toEqual(["EEG"]);
  });
});
