import { describe, expect, it } from "vitest";
import { ACCOUNT_COPY } from "./account-copy";
import {
  type ComputeInstructionsInput,
  buildComputeInstructions,
  commandWords,
  instructionStrings,
} from "./compute-instructions";
import { COMPUTE_LABELS } from "./compute-labels";

/** The shape `ActionBar` passes for a published dataset, compute open. */
const GOOD: ComputeInstructionsInput = {
  datasetId: "nm000104",
  version: "1.0.2",
  anonymous: false,
  unpublished: false,
  open: true,
};

function ready(input: Partial<ComputeInstructionsInput> = {}) {
  const result = buildComputeInstructions({ ...GOOD, ...input });
  if (result.kind !== "ready") throw new Error(`expected ready, got ${JSON.stringify(result)}`);
  return result;
}

function commands(input: Partial<ComputeInstructionsInput> = {}): string[] {
  return ready(input).steps.flatMap((s) => s.rows.map((r) => r.command));
}

describe("a published dataset", () => {
  it("names the dataset with its id and version in every submit command", () => {
    const submits = commands().filter((c) => c.startsWith("nemar compute submit"));
    expect(submits).toEqual([
      "nemar compute submit analysis.py --dataset nm000104@1.0.2 --dry-run",
      "nemar compute submit analysis.py --dataset nm000104@1.0.2 --wait",
      "nemar compute submit ./study --entry run.py --dataset nm000104@1.0.2",
    ]);
  });

  it("orders the steps: install, access, check, run, follow", () => {
    expect(ready().steps.map((s) => s.id)).toEqual(["install", "access", "check", "run", "follow"]);
  });

  it("carries the follow row as one copyable multi-line command with only <job> as a placeholder", () => {
    const follow = ready().steps.find((s) => s.id === "follow");
    const row = follow?.rows[0];
    expect(row?.command.split("\n")).toEqual([
      "nemar compute list",
      "nemar compute status <job>",
      "nemar compute logs <job>",
      "nemar compute results <job> --download ./results",
      "nemar compute cancel <job>",
    ]);
    for (const command of commands()) {
      const placeholders = command.match(/<[^>]+>/g) ?? [];
      for (const p of placeholders) expect(p).toBe("<job>");
    }
  });

  it("opens the access step with the shared lede, verbatim, and no other step", () => {
    const steps = ready().steps;
    expect(steps.find((s) => s.id === "access")?.lead).toBe(
      ACCOUNT_COPY["compute_access.section.lede"],
    );
    expect(steps.filter((s) => s.lead !== null).map((s) => s.id)).toEqual(["access"]);
  });

  it("takes its access words from the shared copy table", () => {
    const access = ready().steps.find((s) => s.id === "access");
    expect(access?.link).toEqual({
      kind: "request_access",
      label: ACCOUNT_COPY["compute_access.request.cta"],
    });
    const queue = ready().steps.at(-1)?.rows.at(-1);
    expect(queue?.explanation).toContain(ACCOUNT_COPY["compute_page.queue_note"]);
  });

  it("passes the ids of both offered bands through unchanged", () => {
    expect(ready({ datasetId: "nm000104" }).datasetId).toBe("nm000104");
    expect(ready({ datasetId: "on004696" }).datasetId).toBe("on004696");
    expect(commands({ datasetId: "on004696" }).join("\n")).toContain("--dataset on004696@1.0.2");
  });

  it("accepts a bare and a v-prefixed version, passed through as the page holds it", () => {
    expect(commands({ version: "v1.0.2" }).join("\n")).toContain("--dataset nm000104@v1.0.2");
    expect(commands({ version: "1.0.2" }).join("\n")).toContain("--dataset nm000104@1.0.2");
  });
});

describe("what is not offered", () => {
  it("is closed when compute is not open, even for a good dataset", () => {
    expect(buildComputeInstructions({ ...GOOD, open: false })).toEqual({ kind: "closed" });
  });

  it("closed outranks every other reason", () => {
    expect(
      buildComputeInstructions({ ...GOOD, open: false, anonymous: true, unpublished: true }),
    ).toEqual({ kind: "closed" });
  });

  it("gives each ineligible dataset its own reason", () => {
    const reason = (input: Partial<ComputeInstructionsInput>) => {
      const r = buildComputeInstructions({ ...GOOD, ...input });
      return r.kind === "not_available" ? r.reason : r.kind;
    };
    expect(reason({ anonymous: true })).toBe("anonymous");
    expect(reason({ unpublished: true })).toBe("unpublished");
    expect(reason({ version: null })).toBe("no_version");
    expect(reason({ version: "" })).toBe("no_version");
    expect(reason({ datasetId: "ds000117" })).toBe("id_band");
    expect(reason({ datasetId: "xx099900" })).toBe("id_band");
    expect(reason({ datasetId: "nm00010" })).toBe("id_band");
    expect(reason({ datasetId: "nm000104/../x" })).toBe("id_band");
    expect(reason({ version: "abc" })).toBe("version_shape");
    expect(reason({ version: "1.0" })).toBe("version_shape");
    expect(reason({ version: "latest" })).toBe("version_shape");
    expect(reason({ version: "1.0.2; rm -rf" })).toBe("version_shape");
  });

  it("an anonymous deposit never reaches ready, whatever else is true", () => {
    expect(buildComputeInstructions({ ...GOOD, anonymous: true }).kind).toBe("not_available");
  });

  it("prints no strings for a result that is not ready", () => {
    expect(instructionStrings({ kind: "closed" })).toEqual([]);
  });
});

describe("honesty: what the dialog never says", () => {
  const FORBIDDEN: [string, RegExp][] = [
    ["a storage prefix", /s3:\/\//i],
    ["npm", /\bnpm\b/i],
    ["the Neuroscience Gateway", /nsg|nsgportal|neuroscience\s*gateway/i],
    ["rclone", /rclone/i],
    ["the AWS CLI", /\baws\b/i],
    ["a URL", /https?:/i],
    ["a resource flag", /--(cores|mem|time|partition|gpus|nodes)\b/],
    ["a promise", /\b(free|fast|guarantee[ds]?|unlimited|instant)\b/i],
    ["a machine or a host", /\b(expanse|sdsc|supercomputer|slurm|allocation)\b/i],
  ];

  /** The forbidden things found in some strings, as "what: string" lines. */
  function offenders(strings: string[]): string[] {
    return strings.flatMap((s) =>
      FORBIDDEN.filter(([, re]) => re.test(s)).map(([what]) => `${what}: ${s}`),
    );
  }

  it("no string of a ready result contains a forbidden word", () => {
    const strings = instructionStrings(ready());
    expect(strings.length).toBeGreaterThan(10);
    expect(offenders(strings)).toEqual([]);
  });

  it("states no number besides the example version and the placeholder", () => {
    for (const s of instructionStrings(ready())) {
      const stripped = s.replace(/nm000104@1\.0\.2/g, "");
      expect(stripped, s).not.toMatch(/\d/);
    }
  });

  it("no label and no shared key the dialog reads contains a forbidden word, a link or a number", () => {
    const flatten = (v: unknown): string[] =>
      typeof v === "string" ? [v] : Object.values(v as object).flatMap(flatten);
    const labels = flatten(COMPUTE_LABELS.datasetDialog);
    // Every string the dialog can render that is not a command: the labels (title, intro, step
    // headings, explanations, link labels, the three fallback sentences) and the shared keys it reads.
    const shared = [
      ACCOUNT_COPY["compute_access.section.lede"],
      ACCOUNT_COPY["compute_access.request.cta"],
      ACCOUNT_COPY["compute_access.granted.link"],
      ACCOUNT_COPY["compute_access.terms_unpublished.body"],
      ACCOUNT_COPY["compute_page.queue_note"],
    ];
    const all = [...labels, ...shared];
    expect(labels.length).toBeGreaterThan(25);
    expect(offenders(all)).toEqual([]);
    for (const s of all) expect(s, s).not.toMatch(/\d/);
  });

  it("catches each forbidden thing when it returns (mutation check)", () => {
    const base = instructionStrings(ready());
    for (const bad of [
      "s3://nemar/nm000104",
      "npm install -g nemar-cli",
      "https://nsgportal.org",
      "rclone sync",
      "aws s3 ls",
      "nemar compute submit x --cores 8",
      "It is free",
      "Jobs run on a supercomputer",
    ]) {
      expect(offenders([...base, bad]), bad).not.toEqual([]);
    }
  });
});

describe("commandWords", () => {
  it("names the subcommand path and the long flags of each line", () => {
    expect(commandWords("nemar login")).toEqual([{ sub: ["login"], flags: [] }]);
    expect(
      commandWords("nemar compute submit ./study --entry run.py --dataset nm000104@1.0.2"),
    ).toEqual([{ sub: ["compute", "submit"], flags: ["--entry", "--dataset"] }]);
    expect(
      commandWords("nemar compute list\nnemar compute results <job> --download ./results"),
    ).toEqual([
      { sub: ["compute", "list"], flags: [] },
      { sub: ["compute", "results"], flags: ["--download"] },
    ]);
  });

  it("is empty for a line that is not a nemar command", () => {
    expect(commandWords("curl -s x")).toEqual([{ sub: [], flags: [] }]);
  });
});
