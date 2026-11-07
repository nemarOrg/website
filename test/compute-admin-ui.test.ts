/**
 * Source-level guards for the admin Compute tab (website ADR 0030; epic nemarOrg/website#493 phase
 * E4, issue #497), in the style of `admin-mail-ui.test.ts`: there is no Astro rendering harness in
 * this repo, so the sources are read through Vite's `?raw` and the properties that matter are
 * asserted on them. The behavior of the pieces the page wires together has its own tests:
 * `compute-admin-api.test.ts`, `compute-admin-view.test.ts` and `compute-decide-flow.test.ts`.
 *
 * What these protect: a purpose is typed by a stranger and must stay inert; no sentence is typed
 * in a page or component outside the shared copy; approval is one account at a time with no
 * default-focused confirm and no bulk action; the page sits behind the admin gate before it
 * fetches anything; and nothing owner-only is offered.
 */

import { describe, expect, it } from "vitest";
import CONFIRM_DIALOG from "../src/components/ConfirmDialog.astro?raw";
import DIALOG from "../src/components/admin/ComputeDecisionDialog.astro?raw";
import PILL from "../src/components/admin/ComputePill.astro?raw";
import ROW from "../src/components/admin/ComputeRequestRow.astro?raw";
import SECTION_ERROR from "../src/components/admin/ComputeSectionError.astro?raw";
import LAYOUT from "../src/layouts/AdminLayout.astro?raw";
import ACCOUNT_COPY_TEXT from "../src/lib/account-copy.ts?raw";
import { adminGate } from "../src/lib/admin-guard";
import API from "../src/lib/compute-admin-api.ts?raw";
import VIEW from "../src/lib/compute-admin-view.ts?raw";
import FLOW from "../src/lib/compute-decide-flow.ts?raw";
import ROW_DOM from "../src/lib/compute-row-dom.ts?raw";
import PAGE from "../src/pages/admin/compute.astro?raw";

/** A source without the comments that explain it, so a rule is checked against code only. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, "");
}

const MARKUP = { PAGE, ROW, DIALOG, PILL, SECTION_ERROR } as const;
const ALL = { ...MARKUP, API, VIEW, FLOW, ROW_DOM } as const;

describe("untrusted text is never rendered as markup", () => {
  it.each(Object.entries(ALL))("%s has no set:html", (_name, source) => {
    expect(code(source)).not.toContain("set:html");
  });

  it.each(Object.entries(ALL))(
    "%s has no innerHTML, insertAdjacentHTML or outerHTML",
    (_name, source) => {
      // Comments may name them; code may not.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
      expect(code).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    },
  );

  it("the page and the row never print a raw field of a served row", () => {
    // Every free-text value reaches the markup through a view model that escaped it.
    const raw =
      /(?<![.\w])(account|job|pool|row)\.(compute_purpose|given_name|family_name|affiliation|country|city|orcid|email|username|failure_detail|failure_code|slurm_job_id|holder_ref)\b/;
    expect(code(PAGE)).not.toMatch(raw);
    expect(code(ROW)).not.toMatch(raw);
  });

  it("puts the purpose in a wrapped, direction-aware text block with no link or image", () => {
    const start = ROW.indexOf('<section class="compute-row__purpose"');
    const block = ROW.slice(start, ROW.indexOf("</section>", start));
    expect(start).toBeGreaterThan(-1);
    expect(block).not.toMatch(/<a[\s>]|<img|<iframe|<script/);
    expect(block).toContain('dir="auto"');
    expect(ROW).toMatch(/\.compute-row__purpose-text \{[^}]*white-space: pre-wrap/);
    expect(block).toContain("<details");
  });

  it("links only to the Users tab, built from the model, and to orcid.org for an iD-shaped string", () => {
    const hrefs = [...ROW.matchAll(/href=\{([^}]+)\}/g)].map((m) => m[1]);
    expect(hrefs.sort()).toEqual(["model.orcid.href", "model.usersHref"]);
    // The view model builds both: the Users path from an encoded username, orcid.org only when
    // the string is shaped like an iD.
    expect(VIEW).toContain("`/admin/users/${encodeURIComponent(row.username)}`");
    expect(VIEW).toContain("isValidOrcid(orcidRaw)");
  });

  it("escapes every free-text value in the view model", () => {
    for (const field of ["row.email", "row.country", "row.city", "row.affiliation", "row.orcid"]) {
      expect(VIEW, field).toContain(field);
    }
    expect(VIEW).toContain("displaySafeLine");
    expect(VIEW).toContain("displaySafeBody");
  });

  it("writes into the row with textContent and attributes only", () => {
    expect(ROW_DOM).toContain("textContent");
    expect(ROW_DOM).not.toMatch(/\.html\s*=|document\.write/);
  });
});

describe("no sentence is typed in a page or component", () => {
  const SENTENCE_IN_QUOTES = /"[^"\n]*\b[A-Za-z]{3,} [A-Za-z]{3,} [A-Za-z]{3,}[^"\n]*"/;
  const TEXT_NODE = />[^<>{}\n]*\b[A-Za-z]{3,} [A-Za-z]{3,}[^<>{}\n]*</;

  function body(source: string): string {
    // The component's markup and script, without the comments that explain it and without
    // the style block.
    return source
      .replace(/<style>[\s\S]*?<\/style>/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1")
      .replace(/<!--[\s\S]*?-->/g, "");
  }

  it.each(Object.entries(MARKUP))("%s has no multi-word string literal", (_name, source) => {
    const lines = body(source)
      .split("\n")
      .filter((l) => !/^\s*import\b/.test(l) && !/\bclass(:list)?=/.test(l));
    for (const line of lines) {
      expect(line, line).not.toMatch(SENTENCE_IN_QUOTES);
    }
  });

  it.each(Object.entries(MARKUP))("%s has no multi-word text node", (_name, source) => {
    for (const line of body(source).split("\n")) {
      expect(line, line).not.toMatch(TEXT_NODE);
    }
  });

  it.each(Object.entries({ API, VIEW, FLOW, ROW_DOM }))(
    "%s has no multi-word string literal either: its words are copy keys or the backend's own",
    (_name, source) => {
      const lines = code(source)
        .split("\n")
        .filter(
          (l) =>
            !/^\s*import\b/.test(l) &&
            !/console\./.test(l) &&
            !/"\[[a-z-]+\]/.test(l) &&
            !/^\s*\*/.test(l),
        );
      for (const line of lines) {
        // Template literals and double-quoted strings alike.
        expect(line, line).not.toMatch(
          /["`][^"`\n]*\b[A-Za-z]{3,} [A-Za-z]{3,} [A-Za-z]{3,}[^"`\n]*["`]/,
        );
      }
    },
  );

  it("takes its words from the shared copy", () => {
    for (const key of [
      "compute_admin.page.lede",
      "compute_admin.page.cli_note",
      "compute_admin.page.order_note",
      "compute_admin.unavailable.usage_by_day",
      "compute_admin.unavailable.drift_difference",
      "compute_admin.drift.paused",
    ]) {
      expect(PAGE, key).toContain(`ACCOUNT_COPY["${key}"]`);
    }
    for (const key of [
      "compute_admin.row.stated_country",
      "compute_admin.row.stated_country_hint",
      "compute_admin.row.not_notified",
      "compute_admin.row.show_full_purpose",
    ]) {
      expect(ROW, key).toContain(`ACCOUNT_COPY["${key}"]`);
    }
    for (const key of [
      "compute_admin.dialog.reason_hint",
      "compute_admin.dialog.ack_export_review",
      "compute_admin.dialog.cancel",
    ]) {
      expect(DIALOG, key).toContain(`ACCOUNT_COPY["${key}"]`);
    }
  });
});

describe("approval is a person's decision", () => {
  it("never focuses the confirm button, and focuses Cancel on open", () => {
    const script = DIALOG.slice(DIALOG.indexOf("<script>"));
    expect(script).toContain("cancel?.focus()");
    expect(script).not.toMatch(/confirm\??\.focus\(/);
    expect(DIALOG).not.toContain("autofocus");
  });

  it("keeps the confirm button disabled until the acknowledgement or the typed word is done", () => {
    expect(DIALOG).toMatch(/data-confirm\s+disabled/);
    expect(DIALOG).toContain('decision !== "grant" || ack?.checked === true');
    expect(DIALOG).toContain('decision !== "revoke" || revokeInput?.value === revokeWord');
    expect(DIALOG).toMatch(/<input type="checkbox" data-ack-export \/>/);
    expect(DIALOG).not.toMatch(/data-ack-export[^>]*checked/);
  });

  it("sends nothing on Escape or Cancel: the confirm event fires only for a confirm", () => {
    expect(DIALOG).toContain('dialog.returnValue === "confirm"');
    expect(DIALOG).toContain('dialog.returnValue = "";');
    expect(DIALOG).toContain('cancel?.addEventListener("click", () => dialog.close("cancel"))');
  });

  it("caps the reason at the server's bound, counted as the server counts it", () => {
    expect(DIALOG).toContain("maxlength={COMPUTE_ACCESS_REASON_MAX_CHARS}");
    expect(DIALOG).toContain("reason.value.length");
  });

  it("opens the dialog on a click and decides only on its confirm event", () => {
    const script = PAGE.slice(PAGE.lastIndexOf("<script>"));
    expect(script).toContain('"nemar:compute-decision-open"');
    expect(script).toContain('"nemar:compute-decision-confirm"');
    // The click handler dispatches the open event and nothing else.
    const click = script.slice(
      script.indexOf('page.addEventListener("click"'),
      script.indexOf('document.addEventListener("nemar:compute-decision-confirm"'),
    );
    expect(click).not.toContain("flow.submit");
    expect(click).not.toContain("decideComputeAccess");
  });

  it("has no bulk action: one id per decision, no selection control, one POST in the client", () => {
    expect(API).toMatch(/export function decideComputeAccess\(\s*id: number,/);
    expect([...API.matchAll(/computeFetch\(\s*"POST"/g)]).toHaveLength(1);
    expect(FLOW).toContain("if (busy) return");
    for (const [name, source] of Object.entries({ PAGE, ROW })) {
      expect(source, name).not.toMatch(/type="checkbox"|select-all|selectAll|data-bulk/i);
    }
  });

  it("gives a decision its own, longer deadline than a read", () => {
    expect(code(API)).toContain("DECISION_TIMEOUT_MS = 25_000");
    expect(code(API)).toMatch(/parseDecisionResult, \{\s*body,\s*timeoutMs: DECISION_TIMEOUT_MS/);
  });

  it("hands the clicked button to the dialog so focus can return to it", () => {
    expect(PAGE).toContain("opener: button");
    expect(DIALOG).toContain("detail.opener");
  });

  it("never retries a POST on its own", () => {
    expect(code(FLOW)).not.toMatch(/for \(|while \(|retry/);
    expect(code(API)).not.toMatch(/retryPost|retries/);
  });

  it("leaves ConfirmDialog alone: this page does not use it and it knows nothing of compute", () => {
    expect(PAGE).not.toContain("ConfirmDialog");
    expect(CONFIRM_DIALOG).not.toMatch(/compute/i);
  });
});

describe("the gate and the owner-only line", () => {
  it("calls adminGate before the page fetches anything", () => {
    const gate = PAGE.indexOf("adminGate(session");
    const firstAwait = PAGE.indexOf("await ");
    expect(gate).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(gate);
    expect(PAGE.indexOf("return Astro.redirect(redirectTo)")).toBeLessThan(firstAwait);
  });

  it("answers an anonymous visitor with the login redirect, a member with /404, an admin with nothing", () => {
    const user = (role: "user" | "admin") => ({
      user: { id: "u_1", email: "p@example.org", role, status: "active" as const },
    });
    expect(adminGate(null, "/admin/compute")).toBe("/login?next=%2Fadmin%2Fcompute");
    expect(adminGate(user("user"), "/admin/compute")).toBe("/404");
    expect(adminGate(user("admin"), "/admin/compute")).toBeNull();
  });

  it("reads the role for one thing only, and offers nothing owner-only", () => {
    expect([...code(PAGE).matchAll(/backend_role/g)]).toHaveLength(1);
    // The tab calls no route that is owner-only or moves money.
    expect(API).not.toMatch(
      /\/policy|\/holds|\/records|move-charge|\/adjust|\/grant\b|\/cancel|\/advance/,
    );
    expect(code(API)).not.toContain('"PUT"');
    expect(code(API)).not.toContain('"DELETE"');
  });
});

describe("the page's honesty about what it could not read", () => {
  it("is never cached", () => {
    expect(code(PAGE)).toContain('Astro.response.headers.set("Cache-Control", "no-store")');
  });

  it("says when a pool group is cut off", () => {
    expect(PAGE).toContain('ACCOUNT_COPY["compute_admin.pools.truncated"]');
    expect(PAGE).toContain("next_after !== null");
  });

  it("says 'none waiting' only when reconciliation is known to be running", () => {
    expect(PAGE).toMatch(
      /reconciliation_paused === false \? \(\s*<p class="admin-empty__title">\{ACCOUNT_COPY\["compute_admin.drift.unmatched_none"\]\}/,
    );
    expect(PAGE).toContain('ACCOUNT_COPY["compute_admin.drift.pause_unknown"]');
  });

  it("does not describe the acknowledgement as a record", () => {
    expect(ACCOUNT_COPY_TEXT).not.toMatch(
      /ack_export_review"\s*:\s*"I (have )?(reviewed|completed)/,
    );
  });
});

describe("the layout badge", () => {
  it("reads the count in the shared Promise.all, fail-soft, and says what it counts", () => {
    expect(LAYOUT).toContain("fetchComputeRequestsCount({ cookieHeader })");
    expect(LAYOUT).toMatch(/Promise\.all\(\[[\s\S]*fetchComputeRequestsCount/);
    expect(LAYOUT).toContain('ACCOUNT_COPY["compute_admin.badge.awaiting_decision"]');
    expect(LAYOUT).toContain("requestsBadge(computeRequests)");
  });
});

describe("the sections that have no backend route say so", () => {
  it("names the missing reads and links the tracking issues, and derives nothing", () => {
    expect(PAGE).toContain('ACCOUNT_COPY["compute_admin.unavailable.usage_by_day"]');
    expect(PAGE).toContain('ACCOUNT_COPY["compute_admin.unavailable.drift_difference"]');
    expect(PAGE).toContain("${ISSUE_BASE}/2083");
    expect(PAGE).toContain("${ISSUE_BASE}/2084");
    // No tolerance is invented and no row is marked over it.
    expect(PAGE).not.toMatch(/tolerance[A-Za-z]*\s*[<>]|over_tolerance|overTolerance/);
  });

  it("reads each view's data as separate reads, so one failure degrades one section", () => {
    expect(PAGE).toContain("Promise.all([");
    expect(PAGE).toContain("async function read<T>");
    expect(PAGE).toMatch(/ok: false, error: failure\(/);
  });
});

describe("every compute_admin copy key has a consumer", () => {
  // The copy module's own rule 4 (account-copy.ts): a key with nothing reading it is copy that
  // cannot be seen, kept in step with another repo for nothing.
  const sources = import.meta.glob(["/src/**/*.astro", "/src/**/*.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;
  const readers = Object.entries(sources)
    .filter(([path]) => !path.endsWith(".test.ts") && !path.endsWith("/lib/account-copy.ts"))
    .map(([, source]) => source)
    .join("\n");

  it("is read by a page, a component or a view model", async () => {
    const { ACCOUNT_COPY } = await import("../src/lib/account-copy");
    const read = Object.keys(ACCOUNT_COPY)
      .filter((key) => key.startsWith("compute_admin."))
      .filter((key) => readers.includes(`"${key}"`));
    const all = Object.keys(ACCOUNT_COPY).filter((key) => key.startsWith("compute_admin."));
    expect(all.filter((k) => !read.includes(k))).toEqual([]);
  });
});
