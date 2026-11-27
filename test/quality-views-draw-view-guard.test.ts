/**
 * The panel and the admin drill-down draw a view only through the shared steps
 * (`src/lib/quality-views/draw-view.ts`, nemarOrg/website#600): each imports `drawView` from it, and
 * neither imports a drawing step of its own (the model's build, the view's digest, the mount, the
 * refusal or the downloads), so neither can grow a second copy that drifts from the other. That
 * both draw a view the same in a browser is `e2e/quality-draw-parity.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const CALLERS = ["src/lib/quality-views/panel.ts", "src/lib/quality-views/admin-drill.ts"];
const STEPS = ["buildModel", "viewDigest", "mountView", "renderRefusal", "downloadsOf"];

/** A source without its comments (a quote in a comment would otherwise end an import clause). A
 *  line comment starts at a line's start or after white space, so `https://` in a string stays. */
const uncommented = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/.*$/gm, "$1");

/** Each import of a file: its specifier and the names it brings in, static or dynamic; a namespace
 *  import (`* as m`) and a dynamic import bring in "*", the whole module. */
function importsOf(text: string): { from: string; names: string[] }[] {
  const source = uncommented(text);
  const out: { from: string; names: string[] }[] = [];
  for (const m of source.matchAll(/import\s+(type\s+)?([^"';]*?)\s+from\s+["']([^"']+)["']/g)) {
    const names = (m[2].match(/[A-Za-z_$][\w$]*/g) ?? []).filter((n) => n !== "type");
    if (/\*\s*as\s/.test(m[2])) names.push("*");
    out.push({ from: m[3], names });
  }
  for (const m of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    out.push({ from: m[1], names: ["*"] });
  }
  return out;
}

describe("the callers draw only through draw-view.ts", () => {
  it.each(CALLERS)("%s imports drawView from ./draw-view", (file) => {
    const imports = importsOf(fs.readFileSync(repoPath(file), "utf8"));
    expect(imports.some((i) => i.from === "./draw-view" && i.names.includes("drawView"))).toBe(
      true,
    );
  });

  it.each(CALLERS)("%s imports none of the drawing steps itself", (file) => {
    const source = fs.readFileSync(repoPath(file), "utf8");
    for (const { from, names } of importsOf(source)) {
      for (const step of STEPS) expect(names, `${file}: ${step} from ${from}`).not.toContain(step);
    }
    // Nor reaches them through their whole modules (a namespace or a dynamic import).
    for (const { from, names } of importsOf(source)) {
      if (!names.includes("*")) continue;
      expect(["./model", "./verify", "./render/index", "./tree"], file).not.toContain(from);
    }
  });

  it("reads namespace imports, and imports whose braces hold a comment with a quote", () => {
    const source = [
      'import * as m from "./model";',
      "import type * as t from './verify';",
      "import {",
      "  // the panel's own step",
      "  mountView,",
      "  /* isn't it */ renderRefusal,",
      '} from "./render/index";',
      'const url = "https://data.example.invalid/x"; // a URL in a string is not a comment',
      'void import("./tree");',
    ].join("\n");
    expect(importsOf(source)).toEqual([
      { from: "./model", names: ["as", "m", "*"] },
      { from: "./verify", names: ["as", "t", "*"] },
      { from: "./render/index", names: ["mountView", "renderRefusal"] },
      { from: "./tree", names: ["*"] },
    ]);
  });

  it("finds the steps where they are imported, so the guard reads imports at all", () => {
    const imports = importsOf(
      fs.readFileSync(repoPath("src/lib/quality-views/draw-view.ts"), "utf8"),
    );
    const names = imports.flatMap((i) => i.names);
    for (const step of STEPS) expect(names, step).toContain(step);
  });
});
