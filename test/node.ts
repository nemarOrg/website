/**
 * Node's file system and process, for the tests that must read a file or the environment.
 *
 * Reached through a dynamic import with a non-literal specifier, as `account-copy-drift.test.ts`
 * does it: `astro check` type-checks every file in the repo and this project has no `@types/node`,
 * so a static `import fs from "node:fs"` would fail the typecheck in CI while passing under
 * Vitest. The specifier makes the module `any`; the interfaces below say what is used of it.
 *
 * Not a `.test.ts` file, so Vitest does not collect it and Biome's `noExportsInTest` does not
 * object to its exports.
 */

/** What `readFileSync` returns: bytes over a plain `ArrayBuffer`, which is what a `File` accepts. */
export type Bytes = Uint8Array<ArrayBuffer>;

export interface NodeFs {
  existsSync(path: string): boolean;
  readFileSync(path: string): Bytes;
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string): string[];
  statSync(path: string): { isDirectory(): boolean };
}

export interface NodeProcess {
  cwd(): string;
  env: Record<string, string | undefined>;
}

export async function nodeFs(): Promise<NodeFs> {
  const specifier = "node:fs";
  return await import(/* @vite-ignore */ specifier);
}

export async function nodeProcess(): Promise<NodeProcess> {
  const specifier = "node:process";
  return await import(/* @vite-ignore */ specifier);
}

/** A path in this repository, from a path relative to the repository root. */
export function repoPath(relative: string): string {
  return decodeURIComponent(new URL(`../${relative}`, import.meta.url).pathname);
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
