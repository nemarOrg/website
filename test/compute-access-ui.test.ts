/**
 * Wiring guards for the Settings compute-access card (website ADR 0030; epic
 * nemarOrg/website#493 phase E1).
 *
 * Source-level assertions, like `test/profile-gaps-ui.test.ts`: Astro files
 * have no rendering harness in this repo (page-level checks run against the
 * dev server in a real browser), so reading the source is the honest cheap
 * check. The behavior of the pieces the page wires together has its own
 * tests: `account-tier.test.ts`, `account-api.test.ts`, `refusal-list.test.ts`.
 */

import { describe, expect, it } from "vitest";
import PROFILE_NUDGE from "../src/components/ProfileNudge.astro?raw";
import { ACCOUNT_COPY } from "../src/lib/account-copy";
import REFUSAL_LIST from "../src/lib/refusal-list.ts?raw";
import DASHBOARD from "../src/pages/dashboard.astro?raw";
import SETTINGS from "../src/pages/settings.astro?raw";
import UPLOAD from "../src/pages/upload.astro?raw";

const script = SETTINGS.slice(SETTINGS.lastIndexOf("<script>"));
const computeScript = script.slice(
  script.indexOf("// ================= Compute access request"),
  script.indexOf("// ================= ORCID manage"),
);
const style = SETTINGS.slice(SETTINGS.indexOf("<style>"), SETTINGS.indexOf("</style>"));
const markup = SETTINGS.slice(SETTINGS.indexOf("<Base "), SETTINGS.indexOf("<style>"));

describe("the card", () => {
  it("sits after the upload-access card and before the CLI keys", () => {
    const upload = SETTINGS.indexOf('id="upload-access"');
    const compute = SETTINGS.indexOf('id="compute-access"');
    const keys = SETTINGS.indexOf('id="cli-keys"');
    expect(upload).toBeGreaterThan(-1);
    expect(compute).toBeGreaterThan(upload);
    expect(keys).toBeGreaterThan(compute);
  });

  it("is a wide card that names its state", () => {
    expect(SETTINGS).toMatch(
      /<article class="card card--wide" id="compute-access" data-compute-access-state=\{compute\.state\}>/,
    );
  });

  it("renders only when the backend said a state: absent is unknown, not 'Not requested'", () => {
    expect(SETTINGS).toContain("const compute = deriveComputeAccessState(session.user);");
    expect(SETTINGS).toMatch(/\{compute && \(\s*<article/);
  });

  it("reads its title and lede from the copy", () => {
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.section.title"]');
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.section.lede"]');
  });

  it("badges every state with its own copy, and dates only requested and active", () => {
    for (const state of ["none", "requested", "active", "suspended", "denied", "revoked"]) {
      expect(SETTINGS).toContain(`ACCOUNT_COPY["compute_access.state.${state}"]`);
    }
    expect(SETTINGS).toMatch(
      /compute\.state === "requested" && computeDate[\s\S]{0,80}on \{computeDate\}/,
    );
    expect(SETTINGS).toMatch(
      /compute\.state === "active" && computeDate[\s\S]{0,80}since \{computeDate\}/,
    );
  });

  it("renders a body for every state from the copy", () => {
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.terms_unpublished.body"]');
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.requested.lede_dated"]');
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.requested.lede"]');
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.requested.body"]');
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.granted.body"]');
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.suspended.body"]');
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.closed.body"]');
    expect(SETTINGS).toMatch(/compute\.state === "denied" \|\| compute\.state === "revoked"/);
  });

  it("gives the unverified tier the verify line and no form", () => {
    expect(SETTINGS).toContain('gapsForFields(["email_verified"], { block: "compute_access" })');
    expect(SETTINGS).toMatch(/tier === "unverified"/);
    expect(SETTINGS).toContain("data-compute-access-unverified");
  });

  it("offers the form only to a never-asked account while requests are open", () => {
    // A requested account gets no form: a request whose admin mail failed can
    // only be re-sent from the CLI.
    expect(SETTINGS).toMatch(
      /\{compute\.state === "none" && computeOpen && \(\s*<form\s+class="compute-access__form"/,
    );
    expect(SETTINGS).toMatch(/compute\.state === "none" && !computeOpen/);
    expect(SETTINGS).toContain("computeRequestsOpen(COMPUTE_REQUESTS_ENABLED, apiBase())");
  });

  it("links the docs explainer in a footnote", () => {
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.docs_link"]');
    expect(SETTINGS).toContain("DOCS_COMPUTE_ACCESS_PATH");
  });
});

describe("the form", () => {
  it("has the purpose textarea with its label, hint and code-point counter, and no maxlength", () => {
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.request.purpose_label"]');
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.request.purpose_hint"]');
    expect(SETTINGS).toContain("data-compute-access-count");
    expect(SETTINGS).toContain("{COMPUTE_PURPOSE_MAX_CHARS}");
    // maxlength counts UTF-16 units and would cut a 1,000 code-point text short.
    const textarea = markup.slice(
      markup.indexOf('id="compute-access-purpose"'),
      markup.indexOf("></textarea>", markup.indexOf('id="compute-access-purpose"')),
    );
    expect(textarea.length).toBeGreaterThan(0);
    expect(textarea).not.toContain("maxlength");
    expect(computeScript).toContain("[...purpose.value.trim()].length");
  });

  it("has a REQUIRED terms checkbox whose version text links the terms page", () => {
    expect(SETTINGS).toMatch(
      /<input\s+id="compute-access-terms"\s+type="checkbox"[\s\S]{0,80}required/,
    );
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.request.terms_label"]');
    // A new tab, so reading the terms does not lose the purpose draft.
    expect(SETTINGS).toMatch(
      /<a href=\{computeTermsUrl\} target="_blank" rel="external noopener noreferrer">\{COMPUTE_TERMS_VERSION\}<\/a>/,
    );
    expect(SETTINGS).toContain("DOCS_COMPUTE_TERMS_PATH");
  });

  it("sends the version the page printed, not a constant of its own", () => {
    expect(SETTINGS).toContain("data-terms-version={COMPUTE_TERMS_VERSION}");
    expect(computeScript).toContain("form.dataset.termsVersion");
  });

  it("has the submit button, the refusal box and an alert line", () => {
    expect(SETTINGS).toContain('ACCOUNT_COPY["compute_access.request.cta"]');
    expect(SETTINGS).toContain("data-compute-access-missing-list");
    expect(SETTINGS).toMatch(/role="alert" data-compute-access-msg hidden/);
    expect(SETTINGS).toContain('data-orcid-verified={orcidVerified ? "true" : "false"}');
  });

  it("promises no email on success, and names the state instead", () => {
    const success = computeScript.slice(
      computeScript.indexOf("await requestComputeAccess("),
      computeScript.indexOf("} catch (err)"),
    );
    expect(success.length).toBeGreaterThan(0);
    expect(success).toContain('ACCOUNT_COPY["compute_access.requested.title"]');
    // Code only: the comments above it explain WHY it promises nothing.
    const code = success
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/e-?mail/i);
  });

  it("maps each refusal the way the plan says", () => {
    expect(computeScript).toContain("computeAccessErrorMessage(status, code, detail, missing)");
    // The backend's sentence only, not the generic message the class falls back to.
    expect(computeScript).toContain("err.backendMessage");
    for (const code of ["email_not_verified", "orcid_not_proven", "profile_incomplete"]) {
      expect(computeScript).toContain(`"${code}"`);
    }
    // An empty list is not rendered as a heading over nothing: the message,
    // which the mapper made from the backend's sentence, is shown instead.
    expect(computeScript).toContain("LIST_CODES.includes(code) && missing.length > 0");
    expect(computeScript).toMatch(/\} else \{\s*setMsg\(msg, message, "error"\);/);
    expect(computeScript).toContain('code === "terms_unpublished"');
    expect(computeScript).toContain('"access_closed", "already_active"');
    expect(computeScript).toContain("purpose?.focus()");
  });
});

describe("the refusal renderer is shared, not copied", () => {
  it("is called by both request forms", () => {
    expect(SETTINGS).toContain(
      "renderRefusal(missingBox, missingList, missing, { orcidVerified })",
    );
    expect(computeScript).toContain(
      'renderRefusal(missingBox, missingList, missing, { orcidVerified, block: "compute_access" })',
    );
  });

  it("no longer has the upload card's inline loop", () => {
    expect(script).not.toContain("gapsForFields(");
    expect(script).not.toContain('document.createElement("li")');
    expect(script).not.toContain("describeGap(");
    expect(script).not.toContain("gapTail(");
  });

  it("sets text, never HTML", () => {
    expect(REFUSAL_LIST).toContain("textContent");
    expect(REFUSAL_LIST).toContain("createTextNode");
    expect(REFUSAL_LIST).not.toMatch(/\.innerHTML\s*=|insertAdjacentHTML|outerHTML/);
  });
});

describe("the Affiliation field", () => {
  it("carries the id the compute refusal links to", () => {
    expect(SETTINGS).toContain('id="profile-affiliation"');
  });

  it("is tagged for compute access only when the compute card renders", () => {
    expect(SETTINGS).toMatch(
      /Affiliation \{compute \? \(\s*<span class="field__req">needed \{ACCOUNT_COPY\["gap\.blocks\.compute_access"\]\}<\/span>\s*\) : \(\s*<span class="field__opt">optional<\/span>/,
    );
  });
});

describe("no compute sentence is typed at a call site", () => {
  const computeCopy = Object.entries(ACCOUNT_COPY).filter(([key]) =>
    key.startsWith("compute_access."),
  );

  it("finds every copy value only in the copy table", () => {
    expect(computeCopy.length).toBe(22);
    for (const [key, value] of computeCopy) {
      // A one- or two-word label ("Compute access") also appears in comments
      // and class names; the sentences are what must not be retyped.
      if (value.split(" ").length < 5) continue;
      expect(SETTINGS, key).not.toContain(value);
    }
  });

  it("types none of the sentences' recognizable fragments either", () => {
    for (const fragment of [
      "Not requested",
      "Request compute access",
      "terms are not published",
      "Your compute access is paused",
      "cannot be asked again",
      "starting allocation",
    ]) {
      expect(markup, fragment).not.toContain(fragment);
      expect(script, fragment).not.toContain(fragment);
    }
  });

  it("has a consumer for every compute copy key", () => {
    const sources = [SETTINGS, DASHBOARD, PROFILE_NUDGE].join("\n");
    for (const [key] of computeCopy) {
      if (key === "compute_access.request.purpose_hint") continue; // read by validatePurpose
      expect(sources, key).toContain(`"${key}"`);
    }
  });
});

describe("the styles", () => {
  it("sets the refusal box's display only while it is not hidden", () => {
    expect(style).toMatch(/\.compute-access__missing:not\(\[hidden\]\)\s*\{\s*display: block;/);
    expect(style).toMatch(/\.compute-access__missing\[hidden\]\s*\{\s*display: none;/);
  });

  it("keeps the two cards in step, with a sync comment on each side", () => {
    expect(style).toMatch(/Upload access[\s\S]{0,200}SYNC: the `\.compute-access__\*` rules/);
    expect(style).toMatch(/Compute access[\s\S]{0,200}SYNC: mirrors `\.upload-access__\*`/);
    for (const part of ["body", "form", "missing", "missing-title", "missing-list", "footnote"]) {
      expect(style, part).toContain(`.upload-access__${part}`);
      expect(style, part).toContain(`.compute-access__${part}`);
    }
  });

  it("uses tokens, not literal colors, in the compute rules", () => {
    const rules = style.slice(
      style.indexOf("Compute access (website ADR 0030)"),
      style.indexOf("CLI keys (epic"),
    );
    expect(rules.length).toBeGreaterThan(200);
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(rules).not.toMatch(/rgba?\(/);
  });
});

describe("nudges", () => {
  it("leave compute-only gaps out of the dashboard nudge and the Settings list", () => {
    expect(DASHBOARD).toContain("withoutComputeOnlyGaps(");
    expect(SETTINGS).toContain("withoutComputeOnlyGaps(");
    // The strings test/profile-gaps-ui.test.ts pins stay verbatim.
    expect(DASHBOARD).toContain("<ProfileNudge gaps={gaps} userId={session.user.id} />");
    expect(DASHBOARD).toContain("profileGaps({ ...session.user, username: identity.username })");
    expect(SETTINGS).toContain("profileGaps({ ...session.user, username: identity.username })");
  });

  it("leave /upload alone: it lists only the gaps that block the upload request", () => {
    expect(UPLOAD).not.toContain("withoutComputeOnlyGaps");
    expect(UPLOAD).toContain('"upload_access")');
  });
});
