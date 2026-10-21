/**
 * Vendors the @bids/validator release pinned in `validator-version.json` as one browser module,
 * built with `deno bundle` and committed under `public/vendor/bids-validator/<version>/`
 * (website ADR 0028).
 *
 *   deno run -A scripts/vendor-bids-validator.ts             rebuild from the committed lock
 *   deno run -A scripts/vendor-bids-validator.ts --relock    after the pin moved: resolve afresh
 *
 * Run it whenever `validator-version.json` changes, which is whenever nemar-cli's pin changes (the
 * website's CI compares the two and fails until they agree), and whenever the two sources the
 * bundle is built from change: `scripts/bids-validator-worker.ts` and
 * `src/lib/bids-validation/protocol.ts`. `test/bids-validator-vendor.test.ts` fails until you do.
 *
 * Why Deno and not Bun: the validator is published on JSR only, and Bun cannot install a `jsr:`
 * specifier. It is not a step of `bun run build` for the same reason, and Cloudflare's build image
 * has no Deno: the output is committed, and CI checks the committed bytes, never rebuilds them.
 *
 * What it writes, all of it hash-checked by that test:
 *   bids-validator-worker.js    the bundle (a module worker script; also exports `validate`)
 *   THIRD_PARTY_LICENSES.txt    the license of every package the bundle was built from
 *   provenance.json             versions, tool, and the hashes of the inputs
 *   SHA256SUMS                  `sha256sum -c` format, for the three files above
 *
 * The build is reproducible: same pin, same sources, same lock and same Deno give the same bytes
 * on any machine, from a cold cache and from any directory (the build runs in a temporary copy of
 * its two sources, so nothing about this checkout is visible to it). Code splitting is off on
 * purpose: its chunk names are derived from the Deno cache path, which would make the bytes depend
 * on whose machine built them.
 *
 * Identical bytes need two things beyond those inputs. The first is network access: a cold cache
 * fetches the packages from jsr.io and npm, and the license text of the bundler's shims comes from
 * unpkg.com. The second is the exact Deno that built the committed bundle, 2.9.7 (`deno` in
 * `provenance.json`): a different bundler can give different bytes for the same inputs, and the
 * script prints a note when the Deno it runs is not the one that built what is committed.
 */

const BUNDLE = "bids-validator-worker.js";
const ENTRY = "scripts/bids-validator-worker.ts";
const SOURCES = [ENTRY, "src/lib/bids-validation/protocol.ts"] as const;
const LOCK = "scripts/bids-validator-worker.lock";
const PIN = "validator-version.json";
const OUT_ROOT = "public/vendor/bids-validator";
const LICENSES = "THIRD_PARTY_LICENSES.txt";
const PROVENANCE = "provenance.json";
const SUMS = "SHA256SUMS";
const REGENERATE = "deno run -A scripts/vendor-bids-validator.ts";

/**
 * The Node.js shims `deno bundle --platform browser` adds to the bundle. They come with Deno and
 * are not in the lock, so the lock's license list does not cover them; this does. `chunks` are the
 * files of that release that the bundle names in the legal comments it keeps at its end. If a new
 * Deno brings other shims those names change, the build stops here, and the license below is never
 * the wrong release's.
 */
const SHIMS = {
  name: "@jspm/core",
  version: "2.1.0",
  chunks: ["chunk-B738Er4n.js", "chunk-CjPlbOtt.js", "chunk-DtuTasat.js"],
} as const;

const root = new URL("../", import.meta.url);
const at = (relative: string) => decodeURIComponent(new URL(relative, root).pathname);

class VendorError extends Error {}

function fail(message: string): never {
  throw new VendorError(message);
}

async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function gzipSize(bytes: Uint8Array): Promise<number> {
  const stream = new Blob([bytes as BufferSource])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return (await new Response(stream).arrayBuffer()).byteLength;
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function readPin(): Promise<string> {
  const pin = JSON.parse(await Deno.readTextFile(at(PIN))) as {
    version?: string;
    specifier?: string;
  };
  // Stable releases only: the pin is what the repository check runs, and it never runs a pre-release.
  if (!pin.version || !/^\d+\.\d+\.\d+$/.test(pin.version)) {
    fail(`${PIN}: "version" must be a release like 3.0.2, got ${JSON.stringify(pin.version)}`);
  }
  if (pin.specifier !== "jsr:@bids/validator") {
    fail(`${PIN}: "specifier" must be "jsr:@bids/validator", got ${JSON.stringify(pin.specifier)}`);
  }
  return pin.version;
}

interface LockFile {
  specifiers: Record<string, string>;
  jsr: Record<string, unknown>;
  npm: Record<string, unknown>;
}

async function readLock(path: string = at(LOCK)): Promise<LockFile> {
  return JSON.parse(await Deno.readTextFile(path)) as LockFile;
}

/** Run `deno` with the given arguments. Output is shown only when the command fails: a successful
 *  bundle prints a few hundred lines of duplicate-key warnings from a dependency. */
async function deno(args: string[], cwd: string, what: string): Promise<void> {
  const { success, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).output();
  if (!success) {
    const text = new TextDecoder();
    fail(`${what} failed:\n${text.decode(stdout)}${text.decode(stderr)}`);
  }
}

/** The Deno that built the committed bundle, from its provenance, if there is one. */
async function readCommittedDeno(path: string): Promise<string | undefined> {
  if (!(await exists(path))) return undefined;
  return (JSON.parse(await Deno.readTextFile(path)) as { deno?: string }).deno;
}

/** `name@version` from a lock key, which is `@scope/name@version` or `name@version`. */
function splitKey(key: string): { name: string; version: string } {
  const separator = key.lastIndexOf("@");
  return { name: key.slice(0, separator), version: key.slice(separator + 1) };
}

async function licenseTexts(lock: LockFile): Promise<string> {
  const decoder = new TextDecoder();
  const npmCache = JSON.parse(
    decoder.decode(
      (await new Deno.Command(Deno.execPath(), { args: ["info", "--json"] }).output()).stdout,
    ),
  ).npmCache as string;

  const sections: { title: string; text: string }[] = [];

  for (const key of Object.keys(lock.jsr).sort()) {
    const { name, version } = splitKey(key);
    const url = `https://jsr.io/${name}/${version}/LICENSE`;
    const response = await fetch(url);
    if (!response.ok) fail(`no license file at ${url} (${response.status}); read it by hand`);
    sections.push({ title: `${name} ${version} (JSR)`, text: (await response.text()).trim() });
  }

  for (const key of Object.keys(lock.npm).sort()) {
    const { name, version } = splitKey(key);
    const dir = `${npmCache}/registry.npmjs.org/${name}/${version}`;
    const manifest = JSON.parse(await Deno.readTextFile(`${dir}/package.json`)) as {
      license?: string;
    };
    let text: string | undefined;
    for await (const entry of Deno.readDir(dir)) {
      if (/^(licen[cs]e|copying)/i.test(entry.name) && entry.isFile) {
        text = (await Deno.readTextFile(`${dir}/${entry.name}`)).trim();
        break;
      }
    }
    sections.push({
      title: `${name} ${version} (npm, ${manifest.license ?? "no license field"})`,
      text:
        text ??
        `This package declares ${manifest.license ?? "no license"} in its package.json and ships no license file.`,
    });
  }

  // The bundler's own shims (buffer, an in-memory file system, ...). The package's LICENSE is the
  // Apache license followed by the notices of the Node.js code it was made from.
  const shimsUrl = `https://unpkg.com/${SHIMS.name}@${SHIMS.version}/LICENSE`;
  const shims = await fetch(shimsUrl);
  if (!shims.ok) fail(`no license file at ${shimsUrl} (${shims.status}); read it by hand`);
  sections.push({
    title: `${SHIMS.name} ${SHIMS.version} (npm, Apache-2.0; Node.js shims added by the bundler)`,
    text: (await shims.text()).trim(),
  });

  const rule = "-".repeat(78);
  return [
    "Third-party software in the @bids/validator browser bundle.",
    "",
    "bids-validator-worker.js is built from the packages below, at the versions pinned in",
    "scripts/bids-validator-worker.lock, and from the Node.js shims the bundler adds (the last",
    "entry). Each text is the license file the package ships. The BIDS schema in the bundle is",
    "the @bids/schema package listed here.",
    "",
    ...sections.flatMap(({ title, text }) => [rule, title, rule, text, ""]),
  ].join("\n");
}

async function main(): Promise<void> {
  const relock = Deno.args.includes("--relock");
  const unknown = Deno.args.filter((arg) => arg !== "--relock");
  if (unknown.length > 0)
    fail(`unknown argument(s): ${unknown.join(" ")}. Only --relock is accepted.`);

  const version = await readPin();
  const lockPath = at(LOCK);

  if (relock) {
    // Nothing to check: the lock is made afresh, and replaces the committed one only if the build
    // succeeds, so a failed `--relock` leaves the lock it started from.
  } else if (!(await exists(lockPath))) {
    fail(`${LOCK} does not exist. Run with --relock to resolve the dependencies and create it.`);
  } else if (!(`jsr:@bids/validator@${version}` in (await readLock()).specifiers)) {
    fail(
      [
        `${PIN} says ${version}, but ${LOCK} was made for another release.`,
        "Run with --relock to resolve the new release's dependencies afresh.",
      ].join(" "),
    );
  }

  // A temporary copy of the two sources, in their own layout, so that the build sees nothing of
  // this checkout: not its package.json, not its path, not a stray deno.json above it.
  const work = await Deno.makeTempDir({ prefix: "bids-validator-vendor-" });
  const lockInUse = relock ? `${work}/relock.lock` : lockPath;
  try {
    for (const source of SOURCES) {
      await Deno.mkdir(`${work}/${source.slice(0, source.lastIndexOf("/"))}`, { recursive: true });
      await Deno.copyFile(at(source), `${work}/${source}`);
    }
    await Deno.writeTextFile(
      `${work}/import_map.json`,
      JSON.stringify({ imports: { "@bids/validator/": `jsr:/@bids/validator@${version}/` } }),
    );

    // Typed against the real package: a renamed export or a changed signature stops here, at the
    // bump, rather than in a browser. No lock: the check also wants types the bundle never loads.
    await deno(
      ["check", "--no-config", "--no-lock", "--import-map", "import_map.json", ENTRY],
      work,
      "type check",
    );

    await deno(
      [
        "bundle",
        "--no-config",
        "--platform",
        "browser",
        "--format",
        "esm",
        "--minify",
        "--import-map",
        "import_map.json",
        "--lock",
        lockInUse,
        ...(relock ? [] : ["--frozen-lockfile"]),
        "-o",
        `out/${BUNDLE}`,
        ENTRY,
      ],
      work,
      "deno bundle",
    );
    const built = await Deno.readTextFile(`${work}/out/${BUNDLE}`);

    if (!built.includes("WorkerGlobalScope")) fail("the bundle lost the worker entry");

    // The shims the bundler added must be the ones whose license this script ships.
    const shimChunks = [
      ...built.matchAll(/@jspm\/core\/nodelibs\/browser\/(chunk-[A-Za-z0-9_-]+\.js)/g),
    ]
      .map((match) => match[1])
      .sort();
    if (JSON.stringify(shimChunks) !== JSON.stringify([...SHIMS.chunks])) {
      fail(
        [
          `the bundler's Node.js shims are not ${SHIMS.name}@${SHIMS.version}'s (the bundle names`,
          `${shimChunks.join(", ") || "none"}; expected ${SHIMS.chunks.join(", ")}).`,
          "A different Deno brings different shims: set SHIMS in this script to the release that has",
          "those chunks, and read its license, before running this again.",
        ].join(" "),
      );
    }

    const lock = await readLock(lockInUse);
    const schema = Object.keys(lock.jsr).find((key) => key.startsWith("@bids/schema@"));
    if (!schema) fail("the lock has no @bids/schema; the build is not what it should be");
    const schemaVersion = splitKey(schema).version;
    // The schema is a JSON object inlined in the bundle that names its own version: it must be the
    // one the lock says. (The validator's own version is not inlined, once `getVersion` is not
    // exported; the banner below carries it instead, and the exact `jsr:` version in the import
    // map is what makes it true.)
    const inlined = /"?schema_version"?\s*:\s*"([^"]+)"/.exec(built);
    if (inlined?.[1] !== schemaVersion) {
      fail(`the lock says BIDS schema ${schemaVersion} but the bundle carries ${inlined?.[1]}`);
    }

    // The first line is the version marker `test/bids-validator-vendor.test.ts` reads.
    const banner = `/*! @bids/validator ${version} and its dependencies, bundled by scripts/vendor-bids-validator.ts. Licenses: ${LICENSES}. Do not edit; regenerate. */\n`;
    const bundle = new TextEncoder().encode(banner + built);
    const licenses = new TextEncoder().encode(await licenseTexts(lock));

    const sources: Record<string, string> = {};
    for (const source of SOURCES) sources[source] = await sha256(await Deno.readFile(at(source)));
    const provenance = new TextEncoder().encode(
      `${JSON.stringify(
        {
          bundle: BUNDLE,
          dependencies: Object.fromEntries(
            [...Object.keys(lock.jsr), ...Object.keys(lock.npm)]
              .map(splitKey)
              .map((dependency) => [dependency.name, dependency.version])
              .sort(),
          ),
          deno: Deno.version.deno,
          bundlerShims: { [SHIMS.name]: SHIMS.version },
          lock: { file: LOCK, sha256: await sha256(await Deno.readFile(lockInUse)) },
          regenerate: REGENERATE,
          schemaVersion,
          sources,
          validator: { specifier: `jsr:@bids/validator@${version}`, version },
        },
        null,
        2,
      )}\n`,
    );

    const files: [string, Uint8Array][] = [
      [BUNDLE, bundle],
      [LICENSES, licenses],
      [PROVENANCE, provenance],
    ];
    const sums = `${(await Promise.all(files.map(async ([name, bytes]) => `${await sha256(bytes)}  ${name}`))).join("\n")}\n`;

    // Only the pinned release stays: a bump replaces the directory, it does not add a sibling.
    const outDir = at(`${OUT_ROOT}/${version}`);
    const committedDeno = await readCommittedDeno(`${outDir}/${PROVENANCE}`);
    // Everything that can fail has: from here the lock and the files are written, in that order.
    if (relock) await Deno.copyFile(lockInUse, lockPath);
    await Deno.mkdir(at(OUT_ROOT), { recursive: true });
    const stale: string[] = [];
    for await (const entry of Deno.readDir(at(OUT_ROOT))) {
      if (entry.isDirectory) stale.push(entry.name);
    }
    for (const name of stale) await Deno.remove(at(`${OUT_ROOT}/${name}`), { recursive: true });
    await Deno.mkdir(outDir, { recursive: true });
    for (const [name, bytes] of files) await Deno.writeFile(`${outDir}/${name}`, bytes);
    await Deno.writeTextFile(`${outDir}/${SUMS}`, sums);

    console.log(
      `@bids/validator ${version}, BIDS schema ${schemaVersion}, Deno ${Deno.version.deno}`,
    );
    if (committedDeno !== undefined && committedDeno !== Deno.version.deno) {
      console.warn(
        `note: the bundle that was committed was built by Deno ${committedDeno}; this is Deno ${Deno.version.deno}, and a different bundler can give different bytes for the same inputs.`,
      );
    }
    console.log(`${OUT_ROOT}/${version}/`);
    console.log(`  ${BUNDLE}  ${bundle.byteLength} bytes, ${await gzipSize(bundle)} gzip`);
    console.log(
      `  ${LICENSES}  ${Object.keys(lock.jsr).length} JSR and ${Object.keys(lock.npm).length} npm packages`,
    );
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

try {
  await main();
} catch (error) {
  if (!(error instanceof VendorError)) throw error;
  console.error(`vendor-bids-validator: ${error.message}`);
  Deno.exit(1);
}
