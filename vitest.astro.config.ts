/**
 * The Vitest project for tests that render `.astro` components through Astro's container
 * (`experimental_AstroContainer`), the `*.astro.test.ts` files (vitest.workspace.ts).
 *
 * Astro's own Vite config cannot load under this Vitest (Astro 6 runs on Vite 7, Vitest 2 on
 * Vite 5), so this project compiles components itself with Astro's compiler, as Astro's Vite plugin
 * does: the compiler's output, its TypeScript stripped by esbuild. A component's styles and client
 * scripts are not part of what the server renders, so their virtual modules load empty, and the
 * compiler's `$$metadata` export (which Astro 6's runtime no longer reads) is an empty object.
 */

import { transform } from "@astrojs/compiler";
import { transformWithEsbuild } from "vite";
import { defineConfig } from "vitest/config";

const VIRTUAL = /\?astro&type=(style|script)/;

export default defineConfig({
  plugins: [
    {
      name: "astro-components",
      enforce: "pre",
      resolveId(id) {
        return VIRTUAL.test(id) ? `\0astro-virtual:${id}` : null;
      },
      load(id) {
        return id.startsWith("\0astro-virtual:") ? "export {};" : null;
      },
      async transform(source, id) {
        if (!id.endsWith(".astro")) return null;
        const result = await transform(source, {
          filename: id,
          internalURL: "astro/compiler-runtime",
          resultScopedSlot: true,
        });
        const code = `${result.code.replace(/,\s*createMetadata as \$\$createMetadata/, "")}
function $$createMetadata() {
  return {};
}`;
        return transformWithEsbuild(code, id, { loader: "ts" });
      },
    },
  ],
  test: { name: "astro", include: ["test/**/*.astro.test.ts"] },
});
