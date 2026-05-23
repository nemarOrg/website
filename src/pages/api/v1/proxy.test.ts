import { describe, expect, it } from "vitest";
import { isSafeProxyPath } from "./[...path]";

describe("isSafeProxyPath", () => {
  it.each([
    "datasets",
    "datasets/nm000103",
    "datasets/nm000103/publish/request",
    "admin/publish/requests",
    "datasets/nm000103/collaborators",
  ])("accepts the legitimate dashboard path %s", (path) => {
    expect(isSafeProxyPath(path)).toBe(true);
  });

  it("rejects undefined / empty", () => {
    expect(isSafeProxyPath(undefined)).toBe(false);
    expect(isSafeProxyPath("")).toBe(false);
  });

  it("rejects paths that start with /", () => {
    expect(isSafeProxyPath("/datasets")).toBe(false);
    expect(isSafeProxyPath("/admin/publish")).toBe(false);
  });

  it("rejects path traversal attempts", () => {
    expect(isSafeProxyPath("../auth/me")).toBe(false);
    expect(isSafeProxyPath("datasets/../auth/me")).toBe(false);
    // Astro decodes `%2F` etc. at the routing layer before this function
    // sees `params.path`, so URL-encoded traversal attempts never reach
    // here intact. The defense here is the literal-`..` check.
  });

  it("rejects absolute-URL injection attempts", () => {
    expect(isSafeProxyPath("https://evil.example/datasets")).toBe(false);
    expect(isSafeProxyPath("//evil.example/datasets")).toBe(false);
    expect(isSafeProxyPath("datasets?next=https://evil.example")).toBe(false);
    // Anything containing `://` is rejected even mid-string, because a
    // crafted path like `foo/https://evil.example` concatenated onto the
    // upstream base would otherwise become a URL with a different host.
  });
});
