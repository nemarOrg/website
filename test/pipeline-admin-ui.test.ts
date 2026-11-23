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
import VIEW from "../src/lib/compute-pipeline-view.ts?raw";
import OVERVIEW from "../src/pages/admin/index.astro?raw";
import GRID from "../src/pages/admin/pipelines/[recipe].astro?raw";
import LANDING from "../src/pages/admin/pipelines/index.astro?raw";
import RUN from "../src/pages/admin/pipelines/runs/[stamp].astro?raw";

/** A source without the comments that explain it, so a rule is checked against code only. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
    .replace(/<!--[\s\S]*?-->/g, "");
}

const PAGES = { LANDING, GRID, RUN } as const;
const MARKUP = { ...PAGES, PANEL, TABLE, LEGEND } as const;
const ALL = { ...MARKUP, API, VIEW } as const;

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

describe("the gate, the cache and the sync", () => {
  it.each(Object.entries(PAGES))("%s calls adminGate before it fetches anything", (_n, page) => {
    const gate = page.indexOf("adminGate(session");
    const firstAwait = page.indexOf("await ");
    expect(gate).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(gate);
    expect(page.indexOf("return Astro.redirect(redirectTo)")).toBeLessThan(firstAwait);
  });

  it.each(Object.entries(PAGES))("%s is never cached", (_name, page) => {
    expect(code(page)).toContain('Astro.response.headers.set("Cache-Control", "no-store")');
  });

  it.each(Object.entries({ ...PAGES, OVERVIEW, API, VIEW }))(
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
