import { describe, expect, it } from "vitest";
import { isAuthorizationProxyPath, isSafeProxyPath } from "./proxy-path";

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

  it("rejects userinfo-style `@` in path", () => {
    // `evil.example@api.nemar.org/datasets` could be reinterpreted by
    // some URL parsers as authority `evil.example` with userinfo
    // `api.nemar.org`. Whether `fetch` would honor that is uncertain;
    // we belt-and-braces reject `@` entirely.
    expect(isSafeProxyPath("datasets@evil.example/foo")).toBe(false);
    expect(isSafeProxyPath("evil.example@api.nemar.org/datasets")).toBe(false);
  });

  it("rejects double-slash sequences that would produce malformed upstream URLs", () => {
    expect(isSafeProxyPath("datasets//")).toBe(false);
    expect(isSafeProxyPath("datasets//foo")).toBe(false);
    expect(isSafeProxyPath("admin//publish/requests")).toBe(false);
  });
});

describe("isAuthorizationProxyPath", () => {
  // Answers of the OpenID Connect authorization routes carry codes and consent tokens, which only
  // the /oauth/authorize page's server code may read, so the browser proxy refuses every spelling
  // that reaches them.
  it.each([
    "auth/oidc/authorize",
    "auth/oidc/consent",
    "auth/oidc",
    "auth/oidc/",
    "Auth/OIDC/Authorize",
    "auth/%6Fidc/authorize",
    "auth/%256Fidc/authorize",
    "auth%2Foidc%2Fauthorize",
    "auth/./oidc/authorize",
    "auth/oidc/./consent",
    "auth/oidc/authorize?x=1",
    // A query on the `oidc` segment itself: only the query strip lets the pair match.
    "auth/oidc?x=1",
    "nemar/auth/oidc/authorize",
    "./auth/oidc/authorize",
  ])("refuses %s", (path) => {
    expect(isAuthorizationProxyPath(path)).toBe(true);
  });

  it.each([
    "auth/me",
    "auth/oidcx/authorize",
    "auth/oauth/authorize",
    "datasets/oidc",
    "auth/private/grant",
    "auth/docs/grant",
  ])("leaves %s alone", (path) => {
    expect(isAuthorizationProxyPath(path)).toBe(false);
  });
});
