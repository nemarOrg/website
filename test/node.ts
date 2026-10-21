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

/** A thread from `node:worker_threads`: separate, running on its own, ended by `terminate()`. */
export interface NodeThread {
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  postMessage(value: unknown): void;
  terminate(): Promise<number>;
}

export interface NodeWorkerThreads {
  Worker: new (code: string, options: { eval: true }) => NodeThread;
}

export async function nodeWorkerThreads(): Promise<NodeWorkerThreads> {
  const specifier = "node:worker_threads";
  return await import(/* @vite-ignore */ specifier);
}

interface NodeServer {
  listen(port: number, host: string, onListening: () => void): void;
  close(onClosed: () => void): void;
  address(): { port: number };
}

interface NodeHttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

interface NodeHttp {
  createServer(onRequest: (request: unknown, response: NodeHttpResponse) => void): NodeServer;
}

interface NodeNet {
  createServer(): NodeServer;
}

async function listening(server: NodeServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

const closed = (server: NodeServer): Promise<void> =>
  new Promise<void>((resolve) => server.close(resolve));

/**
 * A real HTTP server on this machine that answers every request with `status` and `body`. Stops
 * with `close()`. For the tests of a client's answer to a server that has said no, where the
 * answer is a real response from a real server.
 */
export async function serveStatus(
  status: number,
  body: string,
): Promise<{ origin: string; close(): Promise<void> }> {
  const specifier = "node:http";
  const http = (await import(/* @vite-ignore */ specifier)) as NodeHttp;
  const server = http.createServer((_request, response) => {
    response.statusCode = status;
    // The connection ends with the answer, so closing the server waits for nothing.
    response.setHeader("connection", "close");
    response.end(body);
  });
  const port = await listening(server);
  return { origin: `http://127.0.0.1:${port}`, close: () => closed(server) };
}

/**
 * The origin of a port nothing is listening on: one that was free a moment ago. A request to it is
 * refused by the operating system, which is what a request that gets no answer looks like.
 */
export async function closedLocalOrigin(): Promise<string> {
  const specifier = "node:net";
  const net = (await import(/* @vite-ignore */ specifier)) as NodeNet;
  const server = net.createServer();
  const port = await listening(server);
  await closed(server);
  return `http://127.0.0.1:${port}`;
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
