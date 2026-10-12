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
