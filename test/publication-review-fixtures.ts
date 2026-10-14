/**
 * The captured answers of the publication review's API, read by name.
 *
 * Each file in `test/fixtures/publication-review/` is one real answer of the nemar-cli Worker:
 * `{ _provenance, status, body }`. They were captured by driving the Worker's real routes over a
 * real SQLite database with the nemar-cli backend test harness (a stand-in answers only at the
 * GitHub boundary), and `_provenance` says which nemar-cli commit, which seed and which request
 * produced each. Nothing here is typed from memory of the contract.
 *
 * Refreshing: when the nemar-cli contract moves, re-run the capture at the new nemar-cli head and
 * replace the files. The diff shows exactly which words or fields moved; update the page's types
 * and the mirrored copy keys if it says so, and the typed tests go red first where a field
 * vanished. The capture script is not committed; the pull request that last refreshed the files
 * describes how it was run.
 *
 * Not a `.test.ts` file on purpose: vitest collects only `*.test.ts`, and Biome's
 * `noExportsInTest` forbids exporting from one (the arrangement of `test/copy-drift.ts`).
 */

/** The six keys every file's `_provenance` carries. */
export interface Provenance {
  captured_from: string;
  nemar_cli_commit: string;
  captured_on: string;
  scenario: string;
  request: string;
  note: string;
}

/** A file as it is on disk. `body` is whatever the Worker answered. */
export interface Envelope {
  _provenance: Provenance;
  status: number;
  body: unknown;
}

/** A captured answer, as a test reads it. */
export interface Captured<T> {
  status: number;
  body: T;
}

const files = import.meta.glob<Envelope>("./fixtures/publication-review/*.json", {
  eager: true,
  import: "default",
});

const byName = new Map<string, Envelope>(
  Object.entries(files).map(([path, envelope]) => [
    (path.split("/").pop() as string).replace(/\.json$/, ""),
    envelope,
  ]),
);

/** Every captured name, in file order. */
export function fixtureNames(): string[] {
  return [...byName.keys()];
}

/** Every file whole, with its provenance, for the guard test. */
export function envelopes(): { name: string; envelope: Envelope }[] {
  return [...byName.entries()].map(([name, envelope]) => ({ name, envelope }));
}

/**
 * One captured answer by name. The single cast in this file is here: JSON imports are widened to
 * their literals' types, so the body is asserted to be the page's `T`, and a test that wants the
 * captured shape to be checked reads it as `unknown` and narrows.
 */
export function fixture<T>(name: string): Captured<T> {
  const envelope = byName.get(name);
  if (!envelope) {
    throw new Error(
      `no captured review fixture named "${name}" (have: ${fixtureNames().join(", ")})`,
    );
  }
  return { status: envelope.status, body: envelope.body as T };
}

/** The captured answer as the `Response` a `fetch` would have returned, for a test's fetch. */
export function asResponse(f: Captured<unknown>): Response {
  return new Response(JSON.stringify(f.body), {
    status: f.status,
    headers: { "Content-Type": "application/json" },
  });
}
