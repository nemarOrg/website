import { describe, expect, it } from "vitest";
import { APP_VERSION, BUILD_ID, BUILD_REF, buildInfo } from "./build-info";

/**
 * These run without `astro.config.mjs`'s `vite.define`, so they exercise the
 * fallback branch specifically.
 *
 * That is the branch worth pinning. `__APP_VERSION__` is a compile-time text
 * substitution, not an import, so a bare reference to it in a context that
 * never defined it is a ReferenceError thrown at module load — which in the
 * middleware means every request 500s, not just the version endpoint. The
 * `typeof` guards are what stop that, and nothing else in the suite would
 * notice if they were removed during a refactor.
 *
 * The injected values are verified against a real build instead: after
 * `bun run build`, `dist/_worker.js` contains the literal package.json
 * version, and a deployed host answers with it on `x-nemar-version`.
 */
describe("build-info fallbacks", () => {
  it("falls back instead of throwing when the build defines are absent", () => {
    expect(APP_VERSION).toBe("0.0.0");
    expect(BUILD_REF).toBe("dev");
  });

  it("joins version and ref with semver build-metadata syntax", () => {
    expect(BUILD_ID).toBe(`${APP_VERSION}+${BUILD_REF}`);
    expect(BUILD_ID).toBe("0.0.0+dev");
  });

  it("reports the same values through the structured accessor", () => {
    expect(buildInfo()).toEqual({
      version: APP_VERSION,
      commit: BUILD_REF,
      buildId: BUILD_ID,
    });
  });
});
