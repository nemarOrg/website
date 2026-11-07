/**
 * Parity between the dataset page's Compute dialog and the REAL `nemar` help (website ADR 0030 phase E5
 * addendum; nemarOrg/website#498).
 *
 * `test/fixtures/compute/cli-help/*.txt` is the unchanged output of `nemar <command> --help-all`,
 * captured with
 *
 *   NEMAR_CLI_DIR=<nemar-cli Epic D checkout> bun scripts/capture-compute-cli-help.mjs
 *
 * (the commit is in `index.json`). Every command the dialog prints must be a command that help lists,
 * every long flag must be in that command's help, and every explanation that paraphrases the help must
 * still have its line there. A command or flag renamed in nemar-cli is caught by rerunning the capture
 * and this file, not by a visitor copying a command that fails.
 */
import { describe, expect, it } from "vitest";
import { buildComputeInstructions, commandWords } from "../src/lib/compute-instructions";

const files = import.meta.glob("./fixtures/compute/cli-help/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function help(name: string): string {
  const text = files[`./fixtures/compute/cli-help/${name}`];
  if (text === undefined) throw new Error(`missing fixture ${name}; run the capture script`);
  return text;
}

const INDEX = JSON.parse(help("index.json")) as { nemar_cli_commit: string; commands: string[] };

const result = buildComputeInstructions({
  datasetId: "nm000104",
  version: "1.0.2",
  anonymous: false,
  unpublished: false,
  open: true,
});
if (result.kind !== "ready") throw new Error("the parity fixture input must be ready");
const ROWS = result.steps.flatMap((s) => s.rows);

/** The subcommand names `nemar compute --help-all` lists under "Commands:". */
function listedSubcommands(): string[] {
  const out: string[] = [];
  let inCommands = false;
  for (const line of help("compute.txt").split("\n")) {
    if (/^Commands:/.test(line)) {
      inCommands = true;
      continue;
    }
    const m = inCommands ? /^ {2}([a-z][a-z-]*)\b/.exec(line) : null;
    if (m?.[1] && m[1] !== "help") out.push(m[1]);
  }
  return out;
}

describe("the fixture", () => {
  it("names the nemar-cli commit it was captured from and lists every file", () => {
    expect(INDEX.nemar_cli_commit).toMatch(/^[0-9a-f]{8}$/);
    for (const command of INDEX.commands) {
      const name = `${command.replace(/ /g, "-")}.txt`;
      expect(help(name), name).toContain("Usage: nemar");
    }
  });

  it("lists the ten compute subcommands the plan was written against", () => {
    expect(listedSubcommands()).toEqual([
      "balance",
      "cancel",
      "limits",
      "list",
      "logs",
      "queue",
      "request-access",
      "results",
      "status",
      "submit",
    ]);
  });
});

describe("every command the dialog prints exists in the captured help", () => {
  it("covers every row", () => {
    expect(ROWS.length).toBeGreaterThan(8);
    for (const row of ROWS) {
      for (const { sub, flags } of commandWords(row.command)) {
        expect(sub.length, row.command).toBeGreaterThan(0);
        if (sub[0] === "login") {
          expect(sub).toEqual(["login"]);
          expect(help("login.txt")).toContain("Usage: nemar login");
          continue;
        }
        expect(sub[0], row.command).toBe("compute");
        const name = sub[1] as string;
        expect(listedSubcommands(), `nemar compute ${name}`).toContain(name);
        const text = help(`compute-${name}.txt`);
        expect(text).toContain(`Usage: nemar compute ${name}`);
        for (const flag of flags) {
          expect(text, `${flag} in nemar compute ${name}`).toMatch(
            new RegExp(`(^|[\\s,])${flag}(\\s|$|<|,)`, "m"),
          );
        }
      }
    }
  });

  it("uses only the dataset form the help shows: --dataset <id@version>, like nm000104@1.0.2", () => {
    const submit = help("compute-submit.txt");
    expect(submit).toContain("--dataset <id@version>");
    expect(submit).toContain("nm000104@1.0.2");
    const datasetFlags = ROWS.flatMap((r) => r.command.match(/--dataset \S+/g) ?? []);
    expect(datasetFlags.length).toBe(3);
    for (const flag of datasetFlags) expect(flag).toMatch(/^--dataset (nm|on)\d{6}@v?\d+\.\d+\.\d+$/);
  });

  it("a renamed command or flag would fail (mutation check)", () => {
    const flagInHelp = (flag: string) =>
      new RegExp(`(^|[\\s,])${flag}(\\s|$|<|,)`, "m").test(help("compute-submit.txt"));
    expect(flagInHelp("--dataset")).toBe(true);
    expect(flagInHelp("--data")).toBe(false);
    expect(listedSubcommands()).toContain("list");
    expect(listedSubcommands()).not.toContain("jobs");
  });
});

describe("every explanation that paraphrases the help still has its line there", () => {
  const CLAIMS: [string, string, string][] = [
    ["access is asked once", "compute-request-access.txt", "You ask once"],
    ["the request says what is missing", "compute-request-access.txt", "which are missing"],
    ["a dry run sends nothing about the job", "compute-submit.txt", "sends nothing about the job"],
    ["a dry run needs no sign-in", "compute-submit.txt", "it needs no sign-in"],
    ["a dataset names its version", "compute-submit.txt", "--dataset <id@version>"],
    ["a folder needs the file to run", "compute-submit.txt", "A folder needs --entry"],
    ["wait follows the job", "compute-submit.txt", "--wait follows the job until it ends"],
    ["Ctrl-C does not cancel", "compute-submit.txt", "Ctrl-C stops waiting and does NOT cancel the job"],
    ["limits are per partition", "compute-limits.txt", "what one job may ask for on each partition"],
    ["balance works in every state", "compute-balance.txt", "It works in every access state"],
    ["the queue is the platform's, not a promise", "compute-queue.txt", "not a promise"],
    ["results download into a folder", "compute-results.txt", "--download <dir>"],
    ["the job id is printed by submit", "compute-submit.txt", "returns the job's id"],
  ];
  for (const [claim, file, phrase] of CLAIMS) {
    it(claim, () => {
      expect(help(file).replace(/\s+/g, " ")).toContain(phrase);
    });
  }
});
