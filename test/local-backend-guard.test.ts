/**
 * The safety guards of `scripts/local-backend.mjs` (website ADR 0030).
 *
 * The script injects the rate limiter's bypass header and prints a fixed owner
 * key, so it must bind loopback only and refuse to run anywhere that looks
 * like production. The refusals happen before it imports anything from
 * nemar-cli, so they run without a checkout: each case runs the real script
 * with a hostile environment and expects it to exit non-zero with its reason.
 * The bind itself is pinned at the source, because starting a server needs the
 * backend.
 */

import { describe, expect, it } from "vitest";
import SCRIPT from "../scripts/local-backend.mjs?raw";

interface Ran {
  status: number | null;
  stderr: string;
}

async function runScript(env: Record<string, string>): Promise<Ran> {
  const specifier = "node:child_process";
  const cp = (await import(/* @vite-ignore */ specifier)) as {
    spawnSync(
      cmd: string,
      args: string[],
      options: { env: Record<string, string | undefined>; encoding: string; timeout: number },
    ): { status: number | null; stderr: string };
  };
  const procSpecifier = "node:process";
  const proc = (await import(/* @vite-ignore */ procSpecifier)) as {
    env: Record<string, string | undefined>;
    cwd(): string;
  };
  const clean = { ...proc.env };
  for (const name of ["ENVIRONMENT", "BIND_HOST", "HOST", "BUN_HOST", "WEB_ORIGIN"]) {
    delete clean[name];
  }
  const result = cp.spawnSync("bun", [`${proc.cwd()}/scripts/local-backend.mjs`], {
    env: { ...clean, NEMAR_CLI_DIR: "/nonexistent-nemar-cli", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: result.status, stderr: result.stderr };
}

describe("local-backend.mjs guards", () => {
  it.each([
    ["ENVIRONMENT", "production"],
    ["ENVIRONMENT", "prod"],
    ["ENVIRONMENT", "staging"],
    ["BIND_HOST", "0.0.0.0"],
    ["HOST", "192.168.1.10"],
    ["BUN_HOST", "0.0.0.0"],
    ["WEB_ORIGIN", "https://nemar.org"],
  ])("refuses %s=%s before importing anything", async (name, value) => {
    const ran = await runScript({ [name]: value });
    expect(ran.status).toBe(1);
    expect(ran.stderr).toContain("Refusing to start");
  });

  it("gets past the guards for a local environment (and then fails on the missing checkout)", async () => {
    const ran = await runScript({ ENVIRONMENT: "test", BIND_HOST: "127.0.0.1" });
    expect(ran.stderr).not.toContain("Refusing to start");
  });

  it("binds 127.0.0.1 and checks the socket it got", () => {
    expect(SCRIPT).toMatch(/Bun\.serve\(\{\s*(\/\/[^\n]*\n\s*)*hostname: "127\.0\.0\.1"/);
    expect(SCRIPT).toContain('server.hostname !== "127.0.0.1"');
  });
});
