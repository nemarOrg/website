/**
 * Capture the REAL `nemar admin compute pipeline` help the admin Pipelines tab quotes (nemar-cli
 * ADR 0134 decision 5; epic nemarOrg/nemar-cli#2324 phase 4b, website#586).
 *
 *   NEMAR_CLI_DIR=<checkout of nemar-cli's epic #2324 branch> \
 *     bun scripts/capture-pipeline-cli-help.mjs
 *
 * Runs `bun run src/index.ts --no-color admin compute pipeline <sub> --help-all` in the checkout for
 * `status` and `failures`, and writes the output unchanged under
 * test/fixtures/compute/cli-help-pipeline/ with index.json (the commit and the command list).
 * Separate from `capture-compute-cli-help.mjs` so the dataset dialog's help files are not
 * re-captured from another branch.
 *
 * `test/compute-pipeline-cli-parity.test.ts` reads these files: every sentence the tab says about
 * what a mark, a status or the coverage means must appear in this text, so the page and the CLI
 * say the same thing. Nothing here is written by hand. The checkout needs `bun install` at its root.
 */

import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NEMAR_CLI_DIR = process.env.NEMAR_CLI_DIR;
if (!NEMAR_CLI_DIR) {
  console.error("Set NEMAR_CLI_DIR to a checkout of nemar-cli's epic #2324 branch.");
  process.exit(1);
}
const root = resolve(NEMAR_CLI_DIR);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "..", "test", "fixtures", "compute", "cli-help-pipeline");
const SUBCOMMANDS = ["status", "failures"];

/** Run the CLI from source and return what it printed; a non-zero exit stops the capture. */
function run(args) {
  const { FORCE_COLOR: _drop, ...rest } = process.env;
  const result = spawnSync("bun", ["run", "src/index.ts", "--no-color", ...args, "--help-all"], {
    cwd: root,
    encoding: "utf8",
    env: { ...rest, NO_COLOR: "1", NEMAR_NO_UPDATE_CHECK: "1" },
  });
  if (result.status !== 0) {
    console.error(
      `nemar ${args.join(" ")} --help-all failed (${result.status}):\n${result.stderr}`,
    );
    process.exit(1);
  }
  return result.stdout;
}

const commit = spawnSync("git", ["rev-parse", "--short=8", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();

await mkdir(OUT, { recursive: true });
const write = (name, text) => writeFile(join(OUT, name), text.endsWith("\n") ? text : `${text}\n`);

for (const sub of SUBCOMMANDS) {
  await write(`${sub}.txt`, run(["admin", "compute", "pipeline", sub]));
}
await write(
  "index.json",
  `${JSON.stringify(
    {
      note: "Real output of `nemar admin compute pipeline <sub> --help-all`; regenerate with scripts/capture-pipeline-cli-help.mjs",
      nemar_cli_commit: commit,
      commands: SUBCOMMANDS.map((s) => `admin compute pipeline ${s}`),
    },
    null,
    2,
  )}\n`,
);
console.log(`Wrote ${SUBCOMMANDS.length + 1} files to ${OUT} from nemar-cli ${commit}`);
