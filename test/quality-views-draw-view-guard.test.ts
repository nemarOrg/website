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

/** Each import of a file: its specifier and the names it brings in, static or dynamic. */
function importsOf(source: string): { from: string; names: string[] }[] {
  const out: { from: string; names: string[] }[] = [];
  for (const m of source.matchAll(/import\s+(type\s+)?([^"';]*?)\s+from\s+["']([^"']+)["']/g)) {
    const names = (m[2].match(/[A-Za-z_$][\w$]*/g) ?? []).filter((n) => n !== "type");
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
    // Nor reaches them by a dynamic import of their modules.
    for (const { from, names } of importsOf(source)) {
      if (!names.includes("*")) continue;
      expect(["./model", "./verify", "./render/index", "./tree"], file).not.toContain(from);
    }
  });

  it("finds the steps where they are imported, so the guard reads imports at all", () => {
    const imports = importsOf(
      fs.readFileSync(repoPath("src/lib/quality-views/draw-view.ts"), "utf8"),
    );
    const names = imports.flatMap((i) => i.names);
    for (const step of STEPS) expect(names, step).toContain(step);
  });
});
