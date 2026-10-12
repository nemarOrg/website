/**
 * Scratch proof of concept (NOT in the PR): no module a browser <script> can reach may import
 * api-fetch.ts or request-context.ts (the latter imports node:async_hooks). Reads source through
 * Vite's raw glob, so it needs no Node types and passes the CI typecheck.
 */
import { describe, expect, it } from "vitest";

const astro = import.meta.glob("/src/**/*.astro", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const ts = import.meta.glob("/src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const FORBIDDEN = ["/src/lib/api-fetch.ts", "/src/lib/request-context.ts"];

function importsOf(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(
    /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/g,
  )) {
    if (m[1]) continue;
    const names = m[2].match(/^\{([^}]*)\}$/);
    if (
      names &&
      names[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .every((s) => s.startsWith("type "))
    )
      continue;
    out.push(m[3]);
  }
  for (const m of source.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}
function resolve(from: string, spec: string): string | undefined {
  if (!spec.startsWith(".")) return undefined;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const base = parts.join("/");
  return [base, `${base}.ts`, `${base}/index.ts`, base.replace(/\.js$/, ".ts")].find(
    (c) => c in ts,
  );
}

describe("the browser bundle", () => {
  it("never reaches api-fetch.ts or request-context.ts from a client <script>", () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(astro)) {
      for (const block of source.matchAll(/<script(?![^>]*is:inline)[^>]*>([\s\S]*?)<\/script>/g)) {
        const seen = new Set<string>();
        const stack: { file: string; via: string[] }[] = [];
        for (const spec of importsOf(block[1])) {
          const r = resolve(file, spec);
          if (r) stack.push({ file: r, via: [file] });
        }
        while (stack.length) {
          const { file: cur, via } = stack.pop()!;
          if (seen.has(cur)) continue;
          seen.add(cur);
          if (FORBIDDEN.includes(cur)) {
            offenders.push([...via, cur].join(" -> "));
            continue;
          }
          for (const spec of importsOf(ts[cur] ?? "")) {
            const r = resolve(cur, spec);
            if (r) stack.push({ file: r, via: [...via, cur] });
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
