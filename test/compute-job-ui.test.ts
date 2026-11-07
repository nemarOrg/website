/**
 * Wiring guards for the job page (website ADR 0030 phase E3; epic nemarOrg/website#493, issue #496).
 *
 * Source-level assertions, like `compute-dashboard-ui.test.ts`: Astro files have no rendering harness in
 * this repo, so reading the source is the honest cheap check; the browser check against the real local
 * backend covers the rest. The behavior of the pieces has its own tests: `compute-job-view.test.ts`,
 * `compute-logs.test.ts`, `compute-failure.test.ts`, `compute-api-job.test.ts`.
 */
import { describe, expect, it } from "vitest";
import ACTIONS from "../src/components/ComputeJobActions.astro?raw";
import LOGS from "../src/components/ComputeJobLogs.astro?raw";
import RESULTS from "../src/components/ComputeJobResults.astro?raw";
import TIMELINE from "../src/components/ComputeJobTimeline.astro?raw";
import PAGE from "../src/pages/compute/jobs/[id].astro?raw";

const libs = import.meta.glob("/src/lib/compute-*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every file that belongs to the job page. */
const JOB_LIBS = [
  "compute-job-view.ts",
  "compute-job-dom.ts",
  "compute-job-live.ts",
  "compute-job-page.ts",
  "compute-logs.ts",
  "compute-failure.ts",
  "compute-copy.ts",
];
const JOB: Record<string, string> = {
  "pages/compute/jobs/[id].astro": PAGE,
  "ComputeJobActions.astro": ACTIONS,
  "ComputeJobLogs.astro": LOGS,
  "ComputeJobResults.astro": RESULTS,
  "ComputeJobTimeline.astro": TIMELINE,
  ...Object.fromEntries(
    JOB_LIBS.map((name) => {
      const src = libs[`/src/lib/${name}`];
      if (src === undefined) throw new Error(`${name} is missing`);
      return [name, src];
    }),
  ),
};

function code(src: string): string {
  return src
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, "");
}
const flat = (src: string): string => code(src).replace(/\s+/g, " ");

/** The frontmatter of the page: everything before the closing fence. */
const FRONTMATTER = PAGE.slice(PAGE.indexOf("---") + 3, PAGE.indexOf("\n---", 4));
const PAGE_SCRIPT = PAGE.slice(PAGE.indexOf("<script>"));

describe("untrusted text is inert", () => {
  const BANNED = [
    "innerHTML",
    "outerHTML",
    "insertAdjacentHTML",
    "document.write",
    "DOMParser",
    "createContextualFragment",
    "set:html",
    "srcdoc",
  ];
  it("no job file writes markup", () => {
    for (const [name, src] of Object.entries(JOB)) {
      for (const api of BANNED) expect(code(src), `${name} uses ${api}`).not.toContain(api);
    }
  });

  it("the script builds nodes with createElement and textContent", () => {
    expect(JOB["compute-job-dom.ts"]).toContain("createElement");
    expect(JOB["compute-job-dom.ts"]).toContain("textContent");
    expect(code(JOB["compute-job-page.ts"])).toContain("logsPre.textContent = w.text");
  });
});

describe("result links are bearer links", () => {
  it("the page's frontmatter and its components never import the log or result clients", () => {
    for (const word of ["getComputeResults", "renewComputeResults", "getComputeLogs"]) {
      expect(FRONTMATTER, word).not.toContain(word);
      expect(PAGE_SCRIPT, word).not.toContain(word);
      for (const name of [
        "ComputeJobActions.astro",
        "ComputeJobLogs.astro",
        "ComputeJobResults.astro",
        "ComputeJobTimeline.astro",
      ]) {
        expect(code(JOB[name]), `${name} ${word}`).not.toContain(word);
      }
    }
  });

  it("only the controller calls the result clients, and only from a click handler", () => {
    const page = JOB["compute-job-page.ts"];
    const calls = [...code(page).matchAll(/(getComputeResults|renewComputeResults)\(/g)];
    expect(calls.length).toBe(2);
    // Both calls are inside fetchResults, which only the five button handlers reach.
    const fetchResults = code(page).slice(code(page).indexOf("async function fetchResults"));
    expect(fetchResults.indexOf("getComputeResults(")).toBeGreaterThan(-1);
    expect(code(page).slice(0, code(page).indexOf("async function fetchResults"))).not.toMatch(
      /getComputeResults\(|renewComputeResults\(/,
    );
    // The poller never reaches them.
    const poller = code(page).slice(
      code(page).indexOf("const poller"),
      code(page).indexOf("pausedButton.addEventListener"),
    );
    expect(poller).not.toMatch(/Results|fetchResults/);
  });

  it("an href is assigned only from safeResultHref, in the one DOM builder", () => {
    for (const [name, src] of Object.entries(JOB)) {
      const c = code(src);
      const hrefs = [...c.matchAll(/setAttribute\(\s*"href"|\.href\s*=/g)];
      if (name === "compute-job-dom.ts") {
        expect(hrefs.length, name).toBe(1);
        expect(c).toContain("if (row.href)");
      } else {
        expect(hrefs.length, name).toBe(0);
      }
    }
    expect(JOB["compute-job-view.ts"]).toContain("href: safeResultHref(file.url)");
  });

  it("every result anchor carries rel noopener noreferrer, no referrer and a new tab", () => {
    const dom = flat(JOB["compute-job-dom.ts"]);
    expect(dom).toContain('a.setAttribute("rel", "noopener noreferrer")');
    expect(dom).toContain('a.setAttribute("referrerpolicy", "no-referrer")');
    expect(dom).toContain('a.setAttribute("target", "_blank")');
  });

  it("no job file stores, logs, copies or navigates with a link or a log", () => {
    for (const [name, src] of Object.entries(JOB)) {
      const c = code(src);
      for (const banned of [
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "console.",
        "clipboard",
        "location.hash",
        "location.search",
        "history.",
        "document.cookie",
        "caches.",
      ]) {
        // The page frontmatter logs server-side failure classes (status words only, never a body).
        if (name === "pages/compute/jobs/[id].astro" && banned === "console.") continue;
        expect(c, `${name} uses ${banned}`).not.toContain(banned);
      }
    }
  });

  it("the frontmatter logs a failure class and never a body", () => {
    const logged = [...FRONTMATTER.matchAll(/console\.error\(([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(logged.length).toBeGreaterThan(0);
    for (const l of logged) expect(l).not.toMatch(/\.url|files|text\(|sentence/);
  });

  it("clears the list when a page comes back from the back-forward cache", () => {
    expect(flat(JOB["compute-job-page.ts"])).toMatch(
      /"pageshow", \(event\) => \{ if \(event\.persisted\)/,
    );
  });

  it("the server renders no link and no address of a result", () => {
    expect(RESULTS).not.toMatch(/href=\{?["'`]?(https?:|\{)/);
    expect(RESULTS).toContain("data-results-list></ul>");
    expect(code(PAGE)).not.toMatch(/\.url\b/);
  });
});

describe("the page", () => {
  it("sets private, no-store and no-referrer before the first return", () => {
    const firstReturn = FRONTMATTER.indexOf("return ");
    for (const header of [
      'Astro.response.headers.set("Cache-Control", "private, no-store");',
      'Astro.response.headers.set("Referrer-Policy", "no-referrer");',
    ]) {
      expect(FRONTMATTER, header).toContain(header);
      expect(FRONTMATTER.indexOf(header), header).toBeLessThan(firstReturn);
    }
  });

  it("sends a signed-out visitor to login with next=this path, before any read", () => {
    expect(FRONTMATTER).toContain("const path = `/compute/jobs/${id}`;");
    expect(FRONTMATTER).toMatch(
      /if \(!session\) \{\s*return Astro\.redirect\(`\/login\?next=\$\{encodeURIComponent\(path\)\}`\);/,
    );
    expect(FRONTMATTER.indexOf("if (!session)")).toBeLessThan(
      FRONTMATTER.indexOf("getComputeJob("),
    );
  });

  it("answers the same 404 for a malformed id without calling the API, and for job_not_found", () => {
    const f = flat(FRONTMATTER);
    expect(f).toContain('if (!COMPUTE_JOB_ID_RE.test(id)) { outcome = { kind: "not_found" };');
    expect(f).toContain('error.code === "job_not_found"');
    expect(f).toContain('if (outcome.kind === "not_found") Astro.response.status = 404;');
    // One page for both: the not-found markup appears once.
    expect(PAGE.match(/L\.notFoundTitle/g)?.length).toBe(1);
  });

  it("tells a bare 404 (an API without the compute routes) from a missing job by the code", () => {
    expect(flat(FRONTMATTER)).toContain('error.kind === "unavailable" && error.status === 404');
  });

  it("reads the job over the service binding with the visitor's cookie", () => {
    expect(FRONTMATTER).toContain("const init: ComputeInit = { cookieHeader, fetch: apiFetch };");
  });

  it("reads the retention policy only for a finished job, in its own try/catch", () => {
    expect(flat(FRONTMATTER)).toMatch(
      /outcome\.read\.job\.state === "finished"\) \{ try \{ resultsDays = \(await getComputeMe\(init\)\)\.resultsDays; \} catch/,
    );
  });

  it("is edge-cache safe: the middleware bypass is pinned in middleware.test.ts", () => {
    expect(PAGE).toContain("private, no-store");
  });

  it("offers cancel through the shared ConfirmDialog, in the danger tone", () => {
    expect(ACTIONS).toContain("<ConfirmDialog");
    expect(ACTIONS).toContain('dialogId="compute-cancel"');
    expect(ACTIONS).toContain('confirmTone="danger"');
    expect(JOB["compute-job-page.ts"]).toContain('"nemar:open-confirm-dialog"');
    expect(JOB["compute-job-page.ts"]).toContain('"nemar:confirm-dialog-confirm"');
  });

  it("guards a double cancel and returns focus to the status line", () => {
    const page = flat(JOB["compute-job-page.ts"]);
    expect(page).toContain("if (cancelBusy) return; cancelBusy = true;");
    expect(page).toContain("cancelStatus.focus()");
  });
});

describe("clocks and timers", () => {
  it("no job file reads a clock except the poller module and the page's use of its nowMs", () => {
    for (const [name, src] of Object.entries(JOB)) {
      if (name === "compute-job-live.ts") continue;
      expect(code(src), name).not.toMatch(/Date\.now\(|new Date\(\)|performance\.now|setInterval/);
    }
    expect(JOB["compute-job-live.ts"]).not.toContain("setInterval(");
  });

  it("the pure view module has no timer at all", () => {
    expect(code(JOB["compute-job-view.ts"])).not.toMatch(/setTimeout|setInterval|Math\.random/);
  });

  it("the poller aborts on a hidden tab and on pagehide, and restarts on visible", () => {
    const live = flat(JOB["compute-job-live.ts"]);
    expect(live).toContain('"visibilitychange"');
    expect(live).toContain('"pagehide"');
    expect(live).toContain('apply({ kind: "hidden" })');
    expect(live).toContain('kind: "visible"');
  });

  it("the page only starts the poller for a live job", () => {
    expect(flat(JOB["compute-job-page.ts"])).toContain(
      'if (root.dataset.live === "true") poller.start();',
    );
    expect(PAGE).toContain("data-live={String(view.live)}");
  });
});

describe("theming and layout", () => {
  it("uses tokens, never a color literal, in any job style", () => {
    for (const [name, src] of Object.entries(JOB)) {
      const style = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1])
        .join("\n");
      expect(style, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(style, name).not.toMatch(/\brgba?\(|\bhsla?\(/);
    }
  });

  it("keeps a 16px gutter and no fixed page width", () => {
    expect(PAGE).toMatch(/\.compute-job \{[^}]*padding: var\(--space-10\) var\(--space-4\)/);
    expect(PAGE).toMatch(/\.compute-job \{[^}]*max-inline-size: 64rem/);
  });

  it("stacks the result rows and the detail rows on a phone", () => {
    expect(RESULTS).toContain("@media (max-width: 639px)");
    expect(TIMELINE).toContain("@media (max-width: 639px)");
  });

  it("does not animate, so reduced motion is satisfied by construction", () => {
    for (const [name, src] of Object.entries(JOB)) {
      const style = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1])
        .join("\n");
      expect(style, name).not.toMatch(/\banimation\b|\btransition\b|@keyframes/);
    }
  });

  it("scrollable regions are focusable and named", () => {
    expect(LOGS).toMatch(/tabindex="0" role="region" aria-label=\{L\.region\}/);
    expect(RESULTS).toMatch(/tabindex="0" role="region" aria-label=\{L\.region\}/);
  });

  it("announces a state change in a polite live region", () => {
    expect(PAGE).toContain('aria-live="polite" data-job-announce');
  });
});

describe("copy", () => {
  it("keeps the sentences in the copy files and types none at a call site", () => {
    const offenders: string[] = [];
    for (const [name, src] of Object.entries(JOB)) {
      if (/compute-(copy|failure)\.ts$/.test(name)) continue;
      const stripped = code(src);
      for (const m of stripped.matchAll(/>([^<>{}\n]{40,})</g)) {
        if (/\s/.test(m[1].trim())) offenders.push(`${name} (markup text): ${m[1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("adds no key to the shared copy table", () => {
    for (const [name, src] of Object.entries(JOB)) {
      for (const m of code(src).matchAll(/ACCOUNT_COPY\[\s*"([^"]+)"/g)) {
        expect(
          ["compute_page.unreported_note", "compute_page.units_note"],
          `${name} ${m[1]}`,
        ).toContain(m[1]);
      }
    }
  });
});
