/**
 * The hand-written guards (`src/lib/quality-views/guards.ts`) replay neuroschema's verdict corpus,
 * `views/vectors/kinds-verdicts.v1.json` (`nemar.kinds-verdicts.v1`): every case of a schema the
 * renderer checks, view declarations and the two JSON contents it reads, gets the corpus's verdict.
 *
 * The corpus's other schemas (`dataQuality`, the data paper and the dataset document) are read by
 * the dataset summary and the panel (phases W5 and W6), not by the drawing; they are counted here
 * so a new schema in the corpus is a decision, not a silent skip.
 */

import { describe, expect, it } from "vitest";
import { CONTENT_SCHEMAS, declarationValid } from "../src/lib/quality-views/guards";
import { COMPUTED_SCHEMAS } from "../src/lib/quality-views/guards-computed";
import { checkView } from "../src/lib/quality-views/kinds";
import { nodeFs, repoPath } from "./node";

interface VerdictCase {
  readonly name: string;
  readonly covers: string;
  readonly schema: string;
  readonly instance: unknown;
  readonly valid: boolean;
}

const fs = await nodeFs();
const corpus = JSON.parse(
  fs.readFileSync(repoPath("test/fixtures/quality-views/vectors/kinds-verdicts.v1.json"), "utf8"),
) as { format: string; cases: VerdictCase[] };

/** Schemas the drawing does not read, with the phase that does. */
const NOT_DRAWN: Readonly<Record<string, string>> = {
  dataQuality: "W5/W6",
  "definitions/dataPaper.schema.json": "W5",
  "neuroschema.schema.json": "W5",
};

function verdict(schema: string, instance: unknown): boolean {
  if (schema === "view") return declarationValid(instance, COMPUTED_SCHEMAS);
  const guard = CONTENT_SCHEMAS[schema];
  if (!guard) throw new Error(`no guard for ${schema}`);
  return guard(instance);
}

describe("the verdict corpus", () => {
  it("is nemar.kinds-verdicts.v1 and names only schemas this site has decided on", () => {
    expect(corpus.format).toBe("nemar.kinds-verdicts.v1");
    for (const c of corpus.cases) {
      expect(
        c.schema === "view" || c.schema in CONTENT_SCHEMAS || c.schema in NOT_DRAWN,
        c.schema,
      ).toBe(true);
    }
  });

  const replayed = corpus.cases.filter((c) => !(c.schema in NOT_DRAWN));
  it("replays at least the declaration and content cases", () => {
    expect(replayed.length).toBeGreaterThanOrEqual(230);
  });

  it.each(replayed.map((c) => [`${c.schema}: ${c.name}`, c] as const))("%s", (_label, c) => {
    expect(verdict(c.schema, c.instance), c.covers).toBe(c.valid);
  });
});

describe("the computed presets' schemas", () => {
  const computed = corpus.cases.filter(
    (c) =>
      c.schema === "view" &&
      /^nemar\.(ic-activity|signal-window)$/.test(String((c.instance as { kind?: unknown }).kind)),
  );

  it("are needed for every computed preset's case, and a check without them refuses to answer", () => {
    expect(computed.length).toBeGreaterThan(40);
    for (const c of computed) {
      expect(() => declarationValid(c.instance), c.name).toThrow();
      // The worker holds no such schemas: it leaves the view to the page.
      expect(checkView(c.instance), c.name).toBeNull();
      expect(checkView(c.instance, COMPUTED_SCHEMAS)?.valid, c.name).toBe(c.valid);
    }
  });
});
