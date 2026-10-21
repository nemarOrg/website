/**
 * Guards on the vendored BIDS validator (website ADR 0028).
 *
 * The validator is committed as a built file, because Bun cannot install it and Cloudflare's build
 * has no Deno. A committed build is only as good as the checks that it is what it says it is, and
 * CI never rebuilds it, so these are those checks:
 *
 *  - the bytes on disk are the bytes the checksum list names, and nothing else is in the folder;
 *  - the release they carry is the one `validator-version.json` pins;
 *  - the two sources and the lock they were built from are the ones in the working tree, so editing
 *    the worker or the protocol without rebuilding fails here instead of shipping a stale worker;
 *  - the worker's own Content-Security-Policy (`public/_headers`) is the one the privacy sentence
 *    on the page relies on, and the page's policy gained nothing.
 *
 * Every read goes through `./node.ts`; see there for why.
 */

import { describe, expect, it } from "vitest";
import { workerUrl } from "../src/lib/bids-validation/client";
import { PRIVACY_HED_NOTICE } from "../src/lib/bids-validation/wording";
import { contentSecurityPolicy } from "../src/middleware";
import pin from "../validator-version.json";
import { nodeFs, repoPath, sha256Hex } from "./node";

const fs = await nodeFs();
const VENDOR_ROOT = "public/vendor/bids-validator";
const DIR = `${VENDOR_ROOT}/${pin.version}`;

const text = (relative: string): string => fs.readFileSync(repoPath(relative), "utf8");
const bytes = (relative: string): Uint8Array => fs.readFileSync(repoPath(relative));

interface Provenance {
  bundle: string;
  bundlerShims: Record<string, string>;
  dependencies: Record<string, string>;
  deno: string;
  lock: { file: string; sha256: string };
  regenerate: string;
  schemaVersion: string;
  sources: Record<string, string>;
  validator: { specifier: string; version: string };
}

// Read inside each test, not here: a pin that moved without a rebuild has no folder, and that
// should fail the first test below in words, not stop the whole file from loading.
const readProvenance = (): Provenance => JSON.parse(text(`${DIR}/provenance.json`)) as Provenance;

/** `sha256sum` format: a hex digest, two spaces, a file name. */
function parseSums(list: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of list.split("\n")) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!match) throw new Error(`SHA256SUMS has a line that is not "<sha256>  <name>": ${line}`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

const REBUILD = "deno run -A scripts/vendor-bids-validator.ts";

describe("the vendored @bids/validator bundle", () => {
  it("is vendored for the pinned release and for no other", () => {
    // A bump replaces the folder; a second release beside it would be dead weight in every deploy.
    expect(
      fs.readdirSync(repoPath(VENDOR_ROOT)),
      `validator-version.json pins ${pin.version}. Rebuild with: ${REBUILD}`,
    ).toEqual([pin.version]);
  });

  it("holds exactly the files its checksum list names, and the list", () => {
    const named = [...parseSums(text(`${DIR}/SHA256SUMS`)).keys()];
    expect(fs.readdirSync(repoPath(DIR)).sort()).toEqual([...named, "SHA256SUMS"].sort());
  });

  it("matches its checksum list, byte for byte", async () => {
    const mismatched: string[] = [];
    for (const [name, expected] of parseSums(text(`${DIR}/SHA256SUMS`))) {
      if ((await sha256Hex(bytes(`${DIR}/${name}`))) !== expected) mismatched.push(name);
    }
    expect(mismatched, `Hand-edited? Rebuild with: ${REBUILD}`).toEqual([]);
  });

  it("carries the pinned release on its first line", () => {
    const first = text(`${DIR}/${readProvenance().bundle}`).split("\n", 1)[0];
    const match = /^\/\*! @bids\/validator (\d+\.\d+\.\d+) /.exec(first);
    expect(match?.[1], `validator-version.json says ${pin.version}. Rebuild with: ${REBUILD}`).toBe(
      pin.version,
    );
  });

  it("records the pinned release, the schema it ships, and how it was built", () => {
    const provenance = readProvenance();
    expect(provenance.validator).toEqual({
      specifier: `${pin.specifier}@${pin.version}`,
      version: pin.version,
    });
    expect(provenance.bundle).toBe("bids-validator-worker.js");
    expect(provenance.regenerate).toBe(REBUILD);
    expect(provenance.deno).toMatch(/^\d+\.\d+\.\d+$/);
    expect(provenance.schemaVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(provenance.dependencies["@bids/schema"]).toBe(provenance.schemaVersion);
    expect(provenance.dependencies["@bids/validator"]).toBe(pin.version);
  });

  it("was built from the sources and the lock that are in the working tree", async () => {
    const provenance = readProvenance();
    expect(Object.keys(provenance.sources).sort()).toEqual([
      "scripts/bids-validator-worker.ts",
      "src/lib/bids-validation/protocol.ts",
    ]);
    const stale: string[] = [];
    for (const [source, built] of Object.entries(provenance.sources)) {
      if ((await sha256Hex(bytes(source))) !== built) stale.push(source);
    }
    if ((await sha256Hex(bytes(provenance.lock.file))) !== provenance.lock.sha256) {
      stale.push(provenance.lock.file);
    }
    expect(stale, `Changed since the worker was built. Rebuild with: ${REBUILD}`).toEqual([]);
  });

  it("ships the license of every package it was built from, and of the shims the bundler added", () => {
    const provenance = readProvenance();
    const licenses = text(`${DIR}/THIRD_PARTY_LICENSES.txt`);
    // The lock's packages, and the Node.js shims that come with Deno and are in no lock.
    const missing = [
      ...Object.entries(provenance.dependencies),
      ...Object.entries(provenance.bundlerShims),
    ]
      .filter(([name, version]) => !licenses.includes(`\n${name} ${version} (`))
      .map(([name, version]) => `${name}@${version}`);
    expect(missing).toEqual([]);
    expect(Object.keys(provenance.bundlerShims)).toEqual(["@jspm/core"]);
  });
});

/** The rules of `public/_headers`: a path line, then its indented `Name: value` lines. */
function parseHeaderRules(file: string): Map<string, Map<string, string>> {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of file.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      rules.set(line.trim(), current);
    } else if (current) {
      const colon = line.indexOf(":");
      current.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
  }
  return rules;
}

/** A policy as directive name to source list. Whole tokens: `'wasm-unsafe-eval'` is not `'unsafe-eval'`. */
function parsePolicy(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name !== "")
      .map(([name, ...sources]) => [name, sources] as const),
  );
}

describe("the Content-Security-Policy of the validator worker", () => {
  const rules = parseHeaderRules(text("public/_headers"));
  const directives = parsePolicy(
    rules.get("/vendor/bids-validator/*")?.get("Content-Security-Policy") ?? "",
  );

  it("is served from the folder the page loads the worker from", () => {
    expect(workerUrl().startsWith("/vendor/bids-validator/")).toBe(true);
    expect(fs.existsSync(repoPath(`public${workerUrl()}`))).toBe(true);
  });

  it("lets the worker evaluate code, which the validator does, and nothing else", () => {
    expect(directives.get("script-src")).toEqual(["'self'", "'unsafe-eval'"]);
    expect(directives.get("default-src")).toEqual(["'none'"]);
  });

  it("lets the worker reach one host, the one a HED schema is downloaded from", () => {
    expect(directives.get("connect-src")).toEqual(["https://raw.githubusercontent.com"]);
  });

  it("sends no Referer on the one request it can make", () => {
    expect(rules.get("/vendor/bids-validator/*")?.get("Referrer-Policy")).toBe("no-referrer");
  });

  it("is the only static-asset rule that allows eval", () => {
    const allowing = [...rules.entries()]
      .filter(([, headers]) =>
        parsePolicy(headers.get("Content-Security-Policy") ?? "")
          .get("script-src")
          ?.includes("'unsafe-eval'"),
      )
      .map(([path]) => path);
    expect(allowing).toEqual(["/vendor/bids-validator/*"]);
  });

  it("says what it allows in the sentence the page shows about it", () => {
    // The page promises that nothing leaves the worker except a HED schema download from this
    // host, so the host in the promise and the host in the policy must be one.
    const [host] = directives.get("connect-src") ?? [];
    expect(PRIVACY_HED_NOTICE).toContain(host.replace("https://", ""));
  });

  it("leaves the policy of the upload page without eval", () => {
    // The point of running the validator in a worker: no relaxation of the page that holds the
    // session and the attestation. (`/dataset/` has its own, from ADR 0009; `'wasm-unsafe-eval'`,
    // which every page has, is compilation of WebAssembly and not this.)
    for (const path of ["/upload", "/upload/success"]) {
      const scripts = parsePolicy(contentSecurityPolicy(path)).get("script-src") ?? [];
      expect(scripts).not.toContain("'unsafe-eval'");
    }
    expect(contentSecurityPolicy("/upload")).toContain("worker-src 'self' blob:");
  });
});
