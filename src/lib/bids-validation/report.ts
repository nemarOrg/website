/**
 * Turning what the validator found into what the upload page shows: findings grouped by code,
 * errors first, with the words a person can read. Pure; nothing here touches the page.
 */

import type { IssueSeverity, ReportIssue } from "./protocol";

/** Only these two are shown. `ignore` is a config override the page never asks for. */
export type ShownSeverity = Exclude<IssueSeverity, "ignore">;

export interface GroupItem {
  /** Dataset-relative path, or "" for a finding about the dataset as a whole. */
  readonly path: string;
  /** What about that path: the finding's sub-code and its message, as one short line. */
  readonly label: string;
}

export interface IssueGroup {
  /** `severity:code`. The same code at two severities is two groups. */
  readonly key: string;
  readonly severity: ShownSeverity;
  readonly code: string;
  /** The validator's description of the code, as text. */
  readonly description: string;
  /** How many findings the group holds. */
  readonly count: number;
  /** The first findings, in the order the validator found them. */
  readonly items: readonly GroupItem[];
  /** How many findings are not in `items`. */
  readonly omitted: number;
}

/** A group lists this many files before saying how many more there are. The repository check
 *  lists its first 50 findings across all groups; one group is the unit a person acts on. */
export const ITEMS_PER_GROUP = 25;

const LABEL_MAX = 200;

/**
 * The validator's messages are Markdown: links into the specification written
 * `[text](SPEC_ROOT/path)`, names in backticks, lines wrapped by hand. The page shows text, so a
 * link keeps its words and drops its address, a name loses its backticks, and a message is one
 * line however it was wrapped.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Where a finding points: its file, or for the checks about a file that is missing, the file it
 *  expected. "" when it is about the dataset as a whole. */
export function issuePath(issue: ReportIssue): string {
  return issue.location ?? issue.affects?.join(", ") ?? "";
}

/** The validator opens the message of a missing metadata key with this, after the key itself,
 *  which the label already names: `TaskName: Field description: Name of the task...`. */
const FIELD_DESCRIPTION_PREFIX = /^Field description:\s*/;

function itemOf(issue: ReportIssue): GroupItem {
  const message = plainText(issue.issueMessage ?? "").replace(FIELD_DESCRIPTION_PREFIX, "");
  const label = [issue.subCode, message].filter(Boolean).join(": ");
  return {
    path: issuePath(issue),
    label: label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 3)}...` : label,
  };
}

export function countBySeverity(issues: readonly ReportIssue[]): {
  errors: number;
  warnings: number;
} {
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === "error") errors += 1;
    else if (issue.severity === "warning") warnings += 1;
  }
  return { errors, warnings };
}

/**
 * Findings grouped by severity and code. Errors come before warnings, and within each the code
 * with the most findings first, then alphabetically, so the order does not depend on which file
 * the validator happened to meet first.
 */
export function groupIssues(
  issues: readonly ReportIssue[],
  codeMessages: Readonly<Record<string, string>>,
  perGroup: number = ITEMS_PER_GROUP,
): IssueGroup[] {
  const byKey = new Map<string, { severity: ShownSeverity; code: string; issues: ReportIssue[] }>();
  for (const issue of issues) {
    if (issue.severity === "ignore") continue;
    const key = `${issue.severity}:${issue.code}`;
    const group = byKey.get(key) ?? { severity: issue.severity, code: issue.code, issues: [] };
    group.issues.push(issue);
    byKey.set(key, group);
  }
  return [...byKey.entries()]
    .map(([key, group]) => ({
      key,
      severity: group.severity,
      code: group.code,
      description: plainText(codeMessages[group.code] ?? ""),
      count: group.issues.length,
      items: group.issues.slice(0, perGroup).map(itemOf),
      omitted: Math.max(0, group.issues.length - perGroup),
    }))
    .sort(
      (a, b) =>
        Number(b.severity === "error") - Number(a.severity === "error") ||
        b.count - a.count ||
        a.code.localeCompare(b.code),
    );
}
