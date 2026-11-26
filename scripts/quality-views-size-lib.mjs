/**
 * The measuring half of `check-quality-views-size.mjs`, with no file system and no build, so
 * `test/quality-views-size.test.ts` can run it on chunk layouts made to order (website ADR 0035
 * decision 1; website#592).
 *
 * What is measured, in a directory of emitted scripts:
 *
 * - The client chunks: every script that carries the client's own error text.
 * - The roots: every chunk some script other than a client chunk imports dynamically
 *   (`import("./x.js")`) whose static imports reach a client chunk. Each is what a page loads lazily to draw views, so each is
 *   measured with every chunk it imports statically, against the main-thread budget. Two lazy
 *   panels that share the client are two roots: when Vite splits the client into a chunk of its
 *   own, measuring from that chunk alone would miss a panel's own code (website#592).
 * - When no dynamically imported chunk reaches the client (it is bundled into an entry, or into the
 *   chunk under measurement as a whole), the client chunks themselves are the roots, as before.
 * - Every other chunk whose static imports reach the client but that no root's set holds: the
 *   client loaded eagerly, not lazily (a page statically importing a panel that imports the
 *   client). Each such chunk that imports a client chunk itself is measured, with its static
 *   imports, against the main-thread budget; the chunks above it (the page) are named in a note,
 *   since their own code is the page's, not the views'.
 * - The module worker(s) a `new Worker(new URL(...))` in a measured set names, against the worker
 *   budget. A chunk a measured set imports only dynamically (the fallback for a browser without
 *   workers) is listed but not counted.
 */

import { gzipSync } from "node:zlib";

export const KB = 1024;
export const BUDGET = { worker: 12 * KB, mainThread: 30 * KB };
/** Text only the client carries (`UNREADABLE_ANSWER` in worker-client.ts). */
export const CLIENT_MARKER = "the map worker sent an answer this page cannot read";

export const gzipped = (bytes) => gzipSync(bytes, { level: 9 }).length;
export const kb = (bytes) => `${(bytes / KB).toFixed(1)} KB`;

/** The relative chunks a script imports statically, among `files`. */
export function staticImports(text, files) {
  return [
    ...text.matchAll(/(?:^|[;}\s])import\s*(?:[\w$*{}\s,]+from\s*)?["']\.\/([^"']+\.js)["']/g),
  ]
    .map((m) => m[1])
    .filter((file) => files.has(file));
}

/** The relative chunks a script imports dynamically, among `files`. */
export function dynamicImports(text, files) {
  return [...text.matchAll(/import\(\s*["']\.\/([^"']+\.js)["']\s*\)/g)]
    .map((m) => m[1])
    .filter((file) => files.has(file));
}

/** `roots` and every chunk they import statically, transitively. */
export function staticClosure(roots, files) {
  const text = (name) => files.get(name).toString("utf8");
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...staticImports(text(name), files));
  }
  return seen;
}

/**
 * The roots to measure from: the dynamically imported chunks whose static closure holds a client
 * chunk, or, when there is none, the client chunks. `clients` is empty when no script carries the
 * client.
 */
export function measurementRoots(files) {
  const text = (name) => files.get(name).toString("utf8");
  const clients = [...files.keys()].filter((name) => text(name).includes(CLIENT_MARKER)).sort();
  if (clients.length === 0) return { clients, roots: [], fromDynamicImports: false };
  // A chunk the client itself imports lazily (its in-thread fallback for a browser without
  // workers) is the client's own, not a page's way in, so it is never a root.
  const targets = new Set();
  for (const name of files.keys()) {
    if (clients.includes(name)) continue;
    for (const file of dynamicImports(text(name), files)) targets.add(file);
  }
  const roots = [...targets]
    .filter((target) => clients.some((client) => staticClosure([target], files).has(client)))
    .sort();
  return roots.length > 0
    ? { clients, roots, fromDynamicImports: true }
    : { clients, roots: clients, fromDynamicImports: false };
}

/**
 * Measure one directory's scripts (`files`: name to bytes). Returns one result per module worker
 * and per root, each with its gzipped and minified size and its budget, and notes for the reader.
 */
/**
 * The chunks whose static imports reach a client chunk but which no measured set holds: `direct`
 * import a client chunk themselves, `above` reach one only through another chunk.
 */
export function eagerImporters(files, clients, roots) {
  const text = (name) => files.get(name).toString("utf8");
  const covered = new Set();
  for (const root of roots) for (const name of staticClosure([root], files)) covered.add(name);
  // The client's own lazy chunks (its in-thread fallback) import its shared code back; they are
  // the client's, loaded only without workers, never a page's eager import.
  const clientLazy = new Set(clients.flatMap((client) => dynamicImports(text(client), files)));
  const direct = [];
  const above = [];
  for (const name of [...files.keys()].sort()) {
    if (covered.has(name) || clients.includes(name) || clientLazy.has(name)) continue;
    if (!clients.some((client) => staticClosure([name], files).has(client))) continue;
    const imports = staticImports(text(name), files);
    (imports.some((file) => clients.includes(file)) ? direct : above).push(name);
  }
  return { direct, above };
}

export function measureChunks(label, files) {
  const text = (name) => files.get(name).toString("utf8");
  const results = [];
  const notes = [];
  const { clients, roots, fromDynamicImports } = measurementRoots(files);
  if (clients.length === 0) return { results, notes, clients, roots };
  if (!fromDynamicImports) {
    notes.push(
      `${label}: no dynamically imported chunk reaches the client; measuring from the chunk(s) holding it (${clients.join(", ")}).`,
    );
  }
  const workers = new Set();
  const lazy = new Set();
  for (const root of roots) {
    const set = staticClosure([root], files);
    if (![...set].some((name) => text(name).includes(CLIENT_MARKER))) {
      throw new Error(`${label}: the set measured from ${root} does not hold the client`);
    }
    for (const name of set) {
      for (const m of text(name).matchAll(/new Worker\(\s*new URL\(\s*["']([^"']+\.js)["']/g)) {
        workers.add(m[1].replace(/^.*\//, ""));
      }
      for (const file of dynamicImports(text(name), files)) if (!set.has(file)) lazy.add(file);
    }
    let size = 0;
    let raw = 0;
    for (const name of set) {
      size += gzipped(files.get(name));
      raw += files.get(name).length;
    }
    results.push({
      label: `${label}: main thread from ${root} (${[...set].sort().join(" + ")})`,
      root,
      size,
      raw,
      budget: BUDGET.mainThread,
    });
  }
  const eager = eagerImporters(files, clients, roots);
  for (const name of eager.direct) {
    const set = staticClosure([name], files);
    let size = 0;
    let raw = 0;
    for (const member of set) {
      size += gzipped(files.get(member));
      raw += files.get(member).length;
    }
    results.push({
      label: `${label}: main thread from ${name}, which imports the client statically (${[...set].sort().join(" + ")})`,
      root: name,
      eager: true,
      size,
      raw,
      budget: BUDGET.mainThread,
    });
  }
  for (const name of eager.above) {
    notes.push(
      `${label}: ${name} reaches the client through a static import and is not measured itself (its own code is the page's); the chunk importing the client is.`,
    );
  }
  if (workers.size === 0) throw new Error(`${label}: no module worker is named by ${roots}`);
  for (const name of workers) {
    if (!files.has(name)) throw new Error(`${label}: the worker ${name} was not emitted`);
    results.push({
      label: `${label}: worker ${name}`,
      size: gzipped(files.get(name)),
      raw: files.get(name).length,
      budget: BUDGET.worker,
    });
  }
  for (const name of lazy) {
    if (roots.includes(name)) continue;
    notes.push(
      `${label}: ${name} (${kb(gzipped(files.get(name)))} gzipped) is imported only dynamically by a measured set, and is not counted.`,
    );
  }
  return { results, notes, clients, roots, eager };
}
