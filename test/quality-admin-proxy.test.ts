/**
 * The same-origin proxy of the admin quality mount (website phase W9, #588; nemar-cli ADR 0137
 * decision 7, epic #2324 phase B3b): each of nemar-cli's proxy obligations, run on real `Request`
 * objects against a REAL HTTP server on this machine that stands where the API is, records what it
 * was asked and answers as the backend would (status, words, headers), including what the backend
 * must never send. Nothing in the proxy is replaced: the gate is the site's `adminGate`, and the
 * forward is the real `fetch`.
 *
 * The traversal and encoding cases are nemar-cli #2390's (the reviewer's dot-segment repro and the
 * decoded-rule cases of `test/quality-route-contract.unit.test.ts`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AuthSession } from "../src/lib/auth";
import {
  RELAYED_HEADERS,
  proxyAdminQuality,
  sessionCookieOf,
  splitSitePath,
} from "../src/lib/quality-views/admin-proxy";
import { qualityAdminForwardPath } from "../src/lib/quality-views/admin-route-contract";
import { QUALITY_FILE_MAX_BYTES } from "../src/lib/quality-views/route-contract";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}
interface NodeReq {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}
interface NodeRes {
  statusCode: number;
  setHeader(name: string, value: string | string[]): void;
  write(chunk: Uint8Array | string): boolean;
  end(body?: Uint8Array | string): void;
}
type Handler = (req: NodeReq, res: NodeRes) => void;

let handler: Handler = (_q, res) => {
  res.statusCode = 500;
  res.end();
};
const seen: Seen[] = [];
let origin = "";
let server: { close(cb: () => void): void; closeAllConnections?(): void };

beforeAll(async () => {
  const specifier = "node:http";
  const http = await import(/* @vite-ignore */ specifier);
  server = http.createServer((req: NodeReq, res: NodeRes) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise<void>((resolve) =>
    (server as unknown as { listen(p: number, h: string, cb: () => void): void }).listen(
      0,
      "127.0.0.1",
      resolve,
    ),
  );
  origin = `http://127.0.0.1:${(server as unknown as { address(): { port: number } }).address().port}`;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(resolve));
});
beforeEach(() => {
  seen.length = 0;
  handler = (_q, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  };
});

const SITE = "https://app.example.invalid";
const REC = "sub-01/eeg/sub-01_task-rest_eeg.edf";
const SHA = "b".repeat(64);
const COOKIE = "__Host-nemar_session=caller-own-session";

const session = (role: "admin" | "user"): AuthSession =>
  ({ user: { id: "u1", email: "a@nemar.test", role, status: "active" } }) as unknown as AuthSession;

function call(
  path: string,
  init: RequestInit & {
    as?: "admin" | "user" | null;
    cookie?: string | null;
    maxBytes?: number;
  } = {},
) {
  const as = init.as === undefined ? "admin" : init.as;
  const headers = new Headers(init.headers);
  const cookie = init.cookie === undefined ? COOKIE : init.cookie;
  if (!headers.has("cookie") && cookie !== null) headers.set("cookie", cookie);
  return proxyAdminQuality(new Request(`${SITE}${path}`, { ...init, headers }), {
    session: as === null ? null : session(as),
    apiBase: origin,
    fetch: (url, i) => fetch(url, i),
    maxBytes: init.maxBytes,
  });
}

const RECORD_PATH = `/admin/pipelines/runs/7/quality/record/${REC}`;
const FILE_PATH = `/admin/pipelines/runs/7/quality/file/${SHA}/${REC}`;

async function expectRefused(res: Response, status: number, word: string) {
  expect(res.status).toBe(status);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(await res.json()).toEqual({ error: word });
}

describe("who: administrators only, and nothing reaches the API for anyone else", () => {
  it("refuses a signed-out caller and a non-administrator with the same 404", async () => {
    await expectRefused(await call(RECORD_PATH, { as: null }), 404, "not_found");
    await expectRefused(await call(RECORD_PATH, { as: "user" }), 404, "not_found");
    await expectRefused(await call(RECORD_PATH, { cookie: null }), 404, "not_found");
    expect(seen).toEqual([]);
  });

  it("forwards the caller's own session cookie and nothing else that names anyone", async () => {
    const res = await call(RECORD_PATH, {
      headers: {
        cookie: `${COOKIE}; other=1; nemar_session=legacy`,
        authorization: "Bearer someone-elses-key",
        "x-test-bypass": "1",
        "x-forwarded-for": "203.0.113.9",
      },
    });
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    const h = seen[0].headers;
    expect(h.cookie).toBe(COOKIE);
    for (const name of ["authorization", "x-test-bypass", "x-api-key", "x-forwarded-for"]) {
      expect(h[name], name).toBeUndefined();
    }
  });
});

describe("which credential is forwarded (sessionCookieOf)", () => {
  it("forwards only __Host-nemar_session from a header with other cookies and a legacy one", async () => {
    const header = `a=1; nemar_session=legacy; ${COOKIE}; b=2`;
    expect(sessionCookieOf(header)).toBe(COOKIE);
    const res = await call(RECORD_PATH, { headers: { cookie: header } });
    expect(res.status).toBe(200);
    expect(seen.map((s) => s.headers.cookie)).toEqual([COOKIE]);
  });

  it("forwards only the legacy cookie when it is the one session cookie", async () => {
    const header = "a=1; nemar_session=legacy-own; b=2";
    expect(sessionCookieOf(header)).toBe("nemar_session=legacy-own");
    await call(RECORD_PATH, { headers: { cookie: header } });
    expect(seen.map((s) => s.headers.cookie)).toEqual(["nemar_session=legacy-own"]);
  });

  it("answers 404 and forwards nothing for an empty __Host- value, even beside a legacy one", async () => {
    for (const header of ["__Host-nemar_session=", "__Host-nemar_session=; nemar_session=legacy"]) {
      expect(sessionCookieOf(header), header).toBeNull();
      await expectRefused(
        await call(RECORD_PATH, { headers: { cookie: header } }),
        404,
        "not_found",
      );
    }
    expect(seen).toEqual([]);
  });

  it("answers 404 for a duplicated __Host-nemar_session", async () => {
    const header = `${COOKIE}; __Host-nemar_session=someone-else`;
    expect(sessionCookieOf(header)).toBeNull();
    await expectRefused(await call(RECORD_PATH, { headers: { cookie: header } }), 404, "not_found");
    expect(seen).toEqual([]);
  });

  it("forwards nothing with no Cookie header", () => {
    expect(sessionCookieOf(null)).toBeNull();
    expect(sessionCookieOf("")).toBeNull();
    expect(sessionCookieOf("a=1; b=2")).toBeNull();
  });
});

describe("the request: GET only, no query, the raw path, the grammar", () => {
  it.each(["POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"])("refuses %s", async (method) => {
    const res = await call(RECORD_PATH, { method });
    expect(res.status).toBe(405);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("allow")).toBe("GET");
    expect(seen).toEqual([]);
  });

  it.each([`${RECORD_PATH}?x=1`, `${RECORD_PATH}?`, `${FILE_PATH}?after=a`])(
    "refuses any ? (%s)",
    async (path) => {
      await expectRefused(await call(path), 400, "recording_path_invalid");
      expect(seen).toEqual([]);
    },
  );

  const OUTSIDE = [
    // The reviewer's dot-segment repro (nemar-cli #2390).
    "record/%2e%2e/%2e%2e/%2e%2e/users/x_eeg.edf",
    "record/.%2e/.%2e/.%2e/users/x_eeg.edf",
    "record/%2E./%2E./users/x_eeg.edf",
    "record/../../../users/x_eeg.edf",
    `file/${SHA}/%2e%2e/%2e%2e/%2e%2e/%2e%2e/users`,
    "record/sub-01/./eeg/sub-01_task-rest_eeg.edf",
    // Encoded separators, controls, bad escapes and the decoded rule.
    `record/%2E%2E/${REC}`,
    "record/sub-01%2Feeg%2Fsub-01_task-rest_eeg.edf",
    "record/sub-01%5Ceeg/sub-01_task-rest_eeg.edf",
    // An encoded dot is refused even where the decoded segment would pass (a hidden name).
    "record/sub-01/%2Eeeg/sub-01_task-rest_eeg.edf",
    "record/sub-01/eeg/sub-01_task-rest_eeg.edf%00",
    "record/sub-01/eeg/sub-01_task-rest%0A_eeg.edf",
    "record/sub-01/eeg/sub-01_task-rest%7F_eeg.edf",
    "record/sub-01/eeg/sub-01_task-rest%ZZ_eeg.edf",
    "record/sub-01/eeg/sub-01_task-rest%E0%A4_eeg.edf",
    "record/sub-01/eeg/sub-01_task-rest%C2%85_eeg.edf",
    "record/sub-01/eeg/sub-01_task-rest_eeg.edf%3F",
    "record/sub-01/eeg/sub-01_task-rest_eeg.edf%23x",
    "record/sub-01/eeg/sub-01_task-%E2%80%AErest_eeg.edf",
    "record/sub-01%252Feeg/sub-01_task-rest_eeg.edf",
    "record/sub-01/eeg/sub-01_task-rest_channels.tsv",
    "record/%20sub-01/eeg/sub-01_task-rest_eeg.edf",
    "record/http:/eeg/sub-01_task-rest_eeg.edf",
    `record//${REC}`,
    `record/${REC}/`,
    "record",
    "record/",
    `file/${SHA.toUpperCase()}/${REC}`,
    `file/${SHA.slice(1)}/${REC}`,
    `file/${SHA}`,
    `views/${REC}`,
    `record/${"a/".repeat(600)}x_eeg.edf`,
  ];

  it.each(OUTSIDE)("the raw rest %s is outside the grammar", (rest) => {
    expect(qualityAdminForwardPath("7", rest)).toBeNull();
  });

  it.each(OUTSIDE)(
    "refuses %s, or forwards only what the URL parser resolved inside the mount",
    async (rest) => {
      const path = `/admin/pipelines/runs/7/quality/${rest}`;
      const res = await call(path);
      expect(res.headers.get("cache-control")).toBe("no-store");
      // A request URL is parsed before any code sees it, so `.`, `..` and their encodings
      // (`%2e`) are already resolved in `url.pathname`. What the parser resolved out of the mount
      // is refused; what it resolved inside the mount is checked again and forwarded as resolved.
      const resolved = splitSitePath(new URL(`${SITE}${path}`).pathname);
      const inside = resolved ? qualityAdminForwardPath(resolved.stamp, resolved.rest) : null;
      if (inside === null) {
        expect([400, 404]).toContain(res.status);
        expect(seen).toEqual([]);
      } else {
        expect(res.status).toBe(200);
        expect(seen.map((s) => s.url)).toEqual([inside]);
      }
    },
  );

  it("forwards a ./ segment only as the parser resolved it, inside the mount", async () => {
    await call("/admin/pipelines/runs/7/quality/record/sub-01/./eeg/sub-01_task-rest_eeg.edf");
    expect(seen.map((s) => s.url)).toEqual([
      "/admin/compute/pipeline/runs/7/quality/record/sub-01/eeg/sub-01_task-rest_eeg.edf",
    ]);
  });

  it.each(["0", "01", "-1", "1e3", "99999999999999999", "9999999999999999", "%35", "abc"])(
    "refuses the stamp %s as no such run",
    async (stamp) => {
      await expectRefused(
        await call(`/admin/pipelines/runs/${stamp}/quality/record/${REC}`),
        404,
        "stamp_not_found",
      );
      expect(seen).toEqual([]);
    },
  );

  it("takes rest from the raw pathname: an encoded space is forwarded as it came", async () => {
    const encoded = "record/sub-01/eeg/sub-01_task-a%20b_eeg.edf";
    const res = await call(`/admin/pipelines/runs/12/quality/${encoded}`);
    expect(res.status).toBe(200);
    expect(seen.map((s) => [s.method, s.url])).toEqual([
      ["GET", `/admin/compute/pipeline/runs/12/quality/${encoded}`],
    ]);
  });

  it("forwards a record and a file path to the admin mount, exactly", async () => {
    await call(RECORD_PATH);
    await call(FILE_PATH);
    expect(seen.map((s) => s.url)).toEqual([
      `/admin/compute/pipeline/runs/7/quality/record/${REC}`,
      `/admin/compute/pipeline/runs/7/quality/file/${SHA}/${REC}`,
    ]);
  });

  it("splits only its own paths", () => {
    expect(splitSitePath(`/admin/pipelines/runs/7/quality/record/${REC}`)).toEqual({
      stamp: "7",
      rest: `record/${REC}`,
    });
    expect(splitSitePath("/admin/pipelines/runs/7/quality")).toBeNull();
    expect(splitSitePath(`/admin/pipelines/runs/7/other/record/${REC}`)).toBeNull();
    expect(splitSitePath(`/admin/pipelinesX/runs/7/quality/record/${REC}`)).toBeNull();
  });
});

describe("every answer: no-store, the three headers, the cap", () => {
  it.each([
    [200, '{"format":"nemar.quality-record.v1"}'],
    [401, '{"error":"unauthorized"}'],
    [403, '{"error":"forbidden"}'],
    [404, '{"error":"stamp_not_found"}'],
    [409, '{"error":"derivative_copying"}'],
    [410, '{"error":"views_expired"}'],
    [429, '{"error":"rate_limited"}'],
    [503, '{"error":"quality_unavailable"}'],
  ])("relays a %i as no-store with only the three headers", async (status, body) => {
    handler = (_q, res) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.setHeader("content-disposition", "inline; filename*=UTF-8''x.tsv");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("cache-control", "public, max-age=300");
      res.setHeader("set-cookie", ["__Host-nemar_session=stolen; Path=/", "b=2"]);
      res.setHeader("etag", '"abc"');
      res.setHeader("cache-tag", "nemar-dq-nm000001");
      res.setHeader("keep-alive", "timeout=5");
      res.setHeader("x-ratelimit-remaining", "0");
      res.setHeader("access-control-allow-origin", "*");
      res.end(body);
    };
    const res = await call(FILE_PATH);
    expect(res.status).toBe(status);
    expect(await res.text()).toBe(body);
    const names = [...res.headers.keys()].sort();
    expect(names).toEqual([...RELAYED_HEADERS, "cache-control"].sort());
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("content-disposition")).toBe("inline; filename*=UTF-8''x.tsv");
  });

  it.each([204, 205])("relays a %i with no body, no-store", async (status) => {
    handler = (_q, res) => {
      res.statusCode = status;
      res.end();
    };
    const res = await call(FILE_PATH);
    expect(res.status).toBe(status);
    expect(res.body).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("always says nosniff, whatever the API said", async () => {
    handler = (_q, res) => {
      res.statusCode = 200;
      res.setHeader("x-content-type-options", "sniff-away");
      res.end("x");
    };
    expect((await call(FILE_PATH)).headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("passes a body of exactly 4 MiB, streamed without a length", async () => {
    handler = (_q, res) => {
      res.statusCode = 200;
      const chunk = new Uint8Array(1 << 20);
      for (let i = 0; i < 4; i++) res.write(chunk);
      res.end();
    };
    const res = await call(FILE_PATH);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(QUALITY_FILE_MAX_BYTES);
  });

  it("refuses a body one byte over 4 MiB by counting it, whatever Content-Length says", async () => {
    handler = (_q, res) => {
      res.statusCode = 200;
      const chunk = new Uint8Array(1 << 20);
      for (let i = 0; i < 4; i++) res.write(chunk);
      res.end(new Uint8Array(1));
    };
    await expectRefused(await call(FILE_PATH), 502, "answer_too_large");
  });

  it("refuses an over-cap refusal body too", async () => {
    handler = (_q, res) => {
      res.statusCode = 403;
      res.end("x".repeat(65));
    };
    await expectRefused(await call(FILE_PATH, { maxBytes: 64 }), 502, "answer_too_large");
  });

  it("never follows a redirect", async () => {
    handler = (req, res) => {
      if (req.url.startsWith("/elsewhere")) {
        res.statusCode = 200;
        res.end("followed");
        return;
      }
      res.statusCode = 302;
      res.setHeader("location", "/elsewhere");
      res.end();
    };
    await expectRefused(await call(FILE_PATH), 502, "upstream_redirect");
    expect(seen.map((s) => s.url)).toEqual([
      `/admin/compute/pipeline/runs/7/quality/file/${SHA}/${REC}`,
    ]);
  });

  it("says the API could not be reached, no-store", async () => {
    const res = await proxyAdminQuality(
      new Request(`${SITE}${RECORD_PATH}`, { headers: { cookie: COOKIE } }),
      {
        session: session("admin"),
        apiBase: "http://127.0.0.1:9",
        fetch: (url, i) => fetch(url, i),
      },
    );
    await expectRefused(res, 502, "upstream_unreachable");
  });
});
