import { describe, expect, it } from "vitest";
import { addNote, replyToTicket } from "./mail-admin-api";
import { draftStorageKey, parseDraft, serializeDraft } from "./mail-display";
import { createReplyFlow } from "./mail-reply-flow";

const TICKET = 7;

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

type Answer = () => Response | Promise<Response>;

/** A fetch that answers from a queue and records every request it receives. */
function network(...answers: Answer[]) {
  const requests: { url: string; key: string | undefined; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({
      url,
      key: (init.headers as Record<string, string>)["Idempotency-Key"],
      body: String(init.body),
    });
    const next = answers.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}

const ok = () =>
  new Response(
    JSON.stringify({ message_id: 12, header_message_id: "<x@example.org>", status: "pending" }),
    {
      status: 200,
    },
  );
const refusal = (status: number, code: string) => () =>
  new Response(JSON.stringify({ error: "A sentence.", code }), { status });

function flowOver(fetchImpl: typeof fetch, storage = memory()) {
  const flow = createReplyFlow({
    ticketId: TICKET,
    storage,
    sendReply: (text, key) => replyToTicket(TICKET, text, key, { fetch: fetchImpl }),
  });
  return { flow, storage };
}

describe("a double click", () => {
  it("sends one request, and the second attempt is ignored", async () => {
    let release: (r: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { requests, fetchImpl } = network(() => held);
    const { flow } = flowOver(fetchImpl);
    flow.edit("Hello there");
    const first = flow.attempt();
    const second = await flow.attempt();
    expect(second).toEqual({ outcome: "ignored" });
    expect(flow.draft.phase).toBe("sending");
    release(ok());
    expect(await first).toEqual({ outcome: "sent" });
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`/api/v1/admin/mail/tickets/${TICKET}/reply`);
    expect(requests[0].key).toMatch(/^web-/);
  });
});

describe("a lost response", () => {
  it("locks the draft in doubt and retries under the same key, which then sends once", async () => {
    const { requests, fetchImpl } = network(() => {
      throw new TypeError("Failed to fetch");
    }, ok);
    const { flow, storage } = flowOver(fetchImpl);
    flow.edit("Hello there");
    const keyBefore = flow.draft.key;
    const first = await flow.attempt();
    expect(first).toMatchObject({ outcome: "failed", kind: "retry_same_key" });
    expect(flow.draft).toMatchObject({ phase: "in_doubt", key: keyBefore, text: "Hello there" });
    // Locked: editing does nothing.
    flow.edit("Changed");
    expect(flow.draft.text).toBe("Hello there");
    expect(parseDraft(storage.getItem(draftStorageKey(TICKET)))).toMatchObject({
      phase: "in_doubt",
      key: keyBefore,
    });

    expect(await flow.attempt()).toEqual({ outcome: "sent" });
    expect(requests.map((r) => r.key)).toEqual([keyBefore, keyBefore]);
    expect(requests[1].body).toBe(requests[0].body);
  });

  it("treats a gateway 408 and a 503 the same way", async () => {
    const { fetchImpl } = network(
      () => new Response("", { status: 408 }),
      () => new Response("<html>down</html>", { status: 503 }),
      ok,
    );
    const { flow } = flowOver(fetchImpl);
    flow.edit("Hello");
    const key = flow.draft.key;
    expect(await flow.attempt()).toMatchObject({ kind: "retry_same_key" });
    expect(await flow.attempt()).toMatchObject({ kind: "retry_same_key" });
    expect(flow.draft.key).toBe(key);
    expect(await flow.attempt()).toEqual({ outcome: "sent" });
  });
});

describe("a reload mid-send", () => {
  it("restores a draft saved while sending as in doubt, and retries with the same key", async () => {
    const storage = memory();
    storage.setItem(
      draftStorageKey(TICKET),
      serializeDraft({ key: "web-stored-key", text: "Half sent", phase: "sending" }),
    );
    const { requests, fetchImpl } = network(ok);
    const { flow } = flowOver(fetchImpl, storage);
    expect(flow.draft).toEqual({ key: "web-stored-key", text: "Half sent", phase: "in_doubt" });
    expect(await flow.attempt()).toEqual({ outcome: "sent" });
    expect(requests).toHaveLength(1);
    expect(requests[0].key).toBe("web-stored-key");
  });

  it("ignores a stored draft it cannot trust and starts a fresh one", () => {
    const storage = memory();
    storage.setItem(draftStorageKey(TICKET), '{"v":1,"key":"bad key","text":"x","phase":"idle"}');
    const { fetchImpl } = network();
    const { flow } = flowOver(fetchImpl, storage);
    expect(flow.draft.text).toBe("");
    expect(flow.draft.key).toMatch(/^web-/);
  });
});

describe("a success", () => {
  it("clears the stored draft and moves to a fresh key", async () => {
    const { fetchImpl } = network(ok);
    const { flow, storage } = flowOver(fetchImpl);
    flow.edit("Hello");
    const used = flow.draft.key;
    expect(storage.data.size).toBe(1);
    expect(await flow.attempt()).toEqual({ outcome: "sent" });
    expect(storage.data.size).toBe(0);
    expect(flow.draft).toMatchObject({ text: "", phase: "idle" });
    expect(flow.draft.key).not.toBe(used);
  });
});

describe("refusals", () => {
  it("returns to idle with the same key and the text kept when nothing was sent", async () => {
    const { requests, fetchImpl } = network(
      refusal(502, "reply_not_sent"),
      refusal(409, "ticket_is_spam"),
      ok,
    );
    const { flow } = flowOver(fetchImpl);
    flow.edit("Hello");
    const key = flow.draft.key;
    expect(await flow.attempt()).toMatchObject({ kind: "key_released" });
    expect(flow.draft).toMatchObject({ phase: "idle", key, text: "Hello" });
    expect(await flow.attempt()).toMatchObject({ kind: "refused" });
    expect(flow.draft).toMatchObject({ phase: "idle", key });
    expect(await flow.attempt()).toEqual({ outcome: "sent" });
    expect(new Set(requests.map((r) => r.key))).toEqual(new Set([key]));
  });

  it("does not call out for empty or oversized text", async () => {
    const { requests, fetchImpl } = network();
    const { flow } = flowOver(fetchImpl);
    expect(await flow.attempt()).toEqual({ outcome: "empty" });
    flow.edit("   ");
    expect(await flow.attempt()).toEqual({ outcome: "empty" });
    flow.edit("x".repeat(20_001));
    expect(await flow.attempt()).toEqual({ outcome: "too_long" });
    expect(requests).toHaveLength(0);
  });
});

describe("delivery unknown and start over", () => {
  it("is final for the key, and a new key exists only after startOver", async () => {
    const { requests, fetchImpl } = network(refusal(502, "reply_delivery_unknown"), ok);
    const { flow, storage } = flowOver(fetchImpl);
    flow.edit("Hello");
    const first = flow.draft.key;
    expect(await flow.attempt()).toMatchObject({ kind: "outcome_unknown" });
    expect(flow.draft).toMatchObject({ phase: "unknown", key: first });
    // Nothing sends from here: not an attempt, not an edit.
    expect(await flow.attempt()).toEqual({ outcome: "ignored" });
    flow.edit("Rewritten");
    expect(flow.draft.text).toBe("Hello");
    expect(requests).toHaveLength(1);
    expect(parseDraft(storage.getItem(draftStorageKey(TICKET)))).toMatchObject({
      phase: "unknown",
      key: first,
    });

    flow.startOver();
    expect(flow.draft.key).not.toBe(first);
    expect(flow.draft).toMatchObject({ phase: "idle", text: "Hello" });
    expect(await flow.attempt()).toEqual({ outcome: "sent" });
    expect(requests.map((r) => r.key)).toEqual([first, requests[1].key]);
    expect(requests[1].key).not.toBe(first);
  });

  it("does nothing from any other phase", () => {
    const { fetchImpl } = network();
    const { flow } = flowOver(fetchImpl);
    flow.edit("Hello");
    const before = flow.draft;
    flow.startOver();
    expect(flow.draft).toBe(before);
  });
});

describe("onChange", () => {
  it("fires on every transition", async () => {
    const { fetchImpl } = network(ok);
    let calls = 0;
    const flow = createReplyFlow({
      ticketId: TICKET,
      storage: memory(),
      sendReply: (text, key) => replyToTicket(TICKET, text, key, { fetch: fetchImpl }),
      onChange: () => {
        calls++;
      },
    });
    flow.edit("Hello");
    await flow.attempt();
    // edit, sending, success
    expect(calls).toBe(3);
  });
});

describe("a note", () => {
  const noteOk = () => new Response(JSON.stringify({ message_id: 40 }), { status: 200 });

  function noteFlow(fetchImpl: typeof fetch, storage = memory()) {
    const flow = createReplyFlow({
      ticketId: TICKET,
      kind: "note",
      storage,
      sendReply: (text, key) => addNote(TICKET, text, key, { fetch: fetchImpl }),
    });
    return { flow, storage };
  }

  it("keeps its own draft, apart from the reply's", async () => {
    const { fetchImpl } = network(() => {
      throw new TypeError("Failed to fetch");
    });
    const { flow, storage } = noteFlow(fetchImpl);
    flow.edit("An internal remark");
    await flow.attempt();
    expect([...storage.data.keys()]).toEqual([`nemar:mail-note:${TICKET}`]);
  });

  it("retries a lost response under the same key and stores one note", async () => {
    const { requests, fetchImpl } = network(() => new Response("", { status: 503 }), noteOk);
    const { flow, storage } = noteFlow(fetchImpl);
    flow.edit("An internal remark");
    const key = flow.draft.key;
    expect(await flow.attempt()).toMatchObject({ outcome: "failed", kind: "retry_same_key" });
    expect(flow.draft).toMatchObject({ phase: "in_doubt", key });
    expect(await flow.attempt()).toEqual({ outcome: "sent" });
    expect(requests.map((r) => r.key)).toEqual([key, key]);
    expect(requests[0].url).toBe(`/api/v1/admin/mail/tickets/${TICKET}/note`);
    expect(storage.data.size).toBe(0);
    expect(flow.draft.key).not.toBe(key);
  });

  it("sends once on a double click", async () => {
    let release: (r: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const { requests, fetchImpl } = network(() => held);
    const { flow } = noteFlow(fetchImpl);
    flow.edit("An internal remark");
    const first = flow.attempt();
    expect(await flow.attempt()).toEqual({ outcome: "ignored" });
    release(noteOk());
    await first;
    expect(requests).toHaveLength(1);
  });

  it("returns to idle on a definite refusal, text kept", async () => {
    const { fetchImpl } = network(refusal(409, "ticket_purged"));
    const { flow } = noteFlow(fetchImpl);
    flow.edit("An internal remark");
    expect(await flow.attempt()).toMatchObject({ kind: "refused" });
    expect(flow.draft).toMatchObject({ phase: "idle", text: "An internal remark" });
  });
});
