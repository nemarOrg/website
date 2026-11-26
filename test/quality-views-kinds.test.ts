/**
 * The renderer rule's table of kinds (`kinds.ts`) is the vendored registry's: every kind, version
 * and base, in the registry's order, and nothing else.
 */

import { describe, expect, it } from "vitest";
import { KIND_TABLE } from "../src/lib/quality-views/kinds";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const registry = JSON.parse(
  fs.readFileSync(repoPath("src/lib/quality-views/vocabulary/registry.json"), "utf8"),
) as {
  kinds: { kind: string; kind_version: number; base: string | null; base_version: number | null }[];
};

describe("the table of kinds", () => {
  it("is the registry's kinds, versions and bases", () => {
    expect(KIND_TABLE).toEqual(
      registry.kinds.map(({ kind, kind_version, base, base_version }) => ({
        kind,
        kind_version,
        base,
        base_version,
      })),
    );
  });
});
