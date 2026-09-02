/**
 * Renderer for the dataset-page Zarr coverage panel (website#277 decision 2):
 * "N of M recordings viewable", then failures grouped by code (with the
 * viewer-safe reason and a disclosure for `detail`), then pending grouped by
 * reason (v3 only). Pure and index-only -- computed from the same
 * already-fetched index.json the tree/viewer use, so wiring this in adds no
 * new API call. Mirrors this codebase's render-*.ts convention (data/parsing
 * lives in zarr-index.ts, markup lives here) with its own local `esc`
 * (duplicated, not shared -- see the other render-*.ts files).
 */

import { bidsRowId } from "./bids-tree";
import {
  type ZarrIndex,
  type ZarrIndexFailure,
  type ZarrIndexPending,
  zarrCoverage,
} from "./zarr-index";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A link to a recording's row in the file tree below, keyed by the same
 * `bidsRowId` the tree renderer stamps on every recording row. `data-jump-
 * path` carries the raw path so the page script can auto-expand a collapsed
 * ancestor directory before jumping -- a plain `#anchor` alone only resolves
 * when the row already happens to be rendered (its directory expanded, or
 * within the first "Show next" chunk).
 */
function recordingLink(path: string): string {
  const id = bidsRowId(path);
  return `<a href="#${esc(id)}" class="zcov__path" data-jump-path="${esc(path)}"><code>${esc(path)}</code></a>`;
}

function pluralRecordings(n: number): string {
  return `${n} recording${n === 1 ? "" : "s"}`;
}

function renderFailureGroup(code: string, entries: ZarrIndexFailure[]): string {
  const reason = entries[0]?.reason ?? "";
  const out: string[] = [];
  out.push(`<li class="zcov__code">`);
  out.push(
    `<span class="zcov__code-head"><code>${esc(code)}</code> — ${esc(reason)} (${pluralRecordings(entries.length)})</span>`,
  );
  out.push(`<ul class="zcov__entries">`);
  for (const f of entries) {
    out.push(`<li>${recordingLink(f.path)}`);
    if (f.detail) {
      out.push(
        `<details class="zcov__detail"><summary>Detail</summary><pre>${esc(f.detail)}</pre></details>`,
      );
    }
    out.push("</li>");
  }
  out.push("</ul></li>");
  return out.join("");
}

function renderPendingGroup(reason: string, entries: ZarrIndexPending[]): string {
  const out: string[] = [];
  out.push(`<li class="zcov__code">`);
  out.push(
    `<span class="zcov__code-head"><code>${esc(reason)}</code> (${pluralRecordings(entries.length)})</span>`,
  );
  out.push(`<ul class="zcov__entries">`);
  for (const p of entries) {
    const attempts = `${p.attempts} attempt${p.attempts === 1 ? "" : "s"}`;
    out.push(`<li>${recordingLink(p.path)} <span class="zcov__attempts">(${attempts})</span>`);
    if (p.last_error) {
      out.push(
        `<details class="zcov__detail"><summary>Last error</summary><pre>${esc(p.last_error)}</pre></details>`,
      );
    }
    out.push("</li>");
  }
  out.push("</ul></li>");
  return out.join("");
}

/**
 * Render the compact coverage block placed just above the file tree. Returns
 * "" when there is nothing to report (no Zarr conversion attempted for this
 * dataset at all) so the caller can leave the slot hidden.
 */
export function renderZarrCoveragePanel(index: ZarrIndex): string {
  const cov = zarrCoverage(index);
  const total = cov.discovered ?? cov.viewable + cov.failed;
  if (total === 0) return "";

  const out: string[] = [];
  out.push(`<section class="zcov" aria-label="Zarr viewer coverage">`);
  out.push(
    `<p class="zcov__summary"><strong>${cov.viewable}</strong> of <strong>${total}</strong> recordings viewable</p>`,
  );
  if (cov.discovered == null) {
    out.push(`<p class="zcov__note">Pending counts are not reported by this index version.</p>`);
  }

  if (cov.failed > 0) {
    out.push(
      `<details class="zcov__group"><summary>${pluralRecordings(cov.failed)} failed</summary><ul class="zcov__list">`,
    );
    for (const [code, entries] of Object.entries(cov.byFailureCode)) {
      out.push(renderFailureGroup(code, entries));
    }
    out.push("</ul></details>");
  }

  if (cov.pending > 0) {
    out.push(
      `<details class="zcov__group"><summary>${pluralRecordings(cov.pending)} pending</summary><ul class="zcov__list">`,
    );
    for (const [reason, entries] of Object.entries(cov.byPendingReason)) {
      out.push(renderPendingGroup(reason, entries));
    }
    out.push("</ul></details>");
    if (cov.unknownPending) {
      out.push(
        `<p class="zcov__note">Some pending recordings report a reason this page doesn't recognize yet.</p>`,
      );
    }
  }

  out.push("</section>");
  return out.join("");
}
