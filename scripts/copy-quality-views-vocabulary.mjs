/**
 * Copy the quality-view vocabulary from nemar-cli's vendored neuroschema, byte for byte, and pin
 * every copy by its SHA-256 (nemar-cli ADR 0137 decisions 2 and 10; website ADR 0035; epic
 * nemarOrg/nemar-cli#2324, website#588).
 *
 *   NEMAR_CLI_DIR=<checkout of nemar-cli> bun scripts/copy-quality-views-vocabulary.mjs
 *   NEMAR_CLI_DIR=<checkout of nemar-cli> bun scripts/copy-quality-views-vocabulary.mjs --check
 *
 * nemar-cli vendors neuroschema once, in `shared/contract/neuroschema/views/`, and lists each file
 * with its size and SHA-256 in `views/SHA256SUMS.json`. This site copies what it uses from there,
 * never from neuroschema directly, so there is one vendoring hop:
 *
 *   views/registry.json    ->  src/lib/quality-views/vocabulary/registry.json   (shipped: the kinds)
 *   views/montages/*.json  ->  src/lib/quality-views/vocabulary/montages/       (shipped: the montages
 *                              that place sensors by name, and PROVENANCE.json, their sources and
 *                              licenses)
 *   views/vectors/*.json   ->  test/fixtures/quality-views/vectors/            (tests only, never shipped)
 *
 * Each source file is checked against nemar-cli's SHA256SUMS.json before anything is written, so a
 * checkout whose files do not match its own list is refused. The copies are listed in
 * `src/lib/quality-views/vocabulary/pin.json` with neuroschema's version and commit, which
 * test/quality-views-vocabulary-drift.test.ts holds against the copies and against nemar-cli.
 *
 * With --check nothing is written: the copies and the pin are rebuilt in memory and compared with
 * what is on disk (every file, and no file more or less); each difference is printed, and the exit
 * code is 1 on any.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const check = process.argv.includes("--check");
const NEMAR_CLI_DIR = process.env.NEMAR_CLI_DIR;
if (!NEMAR_CLI_DIR) {
  console.error(
    "Set NEMAR_CLI_DIR to a nemar-cli checkout that carries neuroschema 0.6.0 or later.",
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const VIEWS = join(resolve(NEMAR_CLI_DIR), "shared", "contract", "neuroschema", "views");
const VOCABULARY_DIR = "src/lib/quality-views/vocabulary";
const MONTAGES_DIR = `${VOCABULARY_DIR}/montages`;
const VECTORS_DIR = "test/fixtures/quality-views/vectors";
const PIN_PATH = `${VOCABULARY_DIR}/pin.json`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const sumsPath = join(VIEWS, "SHA256SUMS.json");
if (!existsSync(sumsPath))
  fail(`${sumsPath} does not exist: this nemar-cli has no view vocabulary.`);
const sums = JSON.parse(readFileSync(sumsPath, "utf8"));
if (sums.format !== "nemar.vendored-files.v1") fail(`${sumsPath}: unknown format ${sums.format}`);

/** The folders whose every `<name>.json` is copied, whatever its name, and where to. */
const COPIED_FOLDERS = { "montages/": MONTAGES_DIR, "vectors/": VECTORS_DIR };

/**
 * Where a nemar-cli view file goes in this repository, or null when the site does not copy it.
 * Every `vectors/<name>.json` and `montages/<name>.json` is copied, whatever its name (in montages/
 * that includes PROVENANCE.json, the montages' sources and licenses); any other entry of those
 * folders (a subfolder, a file that is not JSON) is refused below rather than skipped.
 */
function destination(path) {
  if (path === "registry.json") return `${VOCABULARY_DIR}/registry.json`;
  for (const [folder, dir] of Object.entries(COPIED_FOLDERS)) {
    if (!path.startsWith(folder)) continue;
    const name = path.slice(folder.length);
    return /^[^/]+\.json$/.test(name) ? `${dir}/${name}` : null;
  }
  return null;
}

const unplaceable = sums.files
  .map((entry) => entry.path)
  .filter(
    (path) =>
      Object.keys(COPIED_FOLDERS).some((folder) => path.startsWith(folder)) &&
      destination(path) === null,
  );
if (unplaceable.length > 0) {
  fail(
    `nemar-cli lists montages/ or vectors/ entries the copy rule cannot place (a subfolder or not .json): ${unplaceable.join(", ")}. Widen the rule here and in test/quality-views-vocabulary-drift.test.ts.`,
  );
}

const files = [];
const outputs = new Map();
for (const entry of sums.files) {
  const copy = destination(entry.path);
  if (copy === null) continue;
  const bytes = readFileSync(join(VIEWS, entry.path));
  const digest = sha256(bytes);
  if (bytes.length !== entry.size || digest !== entry.sha256) {
    fail(
      `${entry.path}: ${bytes.length} bytes, sha256 ${digest}; nemar-cli's SHA256SUMS.json says ${entry.size} bytes, ${entry.sha256}. Refusing to copy.`,
    );
  }
  files.push({ path: entry.path, copy, size: entry.size, sha256: entry.sha256 });
  outputs.set(copy, bytes);
}
if (!files.some((file) => file.path === "registry.json")) fail("nemar-cli lists no registry.json.");
if (!files.some((file) => file.path === "montages/PROVENANCE.json")) {
  fail(
    "nemar-cli lists no montages/PROVENANCE.json: the montages' sources and licenses must travel with them.",
  );
}
files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const pin = {
  format: "nemar.website-vendored-views.v1",
  description:
    "The neuroschema view files this site copies from nemar-cli's shared/contract/neuroschema/views/, byte for byte: each file's path there, its copy here, its size and its SHA-256, with the neuroschema release they come from.",
  generated_by: "scripts/copy-quality-views-vocabulary.mjs",
  note: "Do not hand-edit; rerun the script against nemar-cli.",
  neuroschema_version: sums.neuroschema_version,
  source_commit: sums.source_commit,
  files,
};
outputs.set(PIN_PATH, Buffer.from(`${JSON.stringify(pin, null, 2)}\n`));

/** Every entry now under the copy directories, as repository paths (the montages folder itself is
 *  not an entry: its files are). */
function present() {
  const found = [];
  for (const dir of [VOCABULARY_DIR, MONTAGES_DIR, VECTORS_DIR]) {
    if (!existsSync(join(repo, dir))) continue;
    for (const name of readdirSync(join(repo, dir))) {
      const path = `${dir}/${name}`;
      if (path !== MONTAGES_DIR) found.push(path);
    }
  }
  return found;
}

if (check) {
  const problems = [];
  for (const [path, bytes] of outputs) {
    const abs = join(repo, path);
    if (!existsSync(abs)) problems.push(`${path}: missing`);
    else if (!readFileSync(abs).equals(bytes)) problems.push(`${path}: differs from nemar-cli`);
  }
  for (const path of present()) if (!outputs.has(path)) problems.push(`${path}: not in the pin`);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exit(1);
  console.log(
    `quality-views vocabulary matches nemar-cli (neuroschema ${pin.neuroschema_version}).`,
  );
  process.exit(0);
}

rmSync(join(repo, VECTORS_DIR), { recursive: true, force: true });
rmSync(join(repo, MONTAGES_DIR), { recursive: true, force: true });
for (const path of present()) if (!outputs.has(path)) rmSync(join(repo, path), { recursive: true });
for (const [path, bytes] of outputs) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), bytes);
}
console.log(
  `Copied ${files.length} files from neuroschema ${pin.neuroschema_version} (${pin.source_commit.slice(0, 8)}).`,
);
