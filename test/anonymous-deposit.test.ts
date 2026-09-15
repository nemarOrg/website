/**
 * A blinded deposit offers no route to its repository (#333).
 *
 * A dataset can be deposited for double-blind review: served here exactly as
 * any public dataset is, while its GitHub repository stays private and its
 * depositor is withheld until the paper is accepted
 * (nemarOrg/nemar-cli#1408). The backend withholds `external_links.github_url`
 * for such a dataset.
 *
 * WHY THIS IS A SOURCE-LEVEL TEST
 * -------------------------------
 * The bug this guards against is not "the button renders". It is that the page
 * FABRICATED the URL when the backend withheld it -- `githubUrl ?? \`https://
 * github.com/nemarDatasets/${id}\`` in two separate files -- so nulling the
 * field server-side changed nothing: the button disappeared while the copyable
 * clone commands still handed the visitor the repository address. A rendering
 * test would have passed against that code, because the button really was
 * hidden. What has to be asserted is the absence of the fallback itself.
 *
 * Astro components have no render harness here, so this follows the
 * `test/use-this-data-placement.test.ts` pattern: import the component source
 * with `?raw` and assert on it.
 */

import { describe, expect, it } from "vitest";
import actionBarSource from "../src/components/ActionBar.astro?raw";
import readmeSource from "../src/components/Readme.astro?raw";
import datasetPageSource from "../src/pages/dataset/[id].astro?raw";

/** Strip `//` and `/* *\/` comments so prose about the old bug is not a hit. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("no GitHub URL is fabricated when the backend withholds one", () => {
  it("ActionBar has no nemarDatasets fallback in executable code", () => {
    // The exact shape of the original bug: `githubUrl ?? <literal>`.
    expect(withoutComments(actionBarSource)).not.toMatch(/github\.com\/nemarDatasets/);
  });

  it("the dataset page has no nemarDatasets fallback in executable code", () => {
    expect(withoutComments(datasetPageSource)).not.toMatch(/github\.com\/\$\{ORG_DATASETS\}/);
    expect(withoutComments(datasetPageSource)).not.toMatch(/github\.com\/nemarDatasets/);
  });

  it("the page takes the URL straight from the data plane, with no ?? fallback", () => {
    expect(datasetPageSource).toContain("const githubUrl = metadata.external_links.github_url;");
  });
});

describe("every GitHub route is gated on that URL", () => {
  it("the clone commands are null when there is no repository", () => {
    // These are the leak that survived the original fix: the button was gated,
    // the copyable `datalad clone` / `git clone` commands were not.
    expect(actionBarSource).toContain("const dataladCmd = ghCloneUrl");
    expect(actionBarSource).toMatch(/const annexCmd = ghCloneUrl \?/);
    expect(actionBarSource).toContain("{dataladCmd && (");
    expect(actionBarSource).toContain("{annexCmd && (");
  });

  it("the Issues button is gated, not merely the GitHub button", () => {
    // `issuesUrl` used to be typed `string`, so it always rendered and always
    // pointed at `<repo>/issues`.
    expect(actionBarSource).toContain("issuesUrl: string | null;");
    expect(actionBarSource).toContain("{issuesUrl && (");
    expect(datasetPageSource).toContain(
      "const issuesUrl = githubUrl ? `${githubUrl}/issues` : null;",
    );
  });

  it("the unpublished empty state does not link to a repository it may not have", () => {
    expect(datasetPageSource).toMatch(/\{githubUrl \? \(/);
  });
});

describe("the README comes from the data plane, not from GitHub", () => {
  it("neither the component nor the page fetches raw.githubusercontent", () => {
    // A blinded deposit's repository is private, so the raw URL 404s and the
    // panel would fall through to the description -- making the dataset look
    // undocumented rather than concealed. The data plane serves a dataset's
    // git-tracked files either way (nemar-cli#1403 built the broker for it),
    // which also takes a third-party host out of this page for every dataset.
    expect(withoutComments(readmeSource)).not.toMatch(/raw\.githubusercontent/);
    expect(withoutComments(datasetPageSource)).not.toMatch(/raw\.githubusercontent/);
  });

  it("the client fetch and the noscript link both address the data plane", () => {
    expect(datasetPageSource).toContain(
      "const readmeUrl = `${base}/${datasetId}/${encodeURIComponent(version)}/README.md`;",
    );
    expect(readmeSource).toContain(
      "? `${dataBase}/${datasetId}/${encodeURIComponent(version)}/README.md`",
    );
  });
});

describe("the state is visible and explained", () => {
  it("the page reads the flag from the data-plane document", () => {
    // Not from the catalog row: that fetch is null for `ds*` ids and on any
    // failure, and degrading to "not anonymous" is the wrong-way failure here.
    // The metadata document cannot fail silently -- the page 404s instead.
    expect(datasetPageSource).toContain("const anonymousDeposit = metadata.anonymous === true;");
  });

  it("an explanation is rendered, so absent authors do not read as a broken record", () => {
    expect(datasetPageSource).toContain("{anonymousDeposit && (");
    expect(datasetPageSource).toContain("Authorship is temporarily withheld");
    // It must say the data itself is complete, and that attribution is coming.
    expect(datasetPageSource).toMatch(/double-blind peer review/);
    expect(datasetPageSource).toMatch(/attributed on release/);
  });

  it("a header chip carries the state above the fold", () => {
    expect(datasetPageSource).toMatch(/value="Anonymous deposit"/);
  });

  it("the explanation is styled from design tokens, with no raw hex", () => {
    const block = datasetPageSource.slice(
      datasetPageSource.indexOf(".detail__anonymous {"),
      datasetPageSource.indexOf(".detail__no-manifest {"),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(block).toMatch(/var\(--color-warning\)/);
  });
});
