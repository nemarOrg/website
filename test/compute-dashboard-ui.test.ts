/**
 * Wiring guards for the /compute dashboard (website ADR 0030 phase E2; epic nemarOrg/website#493).
 *
 * Source-level assertions, like `test/compute-access-ui.test.ts`: Astro files have no rendering harness
 * in this repo (page-level checks run against the dev server in a real browser), so reading the source
 * is the honest cheap check. The behavior of the pieces the page wires together has its own tests:
 * `compute-api.test.ts`, `compute-view.test.ts`, `compute-chart.test.ts`, `compute-format.test.ts`.
 */
import { describe, expect, it } from "vitest";
import ACCESS_PANEL from "../src/components/ComputeAccessPanel.astro?raw";
import BADGE from "../src/components/ComputeBadge.astro?raw";
import BALANCES from "../src/components/ComputeBalances.astro?raw";
import JOBS_TABLE from "../src/components/ComputeJobsTable.astro?raw";
import NOTICE from "../src/components/ComputePanelNotice.astro?raw";
import QUEUE from "../src/components/ComputeQueueTable.astro?raw";
import USAGE_CHART from "../src/components/ComputeUsageChart.astro?raw";
import USER_MENU from "../src/components/UserMenu.astro?raw";
import { ACCOUNT_COPY } from "../src/lib/account-copy";
import PAGE from "../src/pages/compute/index.astro?raw";
import SETTINGS from "../src/pages/settings.astro?raw";

const libs = import.meta.glob("/src/lib/compute-*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
// The admin Compute tab's libs are guarded by `compute-admin-ui.test.ts`; this file guards the person's
// dashboard. The admin client throttles its badge warning by the clock, which the window rule below
// forbids for the dashboard.
const ADMIN_LIBS = /\/compute-(admin-|decide-flow|row-dom)/;
const LIB_FILES = Object.entries(libs).filter(
  ([name]) => !name.endsWith(".test.ts") && !ADMIN_LIBS.test(name),
);

const COMPONENTS: Record<string, string> = {
  "ComputeAccessPanel.astro": ACCESS_PANEL,
  "ComputeBadge.astro": BADGE,
  "ComputeBalances.astro": BALANCES,
  "ComputeJobsTable.astro": JOBS_TABLE,
  "ComputePanelNotice.astro": NOTICE,
  "ComputeQueueTable.astro": QUEUE,
  "ComputeUsageChart.astro": USAGE_CHART,
};
const ALL_COMPUTE: Record<string, string> = {
  "pages/compute/index.astro": PAGE,
  ...COMPONENTS,
  ...Object.fromEntries(LIB_FILES),
};

/** Source with comments removed and runs of whitespace collapsed, so a formatter's line breaks do not matter. */
function flat(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
}

/** The markup and script of an Astro file, without its comments and its `<style>` blocks. */
function code(src: string): string {
  return src
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, "");
}

describe("the page", () => {
  it("redirects a signed-out visitor to login with next=/compute, before any read", () => {
    expect(PAGE).toContain("const session = getSession(Astro.locals);");
    expect(PAGE).toMatch(
      /if \(!session\) \{\s*return Astro\.redirect\(`\/login\?next=\$\{encodeURIComponent\("\/compute"\)\}`\);/,
    );
    expect(PAGE.indexOf("if (!session)")).toBeLessThan(PAGE.indexOf("getComputeMe("));
  });

  it("redirects a dead session found by the account read to login too", () => {
    expect(PAGE).toMatch(/meError\?\.kind === "session"/);
  });

  it("is never cached: balances change when a job settles", () => {
    expect(PAGE).toContain('Astro.response.headers.set("Cache-Control", "private, no-store");');
  });

  it("reads each of the three routes inside its own try/catch", () => {
    for (const read of [
      "attempt(() => getComputeMe(init))",
      "attempt<ComputeUsage>(() => getComputeUsage(init))",
      "attempt<ComputeJobsPage>(() => listComputeJobs({ after }, init))",
    ]) {
      expect(PAGE, read).toContain(read);
    }
    // `attempt` is the one try/catch, and it returns instead of throwing.
    expect(PAGE).toMatch(
      /async function attempt<T>[\s\S]{0,200}try \{[\s\S]{0,200}catch \(error\)/,
    );
    // The usage and job reads run in parallel, after the account read named the state.
    expect(PAGE).toContain("await Promise.all([");
    expect(PAGE.indexOf("const meRead")).toBeLessThan(PAGE.indexOf("await Promise.all(["));
  });

  it("builds each panel's view in its own try/catch, so a throw costs that panel", () => {
    expect(PAGE).toMatch(
      /function build<T>\(make: \(\) => T\)[\s\S]{0,200}try \{[\s\S]{0,200}catch \(error\)/,
    );
    for (const view of ["accessView(", "balancesView(", "queueView(", "usageView(", "jobsView("]) {
      expect(PAGE, view).toMatch(new RegExp(`build\\(\\(\\) => ${view.replace("(", "\\(")}`));
    }
  });

  it("calls the API over the service binding on the server (ADR 0026)", () => {
    expect(PAGE).toContain('import { apiFetch } from "../../lib/api-fetch";');
    expect(PAGE).toContain("const init: ComputeInit = { cookieHeader, fetch: apiFetch };");
  });

  it("asks for the server's default window and never builds a date from a clock", () => {
    expect(PAGE).toContain("getComputeUsage(init)");
    for (const [name, src] of Object.entries(ALL_COMPUTE)) {
      expect(code(src), name).not.toMatch(/Date\.now\(|new Date\(\)/);
    }
  });

  it("skips the reads for an unverified account and for states with nothing to read", () => {
    expect(flat(PAGE)).toContain("const meRead: Attempt<ComputeMe> | null = unverified ? null");
    expect(PAGE).toContain("plan.readLedger && plan.usage");
    expect(PAGE).toContain("plan.readLedger && plan.jobs");
  });

  it("says Compute is not available on a server that answers 404", () => {
    expect(flat(PAGE)).toContain('meError?.kind === "unavailable" && meError.status === 404');
    expect(PAGE).toContain("L.notice.notAvailableTitle");
  });

  it("shows the unverified line the way Settings does", () => {
    expect(PAGE).toContain('gapsForFields(["email_verified"], { block: "compute_access" })');
  });

  it("links the next page without JavaScript through ?after=", () => {
    expect(JOBS_TABLE).toContain("href={view.loadMoreHref}");
    expect(JOBS_TABLE).toContain("data-compute-load-more");
    expect(JOBS_TABLE).toContain("event.preventDefault()");
  });

  it("leaves a modified or non-primary click on Load more to the browser", () => {
    const script = flat(JOBS_TABLE.slice(JOBS_TABLE.indexOf("<script>")));
    expect(script).toMatch(
      /event\.button !== 0 \|\| event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey/,
    );
    expect(script.indexOf("event.metaKey")).toBeLessThan(script.indexOf("event.preventDefault()"));
  });

  it("prints 'No charges in this period.' only when the answer had no rows at all", () => {
    expect(flat(PAGE)).toContain("usage.data.pools.length === 0 && !usage.data.anyRows");
  });

  it("does not fetch usage when the account read failed (it could not be drawn)", () => {
    expect(flat(PAGE)).toContain("plan.readLedger && plan.usage && me ?");
  });

  it("gives a bad cursor the Jobs notice with a way back to the first page", () => {
    expect(PAGE).toContain('jobsRead.error.code === "invalid_cursor"');
    expect(PAGE).toContain("L.jobs.firstPage");
  });
});

describe("untrusted text stays inert", () => {
  const BANNED = ["innerHTML", "insertAdjacentHTML", "outerHTML", "set:html", "document.write"];

  it("no Compute file writes markup", () => {
    for (const [name, src] of Object.entries(ALL_COMPUTE)) {
      for (const api of BANNED) expect(code(src), `${name} uses ${api}`).not.toContain(api);
    }
  });

  it("the browser script builds rows with createElement and textContent only", () => {
    const dom = ALL_COMPUTE["/src/lib/compute-jobs-dom.ts"];
    expect(dom).toContain("createElement");
    expect(dom).toContain("textContent");
    expect(JOBS_TABLE).toContain("jobRowElement(document, view)");
  });

  it("a job id reaches an href only through the validated view", () => {
    expect(JOBS_TABLE).toContain("row.href ?");
    expect(ALL_COMPUTE["/src/lib/compute-view.ts"]).toContain("COMPUTE_JOB_ID_RE.test(job.id) ?");
  });
});

describe("the pools", () => {
  it("are read by name, never by iteration", () => {
    for (const [name, src] of Object.entries(ALL_COMPUTE)) {
      expect(code(src), name).not.toMatch(
        /Object\.(keys|values|entries)\([^)]*pools[^)]*\)|for \(const \w+ in [^)]*pools/,
      );
    }
    expect(ALL_COMPUTE["/src/lib/compute-api.ts"]).toContain("pools: { cpu: pool(pools.cpu");
  });

  it("never mention a partner-side or platform pool", () => {
    for (const [name, src] of Object.entries(ALL_COMPUTE)) {
      expect(code(src).toLowerCase(), name).not.toMatch(
        /tenant|institutional|covered by|platform remaining/,
      );
    }
  });

  it("are never added together on the page", () => {
    const view = ALL_COMPUTE["/src/lib/compute-view.ts"];
    expect(view).not.toMatch(/pools\.cpu\.\w+\s*\+\s*me\.pools\.gpu|cpu\.\w+_milli\s*\+\s*\w*gpu/);
    expect(view).not.toMatch(/sumMilli\(\[[^\]]*pools/);
  });
});

describe("the chart", () => {
  it("is an SVG image with a title, a description, a figure and a text fallback table", () => {
    expect(USAGE_CHART).toContain('role="img"');
    expect(USAGE_CHART).toContain("<title id={ids.title}>");
    expect(USAGE_CHART).toContain("<desc id={ids.desc}>");
    expect(USAGE_CHART).toContain("aria-labelledby={`${ids.title} ${ids.desc}`}");
    expect(USAGE_CHART).toContain("<figure");
    expect(USAGE_CHART).toContain("<figcaption");
    expect(USAGE_CHART).toContain("<details");
    expect(USAGE_CHART).toContain("<table");
  });

  it("stretches its SVG and keeps the axis labels as HTML", () => {
    expect(USAGE_CHART).toContain('preserveAspectRatio="none"');
    expect(USAGE_CHART).toContain('vector-effect="non-scaling-stroke"');
    expect(USAGE_CHART).not.toMatch(/<text[\s>]/);
  });

  it("does not animate, so prefers-reduced-motion is satisfied by construction", () => {
    for (const [name, src] of Object.entries(COMPONENTS)) {
      expect(flat(src), name).not.toMatch(/\banimation\b|\btransition\b|@keyframes/);
    }
  });

  it("uses no chart library", () => {
    for (const [name, src] of Object.entries(ALL_COMPUTE)) {
      expect(code(src), name).not.toMatch(
        /from "(chart\.js|d3|recharts|plotly|echarts|apexcharts)/,
      );
    }
  });

  it("separates the series by a surface-colored line as well as by color", () => {
    expect(USAGE_CHART).toMatch(/\.compute-chart__seg \{[^}]*stroke: var\(--admin-surface\)/);
  });

  it("hides the sparse x labels on desktop and the regular set on a phone", () => {
    expect(USAGE_CHART).toMatch(/compute-chart__xaxis--sparse \{\s*display: none;/);
    expect(USAGE_CHART).toMatch(
      /@media \(max-width: 480px\)[\s\S]*compute-chart__xaxis--regular \{\s*display: none;/,
    );
  });
});

describe("theming", () => {
  it("uses tokens, never a color literal, in any Compute component", () => {
    for (const [name, src] of Object.entries(COMPONENTS)) {
      const style = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1])
        .join("\n");
      expect(style, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(style, name).not.toMatch(/\brgba?\(|\bhsla?\(/);
    }
    const page = PAGE.slice(PAGE.indexOf("<style>"));
    expect(page).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("uses the chart tokens for the series", () => {
    for (const n of [1, 2, 3, 4]) expect(USAGE_CHART).toContain(`var(--chart-series-${n})`);
    expect(USAGE_CHART).toContain("var(--chart-grid)");
    expect(USAGE_CHART).toContain("var(--chart-axis)");
  });

  it("keeps the phone layout: a 16px gutter and no fixed page width", () => {
    expect(PAGE).toMatch(/\.compute-shell \{[^}]*padding: var\(--space-10\) var\(--space-4\)/);
    expect(PAGE).toMatch(/\.compute-shell \{[^}]*max-inline-size: 64rem/);
    expect(JOBS_TABLE).toContain("@media (max-width: 639px)");
    expect(JOBS_TABLE).toContain("attr(data-label)");
  });
});

describe("copy", () => {
  const KEY_RE = /ACCOUNT_COPY\[\s*(?:"([^"]+)"|`([^`]+)`)\s*\]/g;

  it("every ACCOUNT_COPY key a Compute file reads exists", () => {
    for (const [name, src] of Object.entries(ALL_COMPUTE)) {
      for (const m of src.matchAll(KEY_RE)) {
        const key = m[1] ?? m[2];
        if (key.includes("${")) continue; // the state-label lookup, covered by compute-view.test.ts
        expect(Object.hasOwn(ACCOUNT_COPY, key), `${name}: ${key}`).toBe(true);
      }
    }
  });

  it("every compute_page key has a consumer", () => {
    const all = Object.values(ALL_COMPUTE).join("\n");
    for (const key of Object.keys(ACCOUNT_COPY).filter((k) => k.startsWith("compute_page."))) {
      expect(all, key).toContain(`"${key}"`);
    }
  });

  it("types no long sentence at a call site: those live in compute-labels.ts or the copy table", () => {
    const offenders: string[] = [];
    for (const [name, src] of Object.entries(ALL_COMPUTE)) {
      if (name.endsWith("compute-labels.ts")) continue;
      const stripped = code(src);
      for (const m of stripped.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n]){40,})\1/g)) {
        // A message thrown for a developer (a RangeError) is not text a visitor reads.
        const before = stripped.slice(Math.max(0, (m.index ?? 0) - 24), m.index ?? 0);
        if (before.includes("RangeError(")) continue;
        if (m[2].includes(" ") && !m[2].includes("${") && !/^[./\w-]+$/.test(m[2])) {
          // Allow class lists, selectors and import-like strings: they have no sentence shape.
          if (/[.!?]$/.test(m[2]) || /\b(the|your|not|is|are)\b/i.test(m[2])) {
            offenders.push(`${name}: ${m[2]}`);
          }
        }
      }
      for (const m of stripped.matchAll(/>([^<>{}\n]{40,})</g)) {
        if (/\s/.test(m[1].trim())) offenders.push(`${name} (markup text): ${m[1].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the Access panel reads every sentence from the view, none from a literal", () => {
    expect(ACCESS_PANEL).toContain("view.paragraphs.map");
  });
});

describe("navigation", () => {
  it("the user menu links Compute for active, suspended and ended accounts only", () => {
    expect(USER_MENU).toContain("deriveComputeAccessState(session?.user)");
    expect(USER_MENU).toMatch(
      /computeState === "active" \|\| computeState === "suspended" \|\| computeState === "revoked"/,
    );
    expect(USER_MENU).toMatch(
      /\{showCompute && \(\s*<li role="none">\s*<a class="user-menu__item" href="\/compute"/,
    );
  });

  it("the Settings card links the compute page in its active state, from the shared copy", () => {
    expect(SETTINGS).toContain(
      '<a href="/compute">{ACCOUNT_COPY["compute_access.granted.link"]}</a>',
    );
    const active = SETTINGS.indexOf('compute.state === "active" && (');
    expect(active).toBeGreaterThan(-1);
    expect(SETTINGS.slice(active, active + 400)).toContain("/compute");
  });
});
