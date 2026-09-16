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
    // It must frame anonymity as TEMPORARY and pre-publication, and must not
    // promise more than NEMAR enforces. NEMAR withholds the fields it
    // publishes; the README, dataset_description.json and the participants
    // files are the depositor's own and are served as written, which the
    // backend's own sweep classifies as `severity: "deposit"` precisely
    // because NEMAR cannot blind them.
    expect(datasetPageSource).toMatch(/double-blind peer review/);
    expect(datasetPageSource).toMatch(/It is attributed then/);
    expect(datasetPageSource).toMatch(/cannot vouch for the files themselves/);
    // De-anonymization is a publication the DEPOSITOR performs. NEMAR neither
    // observes nor performs paper acceptance, so the copy must not turn on it.
    expect(datasetPageSource).not.toMatch(/until the associated paper is accepted/);
    // "The data is complete" is a claim the platform declines to make
    // elsewhere (ADR 0005, ADR 0064).
    expect(datasetPageSource).not.toMatch(/The data is complete/);
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

/**
 * The other half of the property: a dataset that is NOT anonymous still gets
 * everything back.
 *
 * Every test above asserts an ABSENCE. Absence is satisfiable by deleting the
 * feature, so on their own they cannot tell "the fallback is gone" from "the
 * GitHub affordance is gone for all 772 datasets". Changing one token in the
 * page -- `githubUrl={githubUrl}` to `githubUrl={null}` -- passed all twelve,
 * while removing the GitHub button and both clone commands from every dataset
 * on the site.
 *
 * These are the controls. They are deliberately about the DERIVATION rather
 * than the rendered markup, because the derivation is what the withholding
 * acts on: null in, nothing out; a URL in, every affordance out.
 */
describe("a dataset with a repository still gets every GitHub affordance", () => {
  /** The real derivations, transcribed from the sources under test. Kept as
   *  functions so a control exercises the RULE, not a copy of the output. */
  const issuesFrom = (githubUrl: string | null) => (githubUrl ? `${githubUrl}/issues` : null);
  const dataladFrom = (ghCloneUrl: string | null, ds: string) =>
    ghCloneUrl ? `datalad clone ${ghCloneUrl} ${ds}\ncd ${ds} && datalad get .` : null;
  const annexFrom = (ghCloneUrl: string | null, ds: string) =>
    ghCloneUrl ? `git clone ${ghCloneUrl} ${ds}\ncd ${ds} && git annex get .` : null;

  const PUBLIC_URL = "https://github.com/nemarDatasets/nm000103";

  it("a present URL produces issues and both clone commands", () => {
    expect(issuesFrom(PUBLIC_URL)).toBe(`${PUBLIC_URL}/issues`);
    expect(dataladFrom(PUBLIC_URL, "nm000103")).toContain(`datalad clone ${PUBLIC_URL}`);
    expect(annexFrom(PUBLIC_URL, "nm000103")).toContain(`git clone ${PUBLIC_URL}`);
  });

  it("a withheld URL produces none of them", () => {
    expect(issuesFrom(null)).toBeNull();
    expect(dataladFrom(null, "nm000103")).toBeNull();
    expect(annexFrom(null, "nm000103")).toBeNull();
  });

  it("the page passes the real URL to ActionBar, not a hardcoded null", () => {
    // The mutation that defeated the original suite. `githubUrl={null}` would
    // withhold the repository from every dataset, anonymous or not.
    expect(datasetPageSource).toContain("githubUrl={githubUrl}");
    expect(withoutComments(datasetPageSource)).not.toMatch(/githubUrl=\{null\}/);
    expect(withoutComments(datasetPageSource)).not.toMatch(/issuesUrl=\{null\}/);
  });

  it("ActionBar derives the clone URL from the prop, not from the dataset id", () => {
    expect(withoutComments(actionBarSource)).toContain("const ghCloneUrl = githubUrl;");
  });
});

describe("the DOI follows the same rule as the repository", () => {
  // Nothing in the original suite mentioned a DOI at all, though an anonymous
  // deposit's DOI is `reserved` -- registered, not advertised, does not
  // resolve -- and the backend nulls it for exactly that reason.
  const citeFrom = (datasetDoi: string | null) => (datasetDoi ? `https://doi.org/${datasetDoi}` : null);

  it("a withheld DOI produces no citation link", () => {
    expect(citeFrom(null)).toBeNull();
  });

  it("a real DOI still does", () => {
    expect(citeFrom("10.82901/nemar.nm000103")).toBe("https://doi.org/10.82901/nemar.nm000103");
  });

  it("the page takes the DOI straight from the data plane, with no fallback", () => {
    expect(datasetPageSource).toContain("const datasetDoi = metadata.external_links.dataset_doi;");
    expect(withoutComments(datasetPageSource)).not.toMatch(/dataset_doi\s*\?\?/);
  });
});

describe("no retired GitHub route survives in the components this touched", () => {
  it("Readme has no github fallback branch or url prop", () => {
    // The component's whole changeset is "no GitHub route survives", and it
    // still carried an unreachable `fallbackKind === "github"` branch that
    // rendered a link. Unreachable is one edit away from reachable.
    expect(withoutComments(readmeSource)).not.toMatch(/fallbackKind === "github"/);
    expect(withoutComments(readmeSource)).not.toMatch(/githubUrl/);
  });

  it("neither empty state points the reader at a repository", () => {
    // Two copies, SSR and client-injected, that must change together. Telling
    // a reader to go find "the dataset's GitHub repository" confirms one
    // exists under a predictable name -- the disclosure this PR removes.
    expect(withoutComments(readmeSource)).not.toMatch(/GitHub repository may have curation/);
    expect(withoutComments(datasetPageSource)).not.toMatch(/GitHub repository may have curation/);
  });
});
