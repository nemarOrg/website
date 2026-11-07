/**
 * Capture the REAL `nemar` command-line help the dataset page's Compute dialog quotes (website ADR 0030,
 * phase E5 addendum; epic nemarOrg/website#493, issue #498).
 *
 *   NEMAR_CLI_DIR=<checkout of nemar-cli's Epic D branch> \
 *     bun scripts/capture-compute-cli-help.mjs
 *
 * Runs `bun run src/index.ts --no-color <command> --help-all` in the checkout for `login`, `compute` and
 * each `compute` subcommand, and writes the output unchanged under test/fixtures/compute/cli-help/:
 *
 *   login.txt, compute.txt, compute-<subcommand>.txt, and index.json (the commit and the command list)
 *
 * `test/compute-instructions-cli-parity.test.ts` reads these files, so a command or flag renamed in
 * nemar-cli is caught by rerunning this script and the test, not by a visitor copying a command that
 * fails. Nothing here is written by hand. The checkout needs `bun install` at its root.
 *
 * Last captured from nemar-cli commit 27eecff9 (Epic D, `feature/issue-2021-epic-compute-users`); the commit of each capture is in index.json.
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NEMAR_CLI_DIR = process.env.NEMAR_CLI_DIR;
if (!NEMAR_CLI_DIR) {
  console.error("Set NEMAR_CLI_DIR to a checkout of nemar-cli's Epic D branch.");
  process.exit(1);
}
const root = resolve(NEMAR_CLI_DIR);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "..", "test", "fixtures", "compute", "cli-help");

/** Run the CLI from source and return what it printed; a non-zero exit stops the capture. */
function run(args) {
  const result = spawnSync("bun", ["run", "src/index.ts", "--no-color", ...args, "--help-all"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", NEMAR_NO_UPDATE_CHECK: "1" },
  });
  if (result.status !== 0) {
    console.error(`nemar ${args.join(" ")} --help-all failed (${result.status}):\n${result.stderr}`);
    process.exit(1);
  }
  return result.stdout;
}

const commit = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();

// The subcommand names come from the CLI's own `compute --help-all` list, never from this script.
const compute = run(["compute"]);
const subcommands = [];
let inCommands = false;
for (const line of compute.split("\n")) {
  if (/^Commands:/.test(line)) {
    inCommands = true;
    continue;
  }
  if (!inCommands) continue;
  const m = /^ {2}([a-z][a-z-]*)\b/.exec(line);
  if (m && m[1] !== "help") subcommands.push(m[1]);
}
if (subcommands.length === 0) {
  console.error("No subcommands found in `nemar compute --help-all`.");
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
const write = (name, text) => writeFile(join(OUT, name), text.endsWith("\n") ? text : `${text}\n`);

await write("login.txt", run(["login"]));
await write("compute.txt", compute);
for (const sub of subcommands) await write(`compute-${sub}.txt`, run(["compute", sub]));
await write(
  "index.json",
  `${JSON.stringify(
    {
      note: "Real output of `nemar <command> --help-all`; regenerate with scripts/capture-compute-cli-help.mjs",
      nemar_cli_commit: commit,
      commands: ["login", "compute", ...subcommands.map((s) => `compute ${s}`)],
    },
    null,
    2,
  )}\n`,
);
console.log(`Wrote ${subcommands.length + 3} files to ${OUT} from nemar-cli ${commit}`);
