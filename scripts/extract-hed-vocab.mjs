#!/usr/bin/env bun
/**
 * Build the viewer's HED annotation vocabulary bundle (website#255).
 *
 * Reads the two HED schema XML files from a local `hed-standard/hed-schemas`
 * checkout and writes a curated, versioned JSON bundle to
 * `src/lib/eeg-viewer/hed-vocab.json`. The bundle is committed, so the site
 * never fetches a schema at runtime and the annotation UI works offline.
 *
 * REGENERATE
 * ----------
 *   git -C <path-to>/hed-schemas pull
 *   bun scripts/extract-hed-vocab.mjs \
 *     --standard <path-to>/hed-schemas/standard_schema/hedxml/HED8.4.0.xml \
 *     --score    <path-to>/hed-schemas/library_schemas/score/hedxml/HED_score_2.1.0.xml
 *
 * Both flags default to a sibling `~/Documents/git/hed/hed-schemas` checkout.
 * Bump SCHEMA_VERSIONS below when you point it at newer schema files — the
 * version strings are written into the bundle and shown in the annotation UI,
 * and they are what a downstream `HEDVersion` sidecar entry has to match.
 *
 * WHOLE-SCHEMA SEARCH, CURATED QUICK-PICKS
 * ----------------------------------------
 * The bundle carries EVERY tag of both schemas (minus deprecated ones), so
 * the in-browser search reaches the whole vocabulary — an annotator asking
 * for "Building", "Left" or "Sleep" must find every tag that carries it
 * (Yahya, 2026-09-01; an earlier curated subset silently hid most of base
 * HED). Curation now lives only in `QUICK_PICKS`, which decides what the
 * popover OFFERS before anyone types, not what the search can FIND. The full
 * bundle stays a lazy chunk that loads with the popover, never with the
 * viewer.
 *
 * LIBRARY PREFIX
 * --------------
 * SCORE paths are emitted already prefixed (`sc:Episode/Epileptic-seizure`),
 * the conventional namespace in the HED-SCORE examples. A dataset consuming
 * the exported `events.tsv` therefore needs
 * `"HEDVersion": ["8.4.0", "sc:score_2.1.0"]` in its sidecar. Emitting the
 * prefix here rather than at export time keeps the serializer dumb: an
 * annotation stores the tag string that belongs in the file, verbatim.
 *
 * No XML dependency on purpose — hedxml is regular enough (nested `<node>`
 * with `<name>`/`<description>`/`<attribute>` children, no attributes on the
 * elements themselves, no CDATA) for the ~40-line scanner below, and a build
 * script that runs a handful of times a year should not add a dependency to
 * the lockfile.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SCHEMAS = join(homedir(), "Documents/git/hed/hed-schemas");
const OUT_PATH = join(REPO_ROOT, "src/lib/eeg-viewer/hed-vocab.json");

/** Schema identity written into the bundle. Bump alongside the input files. */
const SCHEMA_VERSIONS = {
  standard: { id: "HED8.4.0", name: "HED", version: "8.4.0", prefix: "" },
  score: { id: "SCORE2.1.0", name: "score", version: "2.1.0", prefix: "sc" },
};

/**
 * The quick-pick chips the annotation popover offers before anyone types.
 * Each is a bare short tag; the script fails if one does not resolve, so a
 * typo or a schema rename is caught at generation time rather than showing up
 * as a chip that inserts nothing.
 */
const QUICK_PICKS = [
  {
    group: "Epileptiform",
    tags: [
      "Epileptic-seizure",
      "Electroencephalographic-seizure",
      "Epileptiform-interictal-activity",
      "Spike",
      "Sharp-wave",
      "Spike-and-slow-wave",
      "Polyspikes",
      "High-frequency-oscillation",
      "Generalized-periodic-discharges",
      "Lateralized-periodic-discharges",
    ],
  },
  {
    group: "Sleep and background",
    tags: [
      "Sleep-spindles",
      "K-complex",
      "Vertex-wave",
      "Sleep-stage-N2",
      "Posterior-dominant-rhythm",
      "Background-burst-suppression",
    ],
  },
  {
    group: "Artifact",
    tags: [
      "Eye-blink-artifact",
      "Eye-movement-artifact",
      "EMG-artifact",
      "ECG-artifact",
      "Movement-artifact",
      "Chewing-artifact",
      "Line-noise-artifact",
      "Electrode-pops-artifact",
      "Electrode-movement-artifact",
      "Sweat-artifact",
    ],
  },
];

// --- hedxml scanner --------------------------------------------------------

/**
 * Parse the `<schema>` body of a hedxml file into a node tree. Only the four
 * element kinds hedxml actually uses inside `<schema>` are recognised; text
 * outside them is ignored, which is what makes the single-pass regex safe
 * here (there is no mixed content to lose).
 */
function parseSchema(xmlPath) {
  const xml = readFileSync(xmlPath, "utf8");
  const open = xml.indexOf("<schema>");
  const close = xml.indexOf("</schema>");
  if (open < 0 || close < 0) throw new Error(`no <schema> element in ${xmlPath}`);
  const body = xml.slice(open + "<schema>".length, close);

  const roots = [];
  const stack = [];
  const token =
    /<node>|<\/node>|<name>([\s\S]*?)<\/name>|<description>([\s\S]*?)<\/description>|<attribute>([\s\S]*?)<\/attribute>/g;
  let m = token.exec(body);
  while (m !== null) {
    if (m[0] === "<node>") {
      const node = { name: "", description: "", attributes: [], children: [] };
      if (stack.length > 0) stack[stack.length - 1].children.push(node);
      else roots.push(node);
      stack.push(node);
    } else if (m[0] === "</node>") {
      stack.pop();
    } else {
      const top = stack[stack.length - 1];
      if (top) {
        // `<name>` and `<description>` also appear *inside* `<attribute>`, but
        // an attribute's whole body is consumed by the third alternative
        // before the scanner can reach them, so the first `<name>` seen for a
        // node is always the node's own.
        if (m[1] !== undefined && top.name === "") top.name = decodeXml(m[1]);
        else if (m[2] !== undefined && top.description === "") top.description = decodeXml(m[2]);
        else if (m[3] !== undefined) {
          const attrName = /<name>([\s\S]*?)<\/name>/.exec(m[3]);
          if (attrName) top.attributes.push(decodeXml(attrName[1]));
        }
      }
    }
    m = token.exec(body);
  }
  return roots;
}

function decodeXml(text) {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Flatten a node tree to `{ name, path, description, attributes }` records. */
function flatten(node, parentPath, out) {
  // `#` is hedxml's placeholder child for a tag that takes a value
  // (`Sleep-deprivation/#`). It is not a selectable tag.
  if (node.name === "#") return out;
  const path = parentPath ? `${parentPath}/${node.name}` : node.name;
  out.push({
    name: node.name,
    path,
    description: node.description,
    attributes: node.attributes,
  });
  for (const child of node.children) flatten(child, path, out);
  return out;
}

// --- extraction ------------------------------------------------------------

function extract(standardPath, scorePath) {
  const entries = [];

  const standard = [];
  for (const root of parseSchema(standardPath)) flatten(root, "", standard);
  const byPath = new Map(standard.map((n) => [n.path, n]));
  for (const node of standard) {
    // Deprecated tags stay out: offering one would write a tag the schema
    // itself tells validators to reject.
    if (node.attributes.includes("deprecatedFrom")) continue;
    entries.push({
      tag: node.name,
      path: node.path,
      description: node.description,
      schema: SCHEMA_VERSIONS.standard.id,
    });
  }

  // The SCORE hedxml is the *merged* schema (`withStandard="8.4.0"`), so it
  // also carries every base-HED node. `inLibrary` marks the ones SCORE itself
  // contributes, which is precisely the half we want from this file.
  const score = [];
  for (const root of parseSchema(scorePath)) flatten(root, "", score);
  const prefix = SCHEMA_VERSIONS.score.prefix;
  for (const node of score) {
    if (!node.attributes.includes("inLibrary")) continue;
    if (node.attributes.includes("deprecatedFrom")) continue;
    entries.push({
      tag: node.name,
      path: `${prefix}:${node.path}`,
      description: node.description,
      schema: SCHEMA_VERSIONS.score.id,
    });
  }

  // Deterministic order, and a stable one for the search's tie-breaking:
  // schema first (base HED before SCORE), then long-form path.
  entries.sort((a, b) => a.schema.localeCompare(b.schema) || a.path.localeCompare(b.path));

  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) throw new Error(`duplicate tag path: ${entry.path}`);
    seen.add(entry.path);
  }
  return entries;
}

function resolveQuickPicks(entries) {
  const byTag = new Map();
  for (const entry of entries) {
    // A bare short tag is ambiguous only if two schemas define the same leaf.
    // None do today; if one ever does, the error below makes it visible rather
    // than letting a quick pick silently resolve to the wrong schema.
    if (byTag.has(entry.tag)) {
      throw new Error(`short tag "${entry.tag}" is ambiguous across schemas`);
    }
    byTag.set(entry.tag, entry);
  }
  return QUICK_PICKS.map(({ group, tags }) => ({
    group,
    paths: tags.map((tag) => {
      const entry = byTag.get(tag);
      if (!entry) throw new Error(`quick pick "${tag}" is not in the extracted vocabulary`);
      return entry.path;
    }),
  }));
}

// --- main ------------------------------------------------------------------

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const standardPath = argValue(
  "--standard",
  join(DEFAULT_SCHEMAS, "standard_schema/hedxml/HED8.4.0.xml"),
);
const scorePath = argValue(
  "--score",
  join(DEFAULT_SCHEMAS, "library_schemas/score/hedxml/HED_score_2.1.0.xml"),
);

const entries = extract(standardPath, scorePath);
const quickPicks = resolveQuickPicks(entries);
const bundle = {
  // Bumped by hand when the *shape* changes, so a stale cached copy in
  // IndexedDB or a service worker can be told apart from a current one.
  bundleVersion: 1,
  schemas: [SCHEMA_VERSIONS.standard, SCHEMA_VERSIONS.score],
  quickPicks,
  entries,
};

// Minified: this file is loaded as a lazy chunk over the network, and it is a
// generated artifact nobody reads as source (biome is told to skip it).
writeFileSync(OUT_PATH, JSON.stringify(bundle));

const bytes = JSON.stringify(bundle).length;
const perSchema = new Map();
for (const entry of entries) perSchema.set(entry.schema, (perSchema.get(entry.schema) ?? 0) + 1);
console.log(`wrote ${OUT_PATH}`);
console.log(
  `  ${entries.length} tags (${[...perSchema].map(([k, v]) => `${k}: ${v}`).join(", ")})`,
);
console.log(`  ${quickPicks.reduce((n, g) => n + g.paths.length, 0)} quick picks`);
console.log(`  ${(bytes / 1024).toFixed(1)} KB raw`);
