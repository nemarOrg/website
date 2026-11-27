/**
 * Two Vitest projects: the unit tests (vitest.config.ts, plain TypeScript, no Astro pipeline) and
 * the component renders (vitest.astro.config.ts, `*.astro.test.ts`, which compiles `.astro`
 * files). `bun run test` runs both.
 */
export default ["./vitest.config.ts", "./vitest.astro.config.ts"];
