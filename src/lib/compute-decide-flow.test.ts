/**
 * The decide flow over the REAL client and fixtures captured from the real backend routes
 * (recapture: `NEMAR_CLI_DIR=<nemar-cli checkout of the Epic D branch> bun
 * scripts/capture-compute-admin-fixtures.mjs`). The only thing supplied is the `fetch`, which
 * answers with `Response`s built from the captured bodies.
 */

import { describe, expect, it } from "vitest";
import decisions from "../../test/fixtures/compute/admin-access-decisions.json";
import accessList from "../../test/fixtures/compute/admin-access-list.json";
import { ACCOUNT_COPY } from "./account-copy";
import { decideComputeAccess, getComputeAccount } from "./compute-admin-api";
import { createDecideFlow } from "./compute-decide-flow";

type Captured = { status: number; body: unknown };
const dec = decisions as unknown as Record<string, Captured>;
const json = (c: Captured) =>
  new Response(JSON.stringify(c.body), {
    status: c.status,
    headers: { "Content-Type": "application/json" },
  });

/** A world: decisions answer with `post(n)`, the re-read with `get(n)`; every call is recorded. */
function world(
  post: (n: number) => Response | Promise<Response>,
  get: (n: number) => Response | Promise<Response> = () => json(accessList.one_by_cursor),
) {
  const posts: string[] = [];
  const gets: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (init.method === "POST") {
      posts.push(url);
      return post(posts.length - 1);
    }
    gets.push(url);
    return get(gets.length - 1);
  }) as unknown as typeof fetch;
  const flow = createDecideFlow({
    decide: (id, decision, reason) =>
      decideComputeAccess(id, decision, reason, { fetch: fetchImpl }),
    reread: (id) => getComputeAccount(id, { fetch: fetchImpl }),
  });
  return { flow, posts, gets };
}

describe("a decision that goes through", () => {
  it("draws the row from the response and reads nothing", async () => {
    const w = world(() => json(dec.grant_allocated));
    const out = await w.flow.submit({ id: 5, decision: "grant" });
    expect(out.outcome).toBe("done");
    if (out.outcome !== "done") return;
    expect(out.row.compute_access).toBe("active");
    expect(out.note.text).toBe("Granted. Opened 50 CPU SU and 5 GPU SU.");
    expect(w.posts).toEqual(["/api/v1/admin/compute/access/grant/by-id/5"]);
    expect(w.gets).toEqual([]);
    expect(w.flow.busy).toBe(false);
  });
});

describe("one decision in flight, page-wide", () => {
  it("ignores a second submit while the first is out, and sends exactly one POST", async () => {
    let release: (r: Response) => void = () => {};
    const w = world(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const first = w.flow.submit({ id: 5, decision: "grant" });
    expect(w.flow.busy).toBe(true);
    const second = await w.flow.submit({ id: 5, decision: "grant" });
    const other = await w.flow.submit({ id: 6, decision: "deny" });
    expect(second).toEqual({ outcome: "ignored" });
    expect(other).toEqual({ outcome: "ignored" });
    release(json(dec.grant_allocated));
    expect((await first).outcome).toBe("done");
    expect(w.posts).toHaveLength(1);
    expect(w.flow.busy).toBe(false);
    // Free again afterwards.
    release = () => {};
    const again = w.flow.submit({ id: 7, decision: "deny" });
    expect(w.flow.busy).toBe(true);
    release(json(dec.deny));
    expect((await again).outcome).toBe("done");
    expect(w.posts).toHaveLength(2);
  });

  it("is free again after a failure", async () => {
    const w = world(() => json(dec.refused_self_decision));
    await w.flow.submit({ id: 2, decision: "grant" });
    expect(w.flow.busy).toBe(false);
  });
});

describe("a refusal that changed nothing", () => {
  it("prints the sentence, restores the buttons and reads nothing", async () => {
    for (const key of [
      "refused_self_decision",
      "refused_not_in_good_standing",
      "refused_policy_unreadable",
      "refused_invalid_body_reason",
      "refused_member",
    ]) {
      const w = world(() => json(dec[key]));
      const out = await w.flow.submit({ id: 5, decision: "grant" });
      expect(out.outcome, key).toBe("failed");
      if (out.outcome !== "failed") continue;
      expect(out.note.restore, key).toBe(true);
      expect(out.row, key).toBeNull();
      expect(w.gets, key).toEqual([]);
      expect(w.posts, key).toHaveLength(1);
    }
  });
});

describe("a refusal that says the state moved", () => {
  it("reads the account exactly once and returns what the server says", async () => {
    for (const key of [
      "refused_not_requested_grant",
      "refused_already_active",
      "refused_not_active",
      "refused_stale_state",
    ]) {
      const w = world(() => json(dec[key]));
      const out = await w.flow.submit({ id: 8, decision: "grant" });
      expect(out.outcome, key).toBe("failed");
      if (out.outcome !== "failed") continue;
      expect(out.note.text, key).toContain(ACCOUNT_COPY["compute_admin.result.state_changed"]);
      expect(out.row?.id, key).toBe(8);
      expect(w.gets, key).toEqual(["/api/v1/admin/compute/access?after=7&limit=1"]);
      expect(w.posts, key).toHaveLength(1);
    }
  });

  it("marks the row stale for an account that is not there, without a read", async () => {
    const w = world(() => json(dec.refused_account_not_found));
    const out = await w.flow.submit({ id: 99, decision: "grant" });
    expect(out).toMatchObject({
      outcome: "failed",
      row: null,
      note: { stale: true, reread: false },
    });
    expect(w.gets).toEqual([]);
  });
});

describe("an outcome that cannot be told", () => {
  const lost: Array<[string, (n: number) => Response | Promise<Response>]> = [
    ["a gateway page", () => new Response("<html>bad gateway</html>", { status: 502 })],
    [
      "the proxy's word",
      () => new Response(JSON.stringify({ error: "upstream_unreachable" }), { status: 502 }),
    ],
    [
      "a 500 after a commit",
      () =>
        new Response(
          JSON.stringify({
            error: "The compute access routes failed unexpectedly.",
            code: "internal",
          }),
          { status: 500 },
        ),
    ],
    ["a timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
    ["a dropped connection", () => Promise.reject(new TypeError("Failed to fetch"))],
    ["an unreadable 200", () => new Response("ok", { status: 200 })],
  ];
  for (const [name, post] of lost) {
    it(`${name}: says the result is not confirmed, reads once, and posts once`, async () => {
      const w = world(post);
      const out = await w.flow.submit({ id: 8, decision: "grant" });
      expect(out.outcome).toBe("failed");
      if (out.outcome !== "failed") return;
      expect(out.note.text).toBe(ACCOUNT_COPY["compute_admin.result.unconfirmed"]);
      expect(out.row?.id).toBe(8);
      expect(w.posts).toHaveLength(1);
      expect(w.gets).toHaveLength(1);
    });
  }

  it("tells the administrator to check the email when the re-read shows the decision landed", async () => {
    // The re-read answers the account as the backend served it after a grant.
    const granted = dec.grant_allocated.body as { account: { id: number } };
    const landed = world(
      () => new Response("<html>", { status: 502 }),
      () => json({ status: 200, body: { accounts: [granted.account], next_after: null } }),
    );
    const out = await landed.flow.submit({ id: granted.account.id, decision: "grant" });
    expect(out.outcome).toBe("failed");
    if (out.outcome !== "failed") return;
    expect(out.note.text).toBe(
      `${ACCOUNT_COPY["compute_admin.result.unconfirmed"]} ${ACCOUNT_COPY["compute_admin.result.check_email"]}`,
    );
    expect(out.row?.compute_access).toBe("active");
    // A re-read that shows some other state adds no such line.
    const other = world(
      () => new Response("<html>", { status: 502 }),
      () => json(accessList.one_by_cursor),
    );
    const o = await other.flow.submit({ id: 8, decision: "grant" });
    expect(o.outcome === "failed" && o.note.text).toBe(
      ACCOUNT_COPY["compute_admin.result.unconfirmed"],
    );
  });

  it("says so when the re-read fails too, and still posts once", async () => {
    const w = world(
      () => new Response("<html>", { status: 502 }),
      () => new Response("<html>", { status: 502 }),
    );
    const out = await w.flow.submit({ id: 8, decision: "grant" });
    expect(out).toMatchObject({ outcome: "failed", row: null, rereadFailed: true });
    if (out.outcome === "failed") {
      expect(out.note.text).toContain(ACCOUNT_COPY["compute_admin.result.unconfirmed"]);
      expect(out.note.text).toContain(ACCOUNT_COPY["compute_admin.result.reread_failed"]);
    }
    expect(w.posts).toHaveLength(1);
    expect(w.gets).toHaveLength(1);
  });

  it("a signed-out answer reads nothing", async () => {
    const w = world(() => json(dec.refused_unauthenticated));
    const out = await w.flow.submit({ id: 8, decision: "grant" });
    expect(out).toMatchObject({
      outcome: "failed",
      note: { text: ACCOUNT_COPY["compute_admin.result.signed_out"] },
    });
    expect(w.gets).toEqual([]);
  });
});
