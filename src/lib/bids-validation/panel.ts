/**
 * Draws the BIDS validation panel of the upload page (`BidsValidationPanel.astro` holds its
 * markup). Browser-only, and DOM only: every sentence comes from `wording.ts` and every grouping
 * from `report.ts`, which have tests; this file puts them on the page.
 *
 * Text goes in with `textContent` and nothing else. File names come from the person's disk and
 * messages from the validator, and neither is trusted as markup.
 */

import type { Verdict } from "./gate";
import type { ReportIssue, ValidationReport } from "./protocol";
import { type IssueGroup, groupIssues } from "./report";
import {
  WAITING_FOR_STRUCTURE,
  footerLine,
  runningLine,
  unavailableWords,
  verdictWords,
} from "./wording";

export interface ValidationPanel {
  /** The structure check has errors; the full check has not started and says why. */
  showWaiting(): void;
  showRunning(fileCount: number): void;
  /** Move keyboard focus to the panel's heading, where the person who started the check lands. */
  focus(): void;
  setPhase(phase: "tree" | "validate", fileCount: number): void;
  showFinished(finished: {
    readonly report: ValidationReport;
    readonly verdict: Verdict;
    readonly validatorVersion: string;
  }): void;
  showUnavailable(reason: string): void;
  /** The person stopped the check: the panel goes, and the live region says so. */
  showCancelled(): void;
  hide(): void;
  /** Called when the person presses Cancel while the check runs. */
  onCancel(handler: () => void): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderGroup(group: IssueGroup): HTMLDetailsElement {
  const details = element("details", `bidsval__group bidsval__group--${group.severity}`);
  // Errors are what the person has to act on, so they start open; warnings start closed.
  details.open = group.severity === "error";

  const summary = element("summary", "bidsval__group-summary");
  summary.append(
    element(
      "span",
      `bidsval__sev bidsval__sev--${group.severity}`,
      group.severity === "error" ? "Error" : "Warning",
    ),
    element("code", "bidsval__code", group.code),
    element(
      "span",
      "bidsval__count",
      `${group.count} ${group.count === 1 ? "finding" : "findings"}`,
    ),
  );
  details.append(summary);

  if (group.description) details.append(element("p", "bidsval__desc", group.description));

  const list = element("ul", "bidsval__items");
  for (const item of group.items) {
    const row = element("li", "bidsval__item");
    if (item.path) row.append(element("span", "bidsval__path", item.path));
    if (item.label) row.append(element("span", "bidsval__label", item.label));
    list.append(row);
  }
  details.append(list);

  if (group.omitted > 0) {
    details.append(element("p", "bidsval__more", `and ${group.omitted} more.`));
  }
  return details;
}

export function bindValidationPanel(host: HTMLElement): ValidationPanel {
  const part = <T extends HTMLElement>(name: string): T => {
    const node = host.querySelector<T>(`[data-bidsval-${name}]`);
    if (!node) throw new Error(`BIDS validation panel is missing its ${name} element`);
    return node;
  };
  const root = part("panel");
  const heading = part("heading");
  const announce = part("announce");
  const status = part("status");
  const bar = part("bar");
  const verdict = part("verdict");
  const note = part("note");
  const groups = part("groups");
  const footer = part("footer");
  const cancel = part<HTMLButtonElement>("cancel");

  const setText = (node: HTMLElement, text: string): void => {
    node.textContent = text;
    node.hidden = text === "";
  };

  /** What a screen reader is told: the live region sits outside the panel, which is hidden at
   *  rest, so it can be heard when the panel appears. Cleared with the panel, so the same result
   *  twice in a row is a change both times. */
  const say = (text: string): void => {
    announce.textContent = text;
  };

  /** Everything below the privacy statement, cleared. */
  const clear = (): void => {
    say("");
    setText(status, "");
    bar.hidden = true;
    cancel.hidden = true;
    setText(verdict, "");
    verdict.removeAttribute("data-tone");
    setText(note, "");
    groups.replaceChildren();
    setText(footer, "");
  };

  return {
    showWaiting() {
      clear();
      root.hidden = false;
      setText(status, WAITING_FOR_STRUCTURE);
      say(WAITING_FOR_STRUCTURE);
    },
    showRunning(fileCount) {
      clear();
      root.hidden = false;
      setText(status, runningLine("tree", fileCount));
      bar.hidden = false;
      cancel.hidden = false;
      say(`BIDS validation started. ${runningLine("validate", fileCount)}`);
    },
    focus() {
      heading.focus();
    },
    setPhase(phase, fileCount) {
      // Seen, not announced: the start was, and the result will be.
      setText(status, runningLine(phase, fileCount));
    },
    showFinished({ report, verdict: found, validatorVersion }) {
      clear();
      root.hidden = false;
      const words = verdictWords({
        blocking: found.blocking.length,
        warnings: found.warnings.length + found.schemaDownloadFailed.length,
        annexSkipped: found.annexSkipped.length,
        schemaDownloadFailed: found.schemaDownloadFailed.length,
      });
      setText(verdict, `${words.headline} ${words.detail}`);
      verdict.dataset.tone = words.tone;
      setText(note, words.note);
      say(`BIDS validation finished. ${words.headline} ${words.note}`.trim());
      // The findings that count, then the advisory ones. A HED schema that could not be downloaded
      // is listed as a warning, which is what it is here; the pointer-file errors are only in the
      // note, because they are about files the person does not need to read.
      const asWarning = (issue: ReportIssue): ReportIssue => ({ ...issue, severity: "warning" });
      const shown = [
        ...found.blocking,
        ...found.warnings,
        ...found.schemaDownloadFailed.map(asWarning),
      ];
      for (const group of groupIssues(shown, report.codeMessages)) {
        groups.append(renderGroup(group));
      }
      setText(footer, footerLine(validatorVersion, report.summary.schemaVersion));
    },
    showUnavailable(reason) {
      clear();
      root.hidden = false;
      const words = unavailableWords(reason);
      setText(verdict, `${words.headline} ${words.detail}`);
      verdict.dataset.tone = "unavailable";
      say(`${words.headline} ${words.detail}`);
    },
    showCancelled() {
      clear();
      root.hidden = true;
      say("BIDS validation cancelled.");
    },
    hide() {
      clear();
      root.hidden = true;
    },
    onCancel(handler) {
      cancel.addEventListener("click", handler);
    },
  };
}
