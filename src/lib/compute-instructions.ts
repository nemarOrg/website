/**
 * The dataset page's Compute dialog, as data (website ADR 0030, phase E5 addendum; epic
 * nemarOrg/website#493, issue #498).
 *
 * ONE PURE BUILDER, from facts the page already holds. It builds the `nemar compute` commands a person
 * copies; it decides nothing about access, balance, limits or eligibility. Those are the backend's, and
 * the CLI prints its answer. The result is a discriminated union so the markup cannot show a command
 * the data plane could not serve:
 *
 *  - `closed`: compute is not open in this build (`computeRequestsOpen`); no commands.
 *  - `not_available`: the dataset is an anonymous deposit, unpublished, has no version, is outside the
 *    `nm` and `on` ids, or has a version of the wrong shape; no commands. The reason is for tests and
 *    for the page's own bookkeeping; the visitor reads ONE sentence for every reason, as the backend
 *    answers (`dataset_not_eligible` does not say which term failed).
 *  - `ready`: the steps.
 *
 * The id-band rule is a UI pre-filter on facts the page holds, not a copy of the backend's rule: the
 * reserved fixture band and withdrawn or tombstoned datasets still reach the CLI, which prints the
 * backend's refusal. nemarOrg/nemar-cli#2091 asks for an eligibility fact on a public read so this
 * filter can go; until then the backend stays the authority.
 *
 * Every command is pinned to the captured CLI help (`test/fixtures/compute/cli-help/`,
 * `scripts/capture-compute-cli-help.mjs`) by `test/compute-instructions-cli-parity.test.ts`. No limit,
 * price, balance, allocation size, storage URL or machine is named here. Where a job finds the staged
 * data and where it writes is not in the CLI's help, so it is not said (nemarOrg/nemar-cli#2092).
 */

import { ACCOUNT_COPY } from "./account-copy";
import { COMPUTE_LABELS } from "./compute-labels";

/** Datasets the dialog offers commands for: a real NEMAR id or an OpenNeuro mirror. */
const COMPUTE_DATASET_ID = /^(nm|on)\d{6}$/;
/** A published version as the dataset page holds it; the CLI accepts the bare and the `v` form. */
const COMPUTE_VERSION = /^v?\d+\.\d+\.\d+$/;

export interface ComputeInstructionsInput {
  datasetId: string;
  version: string | null;
  /** The dataset is an anonymous deposit (its repository is private until publication). */
  anonymous: boolean;
  /** The dataset has no published version. */
  unpublished: boolean;
  /** `computeRequestsOpen(COMPUTE_REQUESTS_ENABLED, apiBase())` for this build. */
  open: boolean;
}

export type NotAvailableReason =
  | "anonymous"
  | "unpublished"
  | "no_version"
  | "id_band"
  | "version_shape";

export type StepId = "install" | "access" | "check" | "run" | "follow";

/** A link a step carries; the markup maps the kind to a URL, so no URL lives in this module. */
export interface StepLink {
  kind: "install" | "request_access";
  label: string;
}

export interface InstructionRow {
  label: string;
  /** The exact copyable text; one command per line. */
  command: string;
  explanation: string;
}

export interface InstructionStep {
  id: StepId;
  heading: string;
  link: StepLink | null;
  rows: InstructionRow[];
}

export type ComputeInstructions =
  | { kind: "closed" }
  | { kind: "not_available"; reason: NotAvailableReason }
  | { kind: "ready"; datasetId: string; version: string; steps: InstructionStep[] };

const L = COMPUTE_LABELS.datasetDialog;

/** The job-id placeholder the follow row prints; the one placeholder a copied command carries. */
export const JOB_PLACEHOLDER = "<job>";

export function buildComputeInstructions(input: ComputeInstructionsInput): ComputeInstructions {
  if (!input.open) return { kind: "closed" };
  if (input.anonymous) return { kind: "not_available", reason: "anonymous" };
  if (input.unpublished) return { kind: "not_available", reason: "unpublished" };
  if (input.version === null || input.version === "") {
    return { kind: "not_available", reason: "no_version" };
  }
  if (!COMPUTE_DATASET_ID.test(input.datasetId)) {
    return { kind: "not_available", reason: "id_band" };
  }
  if (!COMPUTE_VERSION.test(input.version)) {
    return { kind: "not_available", reason: "version_shape" };
  }

  const dataset = `${input.datasetId}@${input.version}`;
  const steps: InstructionStep[] = [
    {
      id: "install",
      heading: L.install.heading,
      link: { kind: "install", label: L.install.link },
      rows: [{ label: L.install.signIn, command: "nemar login", explanation: "" }],
    },
    {
      id: "access",
      heading: L.access.heading,
      link: { kind: "request_access", label: ACCOUNT_COPY["compute_access.request.cta"] },
      rows: [
        {
          label: L.access.row,
          command: "nemar compute request-access",
          explanation: L.access.explain,
        },
      ],
    },
    {
      id: "check",
      heading: L.check.heading,
      link: null,
      rows: [
        {
          label: L.check.row,
          command: `nemar compute submit analysis.py --dataset ${dataset} --dry-run`,
          explanation: L.check.explain,
        },
      ],
    },
    {
      id: "run",
      heading: L.run.heading,
      link: null,
      rows: [
        {
          label: L.run.script,
          command: `nemar compute submit analysis.py --dataset ${dataset} --wait`,
          explanation: L.run.scriptExplain,
        },
        {
          label: L.run.folder,
          command: `nemar compute submit ./study --entry run.py --dataset ${dataset}`,
          explanation: L.run.folderExplain,
        },
        {
          label: L.run.limits,
          command: "nemar compute limits",
          explanation: L.run.limitsExplain,
        },
        {
          label: L.run.balance,
          command: "nemar compute balance",
          explanation: L.run.balanceExplain,
        },
      ],
    },
    {
      id: "follow",
      heading: L.follow.heading,
      link: null,
      rows: [
        {
          label: L.follow.row,
          command: [
            "nemar compute list",
            `nemar compute status ${JOB_PLACEHOLDER}`,
            `nemar compute logs ${JOB_PLACEHOLDER}`,
            `nemar compute results ${JOB_PLACEHOLDER} --download ./results`,
            `nemar compute cancel ${JOB_PLACEHOLDER}`,
          ].join("\n"),
          explanation: L.follow.explain,
        },
        {
          label: L.follow.queue,
          command: "nemar compute queue",
          explanation: `${L.follow.queueLead} ${ACCOUNT_COPY["compute_page.queue_note"]}`,
        },
      ],
    },
  ];
  return { kind: "ready", datasetId: input.datasetId, version: input.version, steps };
}

/** What a command line names, for the parity test: its subcommand path and its long flags. */
export interface CommandWords {
  sub: string[];
  flags: string[];
}

/** One entry per line of a (possibly multi-line) command. */
export function commandWords(command: string): CommandWords[] {
  return command
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      const words = line.split(/\s+/);
      if (words[0] !== "nemar") return { sub: [], flags: [] };
      const sub: string[] = [];
      for (const word of words.slice(1)) {
        if (word.startsWith("-") || word.startsWith("<")) break;
        // A path or a script is an argument, not a subcommand: only `compute <name>` has a second word.
        if (sub.length === 1 && sub[0] !== "compute") break;
        if (sub.length === 2) break;
        sub.push(word);
      }
      const flags = words.filter((w) => w.startsWith("--")).map((w) => w.split("=")[0] as string);
      return { sub, flags };
    });
}

/** Every string a `ready` result can print, for the honesty tests. */
export function instructionStrings(result: ComputeInstructions): string[] {
  if (result.kind !== "ready") return [];
  const out: string[] = [];
  for (const step of result.steps) {
    out.push(step.heading);
    if (step.link) out.push(step.link.label);
    for (const row of step.rows) out.push(row.label, row.command, row.explanation);
  }
  return out;
}
