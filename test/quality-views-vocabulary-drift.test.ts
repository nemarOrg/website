/**
 * Drift check for the quality-view vocabulary this site copies from nemar-cli (nemar-cli ADR 0137
 * decisions 2 and 10; website ADR 0035; epic nemarOrg/nemar-cli#2324, website#588).
 *
 * neuroschema owns the view vocabulary. nemar-cli vendors it once, in
 * `shared/contract/neuroschema/views/`, and lists every file with its size and SHA-256 in
 * `views/SHA256SUMS.json`. This site copies the registry and the montages with their provenance
 * (shipped, in `src/lib/quality-views/vocabulary/` and its `montages/`) and the parity vectors
 * (tests only, in `test/fixtures/quality-views/vectors/`) from there, by digest, with
 * `scripts/copy-quality-views-vocabulary.mjs`, which also writes `pin.json`. Three things are held:
 *
 * 1. Every copy is the file its pin names: its size and SHA-256, and no unpinned file beside it.
 *    This needs no nemar-cli and always runs, so a hand edit of a vector fails here.
 * 2. The pin is nemar-cli's: the same neuroschema version and commit, the same digest for every
 *    copied file, and every registry, montage or vector file nemar-cli lists is copied, so a vector
 *    or montage added upstream is not silently left out.
 * 3. CI checks nemar-cli out to make (2) strict.
 *
 * (2) follows the pattern of `validator-pin-drift.test.ts`: when `NEMAR_CLI_QUALITY_VIEWS` names
 * nemar-cli's `views/SHA256SUMS.json` a missing file FAILS; without it a sibling checkout is
 * searched and an absent one is a visible skip. Any pinned file found beside that list is hashed
 * too, so a list that disagrees with its own files is caught.
 *
 * EXPECTED RED in CI on the phase PR into the website epic branch until nemar-cli `dev` carries
 * neuroschema 0.6.0 (nemar-cli epic #2324), as for the Phase 4b drift test. The dependency is
 * one-directional: nemar-cli reads nothing here, so nemar-cli `dev` merges first and website
 * `staging` second.
 *
 * To follow nemar-cli: `NEMAR_CLI_DIR=<nemar-cli checkout> bun scripts/copy-quality-views-vocabulary.mjs`,
 * then commit the copies and the pin.
 */

import { describe, expect, it } from "vitest";
import pin from "../src/lib/quality-views/vocabulary/pin.json";
import registry from "../src/lib/quality-views/vocabulary/registry.json";
import { nodeFs, nodeProcess, repoPath, sha256Hex } from "./node";

interface PinnedFile {
  readonly path: string;
  readonly copy: string;
  readonly size: number;
  readonly sha256: string;
}

interface Pin {
  readonly neuroschema_version: string;
  readonly source_commit: string;
  readonly files: readonly PinnedFile[];
}

/** nemar-cli's `views/SHA256SUMS.json`, as far as this test reads it. */
interface VendoredSums {
  readonly neuroschema_version: string;
  readonly source_commit: string;
  readonly files: readonly {
    readonly path: string;
    readonly size: number;
    readonly sha256: string;
  }[];
}

const VOCABULARY_DIR = "src/lib/quality-views/vocabulary";
const MONTAGES_DIR = `${VOCABULARY_DIR}/montages`;
const VECTORS_DIR = "test/fixtures/quality-views/vectors";
/** The folders whose every `<name>.json` is copied, whatever its name, and where to. */
const COPIED_FOLDERS: Readonly<Record<string, string>> = {
  "montages/": MONTAGES_DIR,
  "vectors/": VECTORS_DIR,
};

/** Whether a nemar-cli path lies in a folder the site copies whole. */
const inCopiedFolder = (path: string): boolean =>
  Object.keys(COPIED_FOLDERS).some((folder) => path.startsWith(folder));

/**
 * Where the site keeps its copy of a nemar-cli view file, or null when it copies none. The same
 * rule as `destination()` in the copy script: every `vectors/<name>.json` and `montages/<name>.json`
 * is copied, whatever its name (PROVENANCE.json among the montages), and any other entry of those
 * folders is a problem `describePinDrift` reports, never a skip.
 */
function copyPathFor(path: string): string | null {
  if (path === "registry.json") return `${VOCABULARY_DIR}/registry.json`;
  for (const [folder, dir] of Object.entries(COPIED_FOLDERS)) {
    if (!path.startsWith(folder)) continue;
    const name = path.slice(folder.length);
    return /^[^/]+\.json$/.test(name) ? `${dir}/${name}` : null;
  }
  return null;
}

/** Every way the site's pin differs from nemar-cli's list; empty when they agree. */
function describePinDrift(ours: Pin, theirs: VendoredSums): string[] {
  const problems: string[] = [];
  for (const key of ["neuroschema_version", "source_commit"] as const) {
    if (ours[key] !== theirs[key]) {
      problems.push(`${key}: website "${ours[key]}", nemar-cli "${theirs[key]}"`);
    }
  }
  const listed = new Map(theirs.files.map((file) => [file.path, file]));
  const pinned = new Set(ours.files.map((file) => file.path));
  for (const file of ours.files) {
    const upstream = listed.get(file.path);
    if (!upstream) {
      problems.push(`${file.path}: pinned here, not listed by nemar-cli`);
    } else if (upstream.sha256 !== file.sha256 || upstream.size !== file.size) {
      problems.push(
        `${file.path}: website ${file.size} bytes ${file.sha256}, nemar-cli ${upstream.size} bytes ${upstream.sha256}`,
      );
    }
  }
  for (const file of theirs.files) {
    if (copyPathFor(file.path) !== null) {
      if (!pinned.has(file.path))
        problems.push(`${file.path}: listed by nemar-cli, not copied here`);
    } else if (inCopiedFolder(file.path)) {
      problems.push(
        `${file.path}: an entry of a copied folder the copy rule cannot place (a subfolder or not .json)`,
      );
    }
  }
  return problems;
}

describe("describePinDrift", () => {
  const sha = (c: string) => c.repeat(64);
  const theirs: VendoredSums = {
    neuroschema_version: "0.6.0",
    source_commit: "e09ed407",
    files: [
      { path: "registry.json", size: 10, sha256: sha("a") },
      { path: "vectors/sensor-field.v1.json", size: 20, sha256: sha("b") },
      { path: "montages/biosemi64.json", size: 30, sha256: sha("c") },
      { path: "examples/dataquality-record-nemar-ica.json", size: 40, sha256: sha("9") },
    ],
  };
  const ours: Pin = {
    neuroschema_version: "0.6.0",
    source_commit: "e09ed407",
    files: [
      {
        path: "registry.json",
        copy: `${VOCABULARY_DIR}/registry.json`,
        size: 10,
        sha256: sha("a"),
      },
      {
        path: "vectors/sensor-field.v1.json",
        copy: `${VECTORS_DIR}/sensor-field.v1.json`,
        size: 20,
        sha256: sha("b"),
      },
      {
        path: "montages/biosemi64.json",
        copy: `${MONTAGES_DIR}/biosemi64.json`,
        size: 30,
        sha256: sha("c"),
      },
    ],
  };

  it("says nothing when the pin agrees, and ignores files the site does not copy", () => {
    expect(describePinDrift(ours, theirs)).toEqual([]);
  });

  it("names a montage nemar-cli lists that is not copied here, PROVENANCE.json included", () => {
    const added = [
      ...theirs.files,
      { path: "montages/biosemi32.json", size: 5, sha256: sha("e") },
      { path: "montages/PROVENANCE.json", size: 5, sha256: sha("f") },
    ];
    expect(describePinDrift(ours, { ...theirs, files: added })).toEqual([
      "montages/biosemi32.json: listed by nemar-cli, not copied here",
      "montages/PROVENANCE.json: listed by nemar-cli, not copied here",
    ]);
  });

  it("names a changed montage by its digest", () => {
    const changed = theirs.files.map((file) =>
      file.path === "montages/biosemi64.json" ? { ...file, sha256: sha("d") } : file,
    );
    expect(describePinDrift(ours, { ...theirs, files: changed })).toEqual([
      `montages/biosemi64.json: website 30 bytes ${sha("c")}, nemar-cli 30 bytes ${sha("d")}`,
    ]);
  });

  it("names a moved release", () => {
    expect(describePinDrift(ours, { ...theirs, neuroschema_version: "0.6.1" })).toEqual([
      'neuroschema_version: website "0.6.0", nemar-cli "0.6.1"',
    ]);
    expect(describePinDrift(ours, { ...theirs, source_commit: "ffffffff" })).toHaveLength(1);
  });

  it("names a changed file by its digest or its size", () => {
    const changed = theirs.files.map((file) =>
      file.path === "registry.json" ? { ...file, sha256: sha("d") } : file,
    );
    expect(describePinDrift(ours, { ...theirs, files: changed })).toEqual([
      `registry.json: website 10 bytes ${sha("a")}, nemar-cli 10 bytes ${sha("d")}`,
    ]);
    const resized = theirs.files.map((file) =>
      file.path === "registry.json" ? { ...file, size: 11 } : file,
    );
    expect(describePinDrift(ours, { ...theirs, files: resized })).toHaveLength(1);
  });

  it("names a vectors/ entry the copy rule cannot place, never skipping it", () => {
    const odd = [
      ...theirs.files,
      { path: "vectors/nested/case.json", size: 5, sha256: sha("e") },
      { path: "vectors/notes.txt", size: 5, sha256: sha("f") },
      { path: "montages/sources/biosemi64.txt", size: 5, sha256: sha("7") },
    ];
    expect(describePinDrift(ours, { ...theirs, files: odd })).toEqual([
      "vectors/nested/case.json: an entry of a copied folder the copy rule cannot place (a subfolder or not .json)",
      "vectors/notes.txt: an entry of a copied folder the copy rule cannot place (a subfolder or not .json)",
      "montages/sources/biosemi64.txt: an entry of a copied folder the copy rule cannot place (a subfolder or not .json)",
    ]);
  });

  it("names a vector added upstream and a pinned file nemar-cli dropped", () => {
    const added = [
      ...theirs.files,
      { path: "vectors/new-kind.v1.json", size: 5, sha256: sha("e") },
    ];
    expect(describePinDrift(ours, { ...theirs, files: added })).toEqual([
      "vectors/new-kind.v1.json: listed by nemar-cli, not copied here",
    ]);
    const oddName = [
      ...theirs.files,
      { path: "vectors/ic_activity.v2.json", size: 5, sha256: sha("e") },
    ];
    expect(describePinDrift(ours, { ...theirs, files: oddName })).toEqual([
      "vectors/ic_activity.v2.json: listed by nemar-cli, not copied here",
    ]);
    const dropped = theirs.files.filter((file) => file.path !== "vectors/sensor-field.v1.json");
    expect(describePinDrift(ours, { ...theirs, files: dropped })).toEqual([
      "vectors/sensor-field.v1.json: pinned here, not listed by nemar-cli",
    ]);
  });
});

const fs = await nodeFs();
const proc = await nodeProcess();

describe("the copies are the files the pin names", () => {
  it("pins the registry, the montages' provenance, and at least one vector and montage, each where the copy rule puts it", () => {
    const paths = pin.files.map((file) => file.path);
    expect(paths).toContain("registry.json");
    expect(paths).toContain("montages/PROVENANCE.json");
    expect(paths.some((path) => path.startsWith("vectors/"))).toBe(true);
    expect(paths.some((path) => /^montages\/(?!PROVENANCE\.json$)/.test(path))).toBe(true);
    for (const file of pin.files) expect(file.copy, file.path).toBe(copyPathFor(file.path));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("matches every copy's size and SHA-256", async () => {
    for (const file of pin.files) {
      const bytes = fs.readFileSync(repoPath(file.copy));
      expect(bytes.length, file.copy).toBe(file.size);
      expect(await sha256Hex(bytes), file.copy).toBe(file.sha256);
    }
  });

  it("keeps no unpinned file beside the copies", () => {
    const pinned = new Set([...pin.files.map((file) => file.copy), `${VOCABULARY_DIR}/pin.json`]);
    const present = [VOCABULARY_DIR, MONTAGES_DIR, VECTORS_DIR]
      .flatMap((dir) => fs.readdirSync(repoPath(dir)).map((name) => `${dir}/${name}`))
      .filter((path) => path !== MONTAGES_DIR);
    expect(present.filter((path) => !pinned.has(path))).toEqual([]);
  });

  it("ships a registry in neuroschema's registry format", () => {
    expect(registry.format).toBe("neuroschema.views-registry.v1");
  });

  it("ships every montage PROVENANCE.json lists, at the digest it records, and no other", () => {
    const provenance = JSON.parse(
      fs.readFileSync(repoPath(`${MONTAGES_DIR}/PROVENANCE.json`), "utf8"),
    ) as { montages: { name: string; file: string; sha256: string }[] };
    const pinned = new Map(pin.files.map((file) => [file.path, file]));
    const listed = provenance.montages.map((montage) => `montages/${montage.name}.json`);
    for (const montage of provenance.montages) {
      expect(montage.file, montage.name).toBe(`views/montages/${montage.name}.json`);
      expect(pinned.get(`montages/${montage.name}.json`)?.sha256, montage.name).toBe(
        montage.sha256,
      );
    }
    const shipped = pin.files
      .map((file) => file.path)
      .filter((path) => path.startsWith("montages/") && path !== "montages/PROVENANCE.json");
    expect([...shipped].sort()).toEqual([...listed].sort());
  });
});

/** Where a nemar-cli checkout is expected, relative to `test/`, when the variable is unset. */
const SUMS_CANDIDATES = ["../../nemar-cli/shared/contract/neuroschema/views/SHA256SUMS.json"];

const fromEnv = proc.env.NEMAR_CLI_QUALITY_VIEWS;
const STRICT_PATH = fromEnv
  ? fromEnv.startsWith("/")
    ? fromEnv
    : `${proc.cwd()}/${fromEnv}`
  : undefined;
const FOUND = STRICT_PATH
  ? undefined
  : SUMS_CANDIDATES.map((relative) =>
      decodeURIComponent(new URL(relative, import.meta.url).pathname),
    ).find((path) => fs.existsSync(path));
const SUMS_PATH = STRICT_PATH ?? FOUND;
const SHOULD_SKIP = !STRICT_PATH && !FOUND;

if (SHOULD_SKIP) {
  console.info(
    `[quality-views vocabulary drift] skipped: no nemar-cli view vocabulary at ${SUMS_CANDIDATES.join(", ")} (relative to test/), and NEMAR_CLI_QUALITY_VIEWS is unset.`,
  );
}

describe.skipIf(SHOULD_SKIP)("the pin against nemar-cli's vendored neuroschema", () => {
  function theirs(): VendoredSums {
    const path = SUMS_PATH as string;
    if (!fs.existsSync(path)) {
      throw new Error(
        `[quality-views vocabulary drift] NEMAR_CLI_QUALITY_VIEWS=${fromEnv} resolved to ${path}, which does not exist. This test enforces the pin when the variable is set; it does not skip on a missing file. Check the sparse-checkout step in .github/workflows/ci.yml; the file reaches nemar-cli dev with epic #2324.`,
      );
    }
    return JSON.parse(fs.readFileSync(path, "utf8")) as VendoredSums;
  }

  it("names the same release and the same digest for every copied file", () => {
    expect(
      describePinDrift(pin, theirs()),
      [
        `src/lib/quality-views/vocabulary/pin.json drifted from ${SUMS_PATH}.`,
        "nemar-cli is the source of truth: run",
        "`NEMAR_CLI_DIR=<nemar-cli checkout> bun scripts/copy-quality-views-vocabulary.mjs` and commit the result.",
        "If this is a sibling checkout, make sure it is up to date with origin/dev first.",
      ].join(" "),
    ).toEqual([]);
  });

  it("hashes every pinned file nemar-cli has beside its list to the pinned digest", async () => {
    theirs();
    const dir = (SUMS_PATH as string).replace(/\/[^/]*$/, "");
    for (const file of pin.files) {
      const path = `${dir}/${file.path}`;
      if (!fs.existsSync(path)) continue;
      expect(await sha256Hex(fs.readFileSync(path)), path).toBe(file.sha256);
    }
  });
});

describe("the CI job that enforces it", () => {
  it("checks nemar-cli's list and registry out and makes the test strict about them", () => {
    const ci = fs.readFileSync(repoPath(".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("/shared/contract/neuroschema/views/SHA256SUMS.json");
    expect(ci).toContain("/shared/contract/neuroschema/views/registry.json");
    expect(ci).toContain("/shared/contract/neuroschema/views/montages/");
    expect(ci).toContain(
      "NEMAR_CLI_QUALITY_VIEWS: nemar-cli-contract/shared/contract/neuroschema/views/SHA256SUMS.json",
    );
  });
});
