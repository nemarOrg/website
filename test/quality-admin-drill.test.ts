/**
 * The admin drill-down's client (`src/lib/quality-views/admin-drill.ts`, website phase W9, #588)
 * end to end below the page: the browser's request goes through the REAL proxy
 * (`proxyAdminQuality`) to a REAL HTTP server standing where the API is, which answers with the
 * record and files captured from nemar-cli's quality route (test/fixtures/quality-views/route/; the
 * admin mount serves the same bytes, without an `ETag`), or with the admin mount's refusals. The
 * page's drawing in a browser is e2e/admin-quality.spec.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthSession } from "../src/lib/auth";
import { ADMIN_VIEW_SENTENCES } from "../src/lib/pipeline-quality-labels";
import { adminFiles, adminSentence, fetchAdminRecord } from "../src/lib/quality-views/admin-drill";
import { proxyAdminQuality } from "../src/lib/quality-views/admin-proxy";
import { PANEL_SENTENCES } from "../src/lib/quality-views/panel-words";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const ROUTE = "test/fixtures/quality-views/route";
const json = (p: string) => JSON.parse(fs.readFileSync(repoPath(p), "utf8"));
const captured = json(`${ROUTE}/record.json`);
const provenance = json(`${ROUTE}/provenance.json`);
const files = json(`${ROUTE}/files.json`) as Record<string, unknown>;
const RECORDING = provenance.recording as string;
const ASK = {
  stampId: 8,
  datasetId: provenance.dataset_id,
  recipe: provenance.recipe,
  recording: RECORDING,
};

interface NodeReq {
  url: string;
  headers: Record<string, string | undefined>;
}
interface NodeRes {
  statusCode: number;
  setHeader(n: string, v: string): void;
  end(b?: string | Uint8Array): void;
}
let refusal: { status: number; word: string } | null = null;
let origin = "";
let server: { close(cb: () => void): void; closeAllConnections?(): void };
const seen: string[] = [];

beforeAll(async () => {
  const specifier = "node:http";
  const http = await import(/* @vite-ignore */ specifier);
  server = http.createServer((req: NodeReq, res: NodeRes) => {
    seen.push(req.url);
    res.setHeader("cache-control", "no-store");
    if (refusal) {
      res.statusCode = refusal.status;
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ error: refusal.word }));
    }
    const prefix = "/admin/compute/pipeline/runs/8/quality/";
    const rest = req.url.slice(prefix.length);
    if (rest.startsWith("record/")) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      return res.end(captured.body);
    }
    const sha = rest.split("/")[1];
    if (rest.startsWith("file/") && Object.hasOwn(files, sha)) {
      res.statusCode = 200;
      res.setHeader("content-type", "text/tab-separated-values; charset=utf-8");
      return res.end(new Uint8Array(fs.readFileSync(repoPath(`${ROUTE}/files/${sha}`))));
    }
    res.statusCode = 404;
    res.end('{"error":"view_not_declared"}');
  });
  await new Promise<void>((r) =>
    (server as unknown as { listen(p: number, h: string, cb: () => void): void }).listen(
      0,
      "127.0.0.1",
      r,
    ),
  );
  origin = `http://127.0.0.1:${(server as unknown as { address(): { port: number } }).address().port}`;
});
afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((r) => server.close(r));
});

/** The browser's fetch, answered by the real proxy on this site's origin. */
const browserFetch = (async (input: RequestInfo | URL) =>
  proxyAdminQuality(new Request(`https://app.example.invalid${String(input)}`), {
    session: {
      user: { id: "1", email: "o@nemar.test", role: "admin", status: "active" },
    } as unknown as AuthSession,
    sessionCookie: "__Host-nemar_session=owner",
    apiBase: origin,
    fetch: (url, init) => fetch(url, init),
  })) as typeof fetch;

describe("a record and its files through the proxy", () => {
  it("reads the run's record, checked whole, with no ETag", async () => {
    refusal = null;
    const outcome = await fetchAdminRecord(ASK, { fetch: browserFetch });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") return;
    expect(outcome.record.recording).toBe(RECORDING);
    expect(Object.keys(outcome.record.digests).length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(
      `/admin/compute/pipeline/runs/8/quality/record/${RECORDING.split("/").map(encodeURIComponent).join("/")}`,
    );
    // A declared file comes back as its declared bytes.
    const view = (
      outcome.record.views as { data?: { sha256: string; size: number; location: string }[] }[]
    ).find((v) => v.data?.length);
    const file = view!.data![0];
    const bytes = await adminFiles(8, outcome.record, { fetch: browserFetch })(file);
    expect(bytes?.byteLength).toBe(file.size);
  });

  it("refuses a record that is another recording's", async () => {
    refusal = null;
    const outcome = await fetchAdminRecord(
      { ...ASK, recording: "sub-X/eeg/sub-X_task-COVID_eeg.edf" },
      { fetch: browserFetch },
    );
    expect(outcome).toEqual({ kind: "failed", word: "record_elsewhere" });
  });
});

describe("the expired, missing and failed states say so", () => {
  it.each([
    [410, "views_expired", PANEL_SENTENCES.views_expired],
    [404, "derivative_not_keyed", ADMIN_VIEW_SENTENCES.derivative_not_keyed],
    [409, "derivative_failed", ADMIN_VIEW_SENTENCES.derivative_failed],
    [409, "derivative_copying", ADMIN_VIEW_SENTENCES.derivative_copying],
    [503, "quality_unavailable", ADMIN_VIEW_SENTENCES.quality_unavailable],
    [404, "stamp_not_found", ADMIN_VIEW_SENTENCES.stamp_not_found],
  ])("a %i %s", async (status, word, sentence) => {
    refusal = { status, word };
    const outcome = await fetchAdminRecord(ASK, { fetch: browserFetch });
    expect(outcome).toEqual({ kind: "failed", word });
    expect(await adminSentence(word)).toBe(sentence);
  });

  it("an answer that is no word at all is said by its status class, never raw", async () => {
    refusal = { status: 500, word: "<script>" };
    const outcome = await fetchAdminRecord(ASK, { fetch: browserFetch });
    expect(outcome).toEqual({ kind: "failed", word: "http_500" });
    expect(await adminSentence("http_500")).toBe(PANEL_SENTENCES.http_5xx);
  });
});
