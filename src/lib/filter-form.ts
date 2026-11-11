import { defaultFilterState } from "./filters";

/**
 * Values the filter form submits when a control is untouched; the server reads
 * their absence as the same thing. Taken from the server's own defaults, so the
 * form script cannot keep stripping a choice after a default changes.
 */
const defaults = defaultFilterState();
export const FORM_DEFAULTS: Readonly<Record<string, string>> = {
  modality_op: defaults.modalityOp,
  sort: defaults.sort,
};

/** Whether a submitted field adds nothing to the address: empty, or its default. */
export function isRedundantField(name: string, value: FormDataEntryValue): boolean {
  return value === "" || FORM_DEFAULTS[name] === value;
}

/** What the browser's `formdata` handler keeps. */
export function pruneFormEntries(
  entries: Iterable<[string, FormDataEntryValue]>,
): [string, FormDataEntryValue][] {
  return [...entries].filter(([name, value]) => !isRedundantField(name, value));
}

/**
 * Whether a submit's `exact=1` no longer applies: the reader typed other words
 * than the page was showing. `exact` means "search the words I wrote instead of
 * the corrected ones", so it belongs to those words; carried onto a new query it
 * would switch off the correction the reader has not yet seen. Filter changes and
 * paging keep the same words and so keep it.
 */
export function isStaleExact(
  submittedQuery: FormDataEntryValue | null,
  pageQuery: string,
): boolean {
  return String(submittedQuery ?? "").trim() !== pageQuery.trim();
}
