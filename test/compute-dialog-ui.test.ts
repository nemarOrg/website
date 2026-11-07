/**
 * Wiring guards for the dataset page's Compute dialog (website ADR 0030 phase E5 addendum;
 * nemarOrg/website#498). Source-level, like `compute-dashboard-ui.test.ts`: Astro files have no render
 * harness in this repo, so the markup is checked by reading it and by the dev-server `curl` in the PR.
 * The builder's behavior has its own tests (`src/lib/compute-instructions.test.ts`,
 * `test/compute-instructions-cli-parity.test.ts`).
 */
import { describe, expect, it } from "vitest";
import ACTION_BAR from "../src/components/ActionBar.astro?raw";
import { ACCOUNT_COPY } from "../src/lib/account-copy";
import FLAGS from "../src/lib/flags.ts?raw";
import DATASET_PAGE from "../src/pages/dataset/[id].astro?raw";

/** The Compute dialog element: from its opening tag to its closing `</dialog>`. */
function computeDialog(): string {
  const start = ACTION_BAR.indexOf("<dialog class=\"compute-dialog\" data-compute-dialog");
  expect(start).toBeGreaterThan(-1);
  const end = ACTION_BAR.indexOf("</dialog>", start);
  return ACTION_BAR.slice(start, end + "</dialog>".length);
}

/** The frontmatter lines that build the dialog's data, from its comment to the closing fence. */
function computeFrontmatter(): string {
  const start = ACTION_BAR.indexOf("// The Compute dialog (website#498");
  expect(start).toBeGreaterThan(-1);
  return ACTION_BAR.slice(start, ACTION_BAR.indexOf("\n---", start));
}

function code(src: string): string {
  return src
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

const FORBIDDEN = [
  "data-compute-stub",
  "s3://",
  "nsgportal",
  "NeuroScience Gateway",
  "Neuroscience Gateway",
  "npm install",
  "website/issues/6",
  "compute-dialog__soon",
  "coming soon",
];

describe("the old dialog is gone", () => {
  it("the compute dialog element carries none of the removed content", () => {
    const dialog = computeDialog();
    for (const word of FORBIDDEN) expect(dialog, word).not.toContain(word);
  });

  it("ActionBar carries none of the removed content anywhere (the Download dialog's routes are not it)", () => {
    for (const word of FORBIDDEN) {
      expect(ACTION_BAR.toLowerCase(), word).not.toContain(word.toLowerCase());
    }
  });

  it("the compute dialog does not repeat the Download dialog's routes", () => {
    const dialog = computeDialog();
    for (const word of ["manifest.json", "wget", "rclone", "datalad", "git annex", "nemar dataset"]) {
      expect(dialog, word).not.toContain(word);
    }
  });
});

describe("the button and the dialog", () => {
  it("the button hook is data-compute-open, the label stays, and the script selects it", () => {
    expect(ACTION_BAR).toContain("data-compute-open");
    expect(ACTION_BAR).toContain("Compute instructions");
    expect(ACTION_BAR).toContain('querySelectorAll<HTMLButtonElement>("[data-compute-open]")');
  });

  it("the dialog is labelled by its heading", () => {
    const dialog = computeDialog();
    expect(dialog).toContain('aria-labelledby="compute-dialog-heading"');
    expect(dialog).toContain('<h2 id="compute-dialog-heading">');
  });

  it("each command row reuses the Download dialog's copy row and its delegated handler", () => {
    const dialog = computeDialog();
    expect(dialog).toContain('class="dl-cmd"');
    expect(dialog).toContain("data-copy-text={row.command}");
    expect(dialog).toContain('class="dl-cmd__copy"');
    expect(ACTION_BAR).toContain('closest<HTMLButtonElement>("[data-copy-text]")');
  });

  it("each scrollable command block is keyboard-focusable", () => {
    expect(computeDialog()).toContain('<pre tabindex="0">');
  });

  it("the other two dialogs are untouched in their markup hooks", () => {
    expect(ACTION_BAR).toContain("data-download-dialog");
    expect(ACTION_BAR).toContain("data-citations-dialog");
    expect(ACTION_BAR).toContain("Download this dataset");
  });
});

describe("the release gate", () => {
  it("is the one switch ADR 0030 owns, read the way Settings reads it", () => {
    expect(ACTION_BAR).toContain("computeRequestsOpen(COMPUTE_REQUESTS_ENABLED, apiBase())");
    expect(ACTION_BAR).toContain('from "../lib/flags"');
  });

  it("production stays closed until the owner flips the flag", () => {
    expect(FLAGS).toMatch(/export const COMPUTE_REQUESTS_ENABLED = false;/);
  });

  it("invents no second switch", () => {
    expect(computeFrontmatter()).not.toMatch(/import\.meta\.env|\.DEV\b|process\.env/);
  });
});

describe("links to the app host", () => {
  it("go through appUrl, from the request's own host, and render nothing from compute", () => {
    expect(ACTION_BAR).toContain('appUrl("/settings#compute-access"');
    expect(ACTION_BAR).toContain('appUrl("/compute"');
    expect(ACTION_BAR).toContain('from "../lib/host"');
    expect(ACTION_BAR).toContain("new URL(Astro.request.url).hostname");
    expect(computeDialog()).toContain("href={requestAccessHref}");
    expect(computeDialog()).toContain("href={computePageHref}");
  });

  it("does not fetch anything for the dialog", () => {
    expect(computeFrontmatter()).not.toMatch(/\bfetch\(|apiFetch|getCompute/);
  });
});

describe("anonymous deposits", () => {
  it("the dialog is decided from the anonymous flag, never from the repository URL", () => {
    expect(computeFrontmatter()).toContain("anonymous,");
    const reads = computeDialog() + computeFrontmatter();
    expect(reads).not.toContain("githubUrl");
    expect(reads).not.toContain("ghCloneUrl");
    expect(reads).not.toContain("issuesUrl");
  });

  it("the dataset page passes the flags the dialog needs", () => {
    expect(DATASET_PAGE).toContain("anonymous={anonymousDeposit}");
    expect(DATASET_PAGE).toContain("unpublished={unpublished}");
  });
});

describe("copy", () => {
  it("every shared copy key the dialog reads exists", () => {
    const keys = [...ACTION_BAR.matchAll(/ACCOUNT_COPY\["([^"]+)"\]/g)].map((m) => m[1] as string);
    expect(keys).toEqual(
      expect.arrayContaining([
        "compute_access.section.lede",
        "compute_access.granted.link",
        "compute_access.terms_unpublished.body",
      ]),
    );
    for (const key of keys) expect(Object.keys(ACCOUNT_COPY), key).toContain(key);
  });

  it("types no long sentence in the dialog or its frontmatter: those live in compute-labels.ts or the copy table", () => {
    const offenders: string[] = [];
    // A shared key is a lookup, not a typed sentence.
    const src = (code(computeDialog()) + code(computeFrontmatter())).replace(
      /ACCOUNT_COPY\["[^"]+"\]/g,
      "COPY",
    );
    for (const m of src.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n]){40,})\1/g)) {
      if (m[2]?.includes(" ") && !m[2].includes("${")) offenders.push(m[2]);
    }
    for (const m of src.matchAll(/>([^<>{}\n]{30,})</g)) {
      if (/\s/.test((m[1] as string).trim())) offenders.push((m[1] as string).trim());
    }
    expect(offenders).toEqual([]);
  });

  it("renders every backend or builder string as a text node (no markup-writing API)", () => {
    for (const api of ["set:html", "innerHTML", "insertAdjacentHTML", "outerHTML", "document.write"]) {
      expect(code(computeDialog()), api).not.toContain(api);
    }
  });
});
