/**
 * Minimal participants.tsv reader. The BIDS spec defines `participant_id`,
 * `sex` (preferred) or `gender` (deprecated-but-seen), and `age` as the three
 * columns we care about for the dataset detail Demographics tab. Anything
 * else in the TSV is ignored.
 *
 * Sex tokens are normalized to the same `"M" | "F" | "O" | null` alphabet
 * `bucketAgesBySex` in `./qa.ts` already consumes, so the new renderers can
 * pass parsed output through without further translation.
 */

const DEFAULT_DATA_BASE = "https://data.nemar.org";

/** Per-row normalized output. Order matches the input row order so the
 *  histogram can align `ages[i]` with `sexes[i]`. Rows with non-numeric
 *  ages contribute to `sexes` (and `sexCounts`) but NOT to `ages` — the
 *  age histogram would skip them anyway and forcing nulls into the array
 *  would propagate that filter into every caller. */
export interface ParticipantsData {
  total: number;
  ages: number[];
  sexes: Array<"M" | "F" | "O" | null>;
  sexCounts: { M: number; F: number; O: number };
}

function normalizeSex(raw: string | undefined): "M" | "F" | "O" | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "n/a" || t.toLowerCase() === "na") return null;
  // Common encodings: BIDS canonical "M"/"F", full words, lowercase, NIH numeric.
  if (/^(m|male|1)$/i.test(t)) return "M";
  if (/^(f|female|2)$/i.test(t)) return "F";
  return "O";
}

function parseAge(raw: string | undefined): number | null {
  if (raw == null) return null;
  const t = raw.trim();
  if (t === "" || t.toLowerCase() === "n/a" || t.toLowerCase() === "na") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Parse the body of a participants.tsv. Returns counts/arrays aligned with
 *  the `ParticipantsData` contract. Empty input or header-only input returns
 *  zeroed data. */
export function parseParticipantsTsv(text: string): ParticipantsData {
  const empty: ParticipantsData = {
    total: 0,
    ages: [],
    sexes: [],
    sexCounts: { M: 0, F: 0, O: 0 },
  };
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return empty;

  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  // Prefer canonical "sex"; fall back to "gender" (older OpenNeuro datasets).
  const sexIdx = (() => {
    const s = header.indexOf("sex");
    if (s !== -1) return s;
    return header.indexOf("gender");
  })();
  const ageIdx = header.indexOf("age");
  if (sexIdx === -1 && ageIdx === -1) {
    // The file exists but carries neither column. Caller renders empty state.
    return { ...empty, total: lines.length - 1 };
  }

  const ages: number[] = [];
  const sexes: Array<"M" | "F" | "O" | null> = [];
  let mCount = 0;
  let fCount = 0;
  let oCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const sex = sexIdx === -1 ? null : normalizeSex(cols[sexIdx]);
    const age = ageIdx === -1 ? null : parseAge(cols[ageIdx]);
    sexes.push(sex);
    if (age != null) ages.push(age);
    if (sex === "M") mCount++;
    else if (sex === "F") fCount++;
    else if (sex === "O") oCount++;
  }

  return {
    total: lines.length - 1,
    ages,
    sexes,
    sexCounts: { M: mCount, F: fCount, O: oCount },
  };
}

/** Compose the participants.tsv URL the Demographics panel fetches.
 *  Encoded per-segment so dataset ids with unusual characters round-trip. */
export function participantsUrl(datasetId: string, version: string, dataBase?: string): string {
  const root = (dataBase ?? DEFAULT_DATA_BASE).replace(/\/$/, "");
  return `${root}/${encodeURIComponent(datasetId)}/${encodeURIComponent(version)}/participants.tsv`;
}

/** Fetch + parse in one shot. Returns null on 404 (dataset simply doesn't
 *  ship a participants.tsv) so the caller can render its "no demographics"
 *  empty state. Returns null on other failures too, but logs them as
 *  errors so a 5xx regression or CORS misconfig at data.nemar.org is
 *  distinguishable from a genuine missing file in devtools. */
export async function fetchParticipants(
  datasetId: string,
  version: string,
  dataBase?: string,
): Promise<ParticipantsData | null> {
  const url = participantsUrl(datasetId, version, dataBase);
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`[participants/${datasetId}] ${res.status} ${res.statusText} for ${url}`);
      return null;
    }
    const text = await res.text();
    return parseParticipantsTsv(text);
  } catch (err) {
    console.error(`[participants/${datasetId}] network error for ${url}:`, err);
    return null;
  }
}
