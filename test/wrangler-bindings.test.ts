import { describe, expect, it } from "vitest";

/**
 * The Worker each project binds as `API` (ADR 0026). A service binding ignores the URL, so a
 * project bound to the wrong Worker counts its calls in the wrong environment without any error:
 * the production file must name `nemar-api`, the staging file `nemar-api-dev`, and previews, which
 * run unreviewed branch code, must have no binding at all.
 */
const files = import.meta.glob(["/wrangler.toml", "/wrangler.test.toml"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const production = files["/wrangler.toml"];
const staging = files["/wrangler.test.toml"];

const binds = (toml: string, service: string) =>
  new RegExp(`\\[\\[services\\]\\]\\s*\\nbinding = "API"\\s*\\nservice = "${service}"\\s*\\n`).test(
    toml,
  );

describe("the API service binding in the wrangler configs", () => {
  it("binds production to the production API Worker only", () => {
    expect(binds(production, "nemar-api")).toBe(true);
    expect(production).not.toContain("nemar-api-dev");
  });

  it("binds staging to the development API Worker only", () => {
    expect(binds(staging, "nemar-api-dev")).toBe(true);
    expect(binds(staging, "nemar-api")).toBe(false);
  });

  it("gives previews no binding, so a branch build cannot name a visitor at the production API", () => {
    expect(production).not.toMatch(/env\.preview\.services/);
    expect(staging).not.toMatch(/env\.preview\.services/);
  });
});
