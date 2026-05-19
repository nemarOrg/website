import { renderMarkdown } from "./markdown";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type ReadmeSourceKind = "manifest" | "github" | "description" | null;

/** Unpublished-state placeholder for the README panel. */
export function renderUnpublishedReadme(): string {
  return `<div class="readme__empty">
      <h2>Not yet published</h2>
      <p>This dataset has been registered but no published version is available yet. Check back later or visit the dataset's GitHub repository for curation progress.</p>
    </div>`;
}

/**
 * Produce the inner HTML of an <article class="readme">. Matches the
 * Readme.astro component output 1:1 so the API endpoint can return a
 * drop-in replacement for the SSR-rendered version.
 */
export function renderReadme(
  source: string | null,
  fallbackKind: ReadmeSourceKind,
  githubUrl: string | null,
): string {
  const html = source ? renderMarkdown(source) : null;
  const isFallback = fallbackKind !== null && fallbackKind !== "manifest";

  if (!html) {
    return `<div class="readme__empty">
      <h2>No description available</h2>
      <p>This dataset doesn't ship a README and the BIDS metadata has no description either. The file tree below and the metadata panel on the right are the authoritative description for now. The dataset's GitHub repository may have curation notes added later.</p>
    </div>`;
  }

  const out: string[] = [];
  if (fallbackKind === "github") {
    const gh = githubUrl ? esc(githubUrl.replace(/^https?:\/\//, "")) : null;
    out.push(`<div class="readme__fallback-note" role="note">`);
    out.push(`<strong>README from GitHub repository</strong>`);
    out.push(`<span>This README isn't in the version manifest yet. Showing the latest from `);
    out.push(
      gh
        ? `<a href="${esc(githubUrl ?? "")}" rel="external">${gh}</a>`
        : `<span>the dataset repository</span>`,
    );
    out.push(` instead.</span></div>`);
  } else if (fallbackKind === "description") {
    out.push(`<div class="readme__fallback-note" role="note">`);
    out.push(`<strong>Description (from dataset metadata)</strong>`);
    out.push(
      `<span>This dataset doesn't ship a README. Showing the BIDS description instead.</span>`,
    );
    out.push(`</div>`);
  }
  out.push(`<div class="readme__wrap" data-readme-wrap>`);
  out.push(`<div class="readme__body">${html}</div>`);
  out.push(`<div class="readme__fade" aria-hidden="true"></div>`);
  out.push(`<div class="readme__toolbar">`);
  out.push(
    `<button class="readme__toggle" type="button" data-readme-toggle aria-expanded="false" aria-controls="readme-body">`,
  );
  out.push(`<span class="readme__toggle-label">Expand README</span>`);
  out.push(`</button></div></div>`);
  // Mark fallback for downstream logic (lazy-detail script unused atm but harmless).
  void isFallback;
  return out.join("");
}
