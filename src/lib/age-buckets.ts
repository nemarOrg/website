/**
 * Age buckets split by sex, for the dataset page's Demographics chart
 * (`render-age-gender.ts`). Sex tokens are the `"M" | "F" | "O" | null`
 * alphabet `participants.ts` produces.
 */

/**
 * Bucket ages into ranges split by sex. `bucketWidth` and `bucketStart`
 * control the bin geometry; default to the legacy 10-year buckets starting
 * at zero. Callers that want bins fit to a dataset's actual age span
 * should use `pickAgeBuckets(ages)` and pass both values explicitly.
 */
export interface AgeBucket {
  label: string;
  lo: number;
  hi: number;
  M: number;
  F: number;
  O: number;
}

export function bucketAgesBySex(
  ages: number[],
  sexes: Array<"M" | "F" | "O" | null>,
  bucketWidth = 10,
  bucketStart = 0,
): AgeBucket[] {
  const validAges = ages.filter((a) => Number.isFinite(a) && a >= bucketStart);
  if (validAges.length === 0) return [];
  const max = Math.max(...validAges);
  const top = Math.ceil((max + 1 - bucketStart) / bucketWidth) * bucketWidth + bucketStart;
  const buckets: AgeBucket[] = [];
  for (let lo = bucketStart; lo < top; lo += bucketWidth) {
    const hi = lo + bucketWidth - 1;
    // Width-1 buckets render a single-age label ("8") instead of "8-8".
    const label = bucketWidth === 1 ? `${lo}` : `${lo}-${hi}`;
    buckets.push({ label, lo, hi, M: 0, F: 0, O: 0 });
  }
  for (let i = 0; i < ages.length; i++) {
    const a = ages[i];
    if (!Number.isFinite(a) || a < bucketStart) continue;
    const idx = Math.min(buckets.length - 1, Math.floor((a - bucketStart) / bucketWidth));
    const sex = sexes[i] ?? "O";
    if (sex === "M") buckets[idx].M++;
    else if (sex === "F") buckets[idx].F++;
    else buckets[idx].O++;
  }
  return buckets;
}

/**
 * Pick a "nice" bucket width + starting offset that fits the dataset's
 * actual age span into ~`targetCount` bins. Steps from the 1/2/5 series
 * (so labels stay legible at every zoom) and aligns the start to a
 * multiple of the chosen width below the minimum age.
 *
 * Examples:
 *   pickAgeBuckets([5..21])  → { width: 2, start: 4 }   → ~9 bins for HBN
 *   pickAgeBuckets([20..69]) → { width: 5, start: 20 }  → 10 bins
 *   pickAgeBuckets([])       → { width: 10, start: 0 }  → safe default
 */
export function pickAgeBuckets(ages: number[], targetCount = 10): { width: number; start: number } {
  const finite = ages.filter((a) => Number.isFinite(a) && a >= 0);
  if (finite.length === 0) return { width: 10, start: 0 };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = Math.max(1, max - min);
  const raw = span / targetCount;
  // Round up to the next step in the 1, 2, 5, 10, 20, 50, ... ladder so
  // tick labels stay human-friendly.
  const width =
    raw <= 1
      ? 1
      : raw <= 2
        ? 2
        : raw <= 5
          ? 5
          : raw <= 10
            ? 10
            : raw <= 20
              ? 20
              : raw <= 50
                ? 50
                : Math.ceil(raw / 10) * 10;
  const start = Math.floor(min / width) * width;
  return { width, start };
}
