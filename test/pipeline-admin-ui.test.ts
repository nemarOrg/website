/**
 * Source-level guards for the admin Pipelines tab (nemar-cli ADR 0134 decision 5; epic
 * nemarOrg/nemar-cli#2324 phase 4b, website#586), in the style of `compute-admin-ui.test.ts`: there
 * is no Astro rendering harness here, so the sources are read through Vite's `?raw` and the
 * properties that matter are asserted on them. The pieces' behavior has its own tests:
 * `compute-pipeline-api.test.ts`, `compute-pipeline-view.test.ts` and the CLI parity test.
 *
 * What these protect: backend text stays inert (a recording path is derived from a dataset); no
 * sentence is typed in a page or component outside `compute-pipeline-labels.ts`; each page is
 * behind the admin gate before it fetches and is never cached; and the website never asks the
 * Worker to sync.
 */

import { describe, expect, it } from "vitest";
import PANEL from "../src/components/admin/PipelineCoveragePanel.astro?raw";
import TABLE from "../src/components/admin/PipelineGridTable.astro?raw";
import LEGEND from "../src/components/admin/PipelineLegend.astro?raw";
import API from "../src/lib/compute-pipeline-api.ts?raw";
import { PIPELINE_LABELS } from "../src/lib/compute-pipeline-labels";
import VIEW from "../src/lib/compute-pipeline-view.ts?raw";
import QAPI from "../src/lib/pipeline-quality-api.ts?raw";
import { PIPELINE_QUALITY_LABELS } from "../src/lib/pipeline-quality-labels";
import QVIEW from "../src/lib/pipeline-quality-view.ts?raw";
import DRILL from "../src/lib/quality-views/admin-drill.ts?raw";
import PROXY from "../src/lib/quality-views/admin-proxy.ts?raw";
import OVERVIEW from "../src/pages/admin/index.astro?raw";
import GRID from "../src/pages/admin/pipelines/[recipe].astro?raw";
import LANDING from "../src/pages/admin/pipelines/index.astro?raw";
import RUN from "../src/pages/admin/pipelines/runs/[stamp].astro?raw";
import QUALITY from "../src/pages/admin/pipelines/runs/[stamp]/quality.astro?raw";
import PROXY_ROUTE from "../src/pages/admin/pipelines/runs/[stamp]/quality/[...rest].ts?raw";

/** A source without the comments that explain it, so a rule is checked against code only. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, "");
}

const PAGES = { LANDING, GRID, RUN } as const;
const MARKUP = { ...PAGES, PANEL, TABLE, LEGEND } as const;
const ALL = { ...MARKUP, QUALITY, API, VIEW, QAPI, QVIEW, DRILL, PROXY, PROXY_ROUTE } as const;

describe("backend text is never rendered as markup", () => {
  it.each(Object.entries(ALL))("%s has no set:html", (_name, source) => {
    expect(code(source)).not.toContain("set:html");
  });

  it.each(Object.entries(ALL))("%s has no innerHTML, insertAdjacentHTML or outerHTML", (_n, s) => {
    expect(code(s)).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it.each(Object.entries(MARKUP))("%s runs no script in the browser", (_name, source) => {
    expect(code(source)).not.toMatch(/<script[\s>]/);
  });

  it("prints a recording path only through displaySafeLine, and never in a link", () => {
    expect(code(RUN)).toContain("displaySafeLine(f.path)");
    expect(code(RUN)).not.toMatch(/href=\{[^}]*\.path/);
    for (const source of Object.values(MARKUP)) {
      expect(code(source)).not.toMatch(/href=\{[^}]*(f\.path|\.code|job_id)/);
    }
  });

  it("never parses a served time: D1 strings read as local time", () => {
    for (const source of Object.values(ALL)) {
      expect(code(source)).not.toMatch(/Date\.parse|new Date\(/);
    }
  });
});

describe("no sentence is typed in a page or component", () => {
  const SENTENCE_IN_QUOTES = /["`][^"`\n]*\b[A-Za-z]{3,} [A-Za-z]{3,} [A-Za-z]{3,}[^"`\n]*["`]/;
  const TEXT_NODE = />[^<>{}\n]*\b[A-Za-z]{3,} [A-Za-z]{3,}[^<>{}\n]*</;

  function body(source: string): string {
    return code(source.replace(/<style>[\s\S]*?<\/style>/g, "")).replace(
      /\{\/\*[\s\S]*?\*\/\}/g,
      "",
    );
  }

  it.each(Object.entries(MARKUP))("%s has no multi-word string literal", (_name, source) => {
    const lines = body(source)
      .split("\n")
      .filter((l) => !/^\s*import\b/.test(l) && !/\bclass(:list)?=/.test(l));
    for (const line of lines) expect(line, line).not.toMatch(SENTENCE_IN_QUOTES);
  });

  it.each(Object.entries(MARKUP))("%s has no multi-word text node", (_name, source) => {
    for (const line of body(source).split("\n")) expect(line, line).not.toMatch(TEXT_NODE);
  });

  it.each(Object.entries({ API, VIEW }))("%s has no multi-word string literal", (_n, source) => {
    const lines = code(source)
      .split("\n")
      .filter((l) => !/^\s*import\b/.test(l) && !/^\s*\*/.test(l));
    for (const line of lines) expect(line, line).not.toMatch(SENTENCE_IN_QUOTES);
  });
});

describe("no backend word is put in a link", () => {
  it("links a status chip or count only for a status this build knows", () => {
    expect(code(GRID)).toMatch(/return c\.known \?/);
    expect(code(PANEL)).toMatch(/\{s\.known \?/);
  });

  it("builds the next page only from a dataset-id cursor", () => {
    expect(code(VIEW)).toContain("COMPUTE_DATASET_ID_RE.test(nextAfter)");
  });

  it("offers only runners whose id is a runner id", () => {
    expect(code(GRID)).toContain("RUNNER_ID_RE.test(r.id)");
  });

  it("reads a cell only when the row owns that column", () => {
    expect(code(TABLE)).toContain("Object.hasOwn(row.cells, col)");
    expect(code(VIEW)).toContain("Object.hasOwn(row.cells, checkpoint)");
  });
});

describe("the gate, the cache and the sync", () => {
  it.each(Object.entries({ ...PAGES, QUALITY, OVERVIEW }))(
    "%s calls adminGate before it fetches anything",
    (_n, page) => {
      const gate = page.indexOf("adminGate(session");
      const firstAwait = page.indexOf("await ");
      expect(gate).toBeGreaterThan(-1);
      expect(firstAwait).toBeGreaterThan(gate);
      expect(page.indexOf("return Astro.redirect(redirectTo)")).toBeLessThan(firstAwait);
    },
  );

  it.each(Object.entries({ ...PAGES, QUALITY, OVERVIEW }))("%s is never cached", (_name, page) => {
    expect(code(page)).toContain('Astro.response.headers.set("Cache-Control", "no-store")');
  });

  it.each(Object.entries({ ...PAGES, QUALITY, OVERVIEW, API, VIEW, QAPI, QVIEW, DRILL }))(
    "%s never asks the Worker to sync",
    (_name, source) => {
      expect(code(source)).not.toMatch(/\bsync\b/);
    },
  );

  it("calls only the three read routes, and only with GET", () => {
    const routes = [...code(API).matchAll(/`\/pipeline\/[a-z]+/g)].map((m) => m[0]);
    expect([...new Set(routes)].sort()).toEqual([
      "`/pipeline/coverage",
      "`/pipeline/grid",
      "`/pipeline/runs",
    ]);
    expect(code(API)).not.toMatch(/"POST"|"PUT"|"DELETE"|"PATCH"/);
  });
});

describe("the run drill-down (website phase W9)", () => {
  it("has no multi-word sentence typed in the page", () => {
    const body = code(
      QUALITY.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<script>[\s\S]*?<\/script>/g, ""),
    );
    for (const line of body.split("\n")) {
      if (/^\s*import\b/.test(line) || /\bclass(:list)?=/.test(line)) continue;
      expect(line, line).not.toMatch(
        /["`][^"`\n]*\b[A-Za-z]{3,} [A-Za-z]{3,} [A-Za-z]{3,}[^"`\n]*["`]/,
      );
      expect(line, line).not.toMatch(/>[^<>{}\n]*\b[A-Za-z]{3,} [A-Za-z]{3,}[^<>{}\n]*</);
    }
  });

  it("links the public page only through publicHref, and prints recording paths as text", () => {
    for (const page of [RUN, QUALITY]) {
      expect(code(page)).not.toMatch(/href=\{[^}]*(\.path|dataset_id)/);
      expect(code(page)).toMatch(/href=\{(view|quality)\.publicHref\}/);
    }
    expect(code(QUALITY)).toContain("displaySafeLine(path)");
  });

  it("says the record's views_skipped in each group", () => {
    expect(code(DRILL)).toContain("drillGroups(stored, record.skipped)");
    expect(code(DRILL)).toContain("p.dataset.qdSkipped = s.key;");
  });

  it("draws only views without inputs, and never reads a signal store", () => {
    expect(code(DRILL)).toContain('!Object.hasOwn(v, "inputs")');
    expect(code(DRILL)).not.toMatch(/zarr|signal-window|extras\/signal|openSignal/);
  });

  it("fetches only same-origin proxy paths from the browser", () => {
    expect(code(DRILL)).not.toMatch(/https?:\/\//);
    expect(code(DRILL)).toMatch(/siteAdminRecordPath\(/);
    expect(code(DRILL)).toMatch(/siteAdminFilePath\(/);
  });

  it.each(Object.entries({ RUN, QUALITY }))(
    "%s gives every region a label of its own",
    (_n, page) => {
      const tables: Record<string, Readonly<Record<string, string>>> = {
        QL: PIPELINE_QUALITY_LABELS,
        PIPELINE_LABELS,
      };
      const ids = [...page.matchAll(/aria-labelledby="([^"]+)"/g)].map((m) => m[1]);
      expect(ids.length).toBeGreaterThan(1);
      const labels = ids.map((id) => {
        const m = new RegExp(`id="${id}"[^>]*>\\{(QL|PIPELINE_LABELS)\\.(\\w+)\\}`).exec(page);
        expect(m, id).not.toBeNull();
        const text = tables[m![1]][m![2]];
        expect(typeof text, id).toBe("string");
        return text;
      });
      expect(new Set(labels).size).toBe(labels.length);
    },
  );

  it("the proxy route never reads the Cookie header: the proxy chooses the credential", () => {
    expect(code(PROXY_ROUTE)).not.toMatch(/headers\.get\(\s*["']cookie["']/i);
    expect(code(PROXY_ROUTE)).not.toMatch(/\bcookies\b|readSessionCookie|sessionCookie/);
    expect(code(PROXY)).toContain('sessionCookieOf(request.headers.get("cookie"))');
  });

  it("the proxy route decides nothing itself and never reads its params", () => {
    expect(code(PROXY_ROUTE)).toContain("proxyAdminQuality(request");
    // Forwarded through the API service binding where the site has one (apiFetch), as itself.
    expect(code(PROXY_ROUTE)).toMatch(/fetch: apiFetch,/);
    expect(code(PROXY_ROUTE)).toMatch(/apiBase: apiBase\(\),/);
    expect(code(PROXY_ROUTE)).not.toMatch(/params/);
    expect(code(PROXY_ROUTE)).toMatch(/export const ALL\b/);
    expect(code(PROXY_ROUTE)).not.toMatch(/export const (GET|POST|PUT|DELETE|PATCH|HEAD)\b/);
  });

  it("the run-quality client calls one route, with GET", () => {
    expect([...code(QAPI).matchAll(/`\/pipeline\/[^`]*`/g)].map((m) => m[0])).toEqual([
      "`/pipeline/runs/${stampId}/quality${qs}`",
    ]);
    expect(code(QAPI)).not.toMatch(/"POST"|"PUT"|"DELETE"|"PATCH"/);
  });
});
