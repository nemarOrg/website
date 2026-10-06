import { configDefaults, defineConfig } from "vitest/config";

/**
 * Minimal on purpose. These are plain TypeScript unit tests over pure helpers
 * in `src/lib` — they do not go through Astro's vite pipeline, so this stays a
 * bare `defineConfig` rather than `getViteConfig` from `astro/config`. Adding
 * the Astro pipeline here would change how these tests resolve for no benefit.
 *
 * It exists for the exclude below and for letting the viewer's stylesheet through
 * (see `css`), so a test can read it.
 */
export default defineConfig({
  test: {
    // Vitest blanks every stylesheet it imports, `?raw` included. The viewer's
    // retry button class is tied to its CSS by a test that reads the file, so
    // that one stylesheet is let through.
    css: { include: [/eeg-viewer\.css/] },
    exclude: [
      ...configDefaults.exclude,
      // Agent subtasks get their own git worktree, created *inside* the repo
      // under `.claude/worktrees/<id>/`. Each is a full checkout, so without
      // this every `src/lib/*.test.ts` matches once per worktree and a local
      // `bun run test` reruns the whole suite N+1 times — several thousand
      // tests instead of several hundred.
      //
      // That is worse than slow. Those checkouts sit on other branches at
      // other commits, so a failure from an unrelated in-flight branch gets
      // reported alongside yours with nothing in the output saying which tree
      // it came from. CI clones fresh and never has them, so the discrepancy
      // only ever shows up locally.
      "**/.claude/worktrees/**",
    ],
  },
});
