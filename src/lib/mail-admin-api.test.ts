import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIL_ERROR_TEXT,
  MailApiError,
  TRANSPORT_TEXT,
  addNote,
  assignTicket,
  classifyNoteFailure,
  classifyReplyFailure,
  escalateTicket,
  fetchUnreadTicketCount,
  getAvailability,
  getTicket,
  isAssignable,
  listQueues,
  listTickets,
  loadStaffDirectory,
  mailErrorText,
  mailTicketsQuery,
  notAssignableLabel,
  personLabel,
  putAvailability,
  putQueue,
  putSummary,
  readMailError,
  replyToTicket,
  resetBadgeWarning,
  setTicketStatus,
} from "./mail-admin-api";
import {
  type ListTicketsResponse,
  MAIL_ERROR_CODES,
  type MailQueue,
  type TicketSummary,
  type UnreadCountResponse,
} from "./mail-admin-contract";
import type { AdminUserListRow } from "./users-admin-api";

// Response bodies are built from the contract types, so a change to the contract breaks the
// build here rather than a fixture.
const SUMMARY: TicketSummary = {
  id: 7,
  ref: "NEMAR-7",
  queue_tag: "support",
  restricted: false,
  status: "open",
  assignee_user_id: 3,
  requester_email: "requester@example.org",
  requester_user_id: null,
  subject: "Cannot sign in",
  created_at: "2026-10-20 09:00:00",
  updated_at: "2026-10-20 09:30:00",
  last_message_at: "2026-10-20 09:30:00",
  has_summary: false,
  purged: false,
  unread: false,
};

interface Seen {
  url: string;
  init: RequestInit;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stub(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

function header(seen: Seen, name: string): string | undefined {
  return (seen.init.headers as Record<string, string>)[name];
}

describe("mailTicketsQuery", () => {
  it("keeps valid values in a stable order", () => {
    expect(
      mailTicketsQuery({
        status: "open",
        queue: "support",
        assignee: "me",
        q: "  sign in ",
        cursor: "2026-10-20 09:30:00|7",
        limit: 50,
      }),
    ).toBe(
      "status=open&queue=support&assignee=me&q=sign+in&cursor=2026-10-20+09%3A30%3A00%7C7&limit=50",
    );
  });

  it("accepts none and a numeric assignee, and a limit given as a string", () => {
    expect(mailTicketsQuery({ assignee: "none" })).toBe("assignee=none");
    expect(mailTicketsQuery({ assignee: "42", limit: "25" })).toBe("assignee=42&limit=25");
  });

  it("drops every value the route would refuse", () => {
    expect(
      mailTicketsQuery({
        status: "archived",
        queue: "x".repeat(65),
        assignee: "someone",
        q: "q".repeat(101),
        cursor: "yesterday",
        limit: 0,
      }),
    ).toBe("");
    expect(mailTicketsQuery({ limit: 101 })).toBe("");
    expect(mailTicketsQuery({ limit: 1.5 })).toBe("");
    expect(mailTicketsQuery({ assignee: "1234567890123" })).toBe("");
    expect(mailTicketsQuery({ q: "   ", queue: "" })).toBe("");
  });
});

describe("requests", () => {
  it("lists through the same-origin proxy in the browser", async () => {
    const page: ListTicketsResponse = { tickets: [SUMMARY], next_cursor: null };
    const { fetchImpl, seen } = stub(() => json(page));
    const out = await listTickets({ status: "open" }, { fetch: fetchImpl });
    expect(out.tickets[0].ref).toBe("NEMAR-7");
    expect(seen[0].url).toBe("/api/v1/admin/mail/tickets?status=open");
    expect(seen[0].init.method).toBe("GET");
  });

  it("goes straight to the API, with the cookie, for a server caller", async () => {
    const { fetchImpl, seen } = stub(() => json({ tickets: [], next_cursor: null }));
    await listTickets({}, { fetch: fetchImpl, cookieHeader: "nemar_session=abc" });
    expect(seen[0].url).toBe("https://api.nemar.org/admin/mail/tickets");
    expect(header(seen[0], "Cookie")).toBe("nemar_session=abc");
  });

  it("sets Idempotency-Key on a reply and on a note, and on nothing else", async () => {
    const { fetchImpl, seen } = stub(() => json({ ok: true }));
    const init = { fetch: fetchImpl };
    await replyToTicket(7, "Hello", "web-key-1", init);
    await getTicket(7, init);
    await addNote(7, "note", "web-note-key", init);
    await assignTicket(7, null, init);
    await setTicketStatus(7, "closed", init);
    await escalateTicket(7, undefined, init);
    await listQueues(init);
    await getAvailability(undefined, init);
    expect(header(seen[0], "Idempotency-Key")).toBe("web-key-1");
    expect(seen[0].url).toBe("/api/v1/admin/mail/tickets/7/reply");
    expect(seen[0].init.body).toBe(JSON.stringify({ text: "Hello" }));
    expect(header(seen[2], "Idempotency-Key")).toBe("web-note-key");
    expect(seen[2].url).toBe("/api/v1/admin/mail/tickets/7/note");
    for (const i of [1, 3, 4, 5, 6, 7]) {
      expect(header(seen[i], "Idempotency-Key")).toBeUndefined();
    }
  });

  it("refuses a malformed reply key before sending", async () => {
    const { fetchImpl, seen } = stub(() => json({}));
    await expect(
      replyToTicket(7, "Hello", "has spaces", { fetch: fetchImpl }),
    ).rejects.toMatchObject({
      status: 400,
      code: "bad_request",
    });
    expect(seen).toEqual([]);
  });

  it("sends the right bodies for the action routes", async () => {
    const { fetchImpl, seen } = stub(() => json({ ticket: SUMMARY }));
    const init = { fetch: fetchImpl };
    await assignTicket(7, 3, init);
    await assignTicket(7, null, init);
    await setTicketStatus(7, "pending", init);
    await escalateTicket(7, undefined, init);
    await escalateTicket(7, "  needs an owner  ", init);
    const bodies = seen.map((s) => s.init.body);
    expect(bodies).toEqual([
      '{"user_id":3}',
      '{"user_id":null}',
      '{"status":"pending"}',
      "{}",
      '{"reason":"needs an owner"}',
    ]);
    expect(seen[0].url).toBe("/api/v1/admin/mail/tickets/7/assign");
    expect(seen[0].init.method).toBe("POST");
    expect((seen[0].init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("unwraps queues and availability, and addresses another person's window by id", async () => {
    const queue: MailQueue = {
      tag: "support",
      restricted: false,
      strategy: "fixed",
      assignee_user_id: 3,
      backup_user_id: null,
      rr_members: [],
      escalation_user_id: null,
      open_tickets: 2,
    };
    const away = {
      user_id: 9,
      away_from: null,
      away_until: null,
      backup_user_id: null,
      note: null,
    };
    const { fetchImpl, seen } = stub((url) =>
      url.endsWith("/queues")
        ? json({ queues: [queue] })
        : url.includes("/queues/")
          ? json({ queue })
          : json({ availability: away }),
    );
    const init = { fetch: fetchImpl };
    expect(await listQueues(init)).toEqual([queue]);
    expect(await putQueue("support", { restricted: false }, init)).toEqual(queue);
    expect((await getAvailability(9, init)).user_id).toBe(9);
    expect((await putAvailability({ note: null }, 9, init)).user_id).toBe(9);
    expect(seen.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      "GET /api/v1/admin/mail/queues",
      "PUT /api/v1/admin/mail/queues/support",
      "GET /api/v1/admin/mail/availability/9",
      "PUT /api/v1/admin/mail/availability/9",
    ]);
  });

  it("encodes a queue tag", async () => {
    const { fetchImpl, seen } = stub(() => json({ queue: {} }));
    await putQueue("a/b c", {}, { fetch: fetchImpl });
    expect(seen[0].url).toBe("/api/v1/admin/mail/queues/a%2Fb%20c");
  });

  it("reports an unreadable success as an error that keeps the real status", async () => {
    const { fetchImpl } = stub(() => new Response("<html>ok</html>", { status: 200 }));
    await expect(replyToTicket(7, "Hi", "web-k", { fetch: fetchImpl })).rejects.toMatchObject({
      status: 200,
      code: undefined,
    });
  });
});

describe("readMailError", () => {
  it("reads the API's sentence and closed word", async () => {
    expect(
      await readMailError(
        json({ error: "A spam ticket cannot be replied to.", code: "ticket_is_spam" }, 409),
      ),
    ).toEqual({ sentence: "A spam ticket cannot be replied to.", code: "ticket_is_spam" });
  });

  it("keeps the sentence and no code for the plain admin gate", async () => {
    expect(await readMailError(json({ error: "Admin access required" }, 403))).toEqual({
      sentence: "Admin access required",
      code: undefined,
    });
  });

  it("ignores a code it does not know", async () => {
    expect(await readMailError(json({ error: "x", code: "brand_new" }, 400))).toEqual({
      sentence: "x",
      code: undefined,
    });
  });

  it("reads the proxy's words as the sentence", async () => {
    expect(await readMailError(json({ error: "upstream_unreachable" }, 502))).toEqual({
      sentence: "upstream_unreachable",
      code: undefined,
    });
  });

  it("returns nothing for a gateway page, an empty body, null and a string", async () => {
    expect(await readMailError(new Response("<html>Bad gateway</html>", { status: 502 }))).toEqual(
      {},
    );
    expect(await readMailError(new Response("", { status: 500 }))).toEqual({});
    expect(await readMailError(json(null, 500))).toEqual({});
    expect(await readMailError(json("oops", 500))).toEqual({});
  });
});

describe("mailErrorText", () => {
  it("has wording for every closed word", () => {
    for (const code of MAIL_ERROR_CODES) {
      expect(MAIL_ERROR_TEXT[code].length).toBeGreaterThan(10);
      expect(MAIL_ERROR_TEXT[code]).not.toMatch(/nemar admin|--|'queues set/);
    }
    expect(Object.keys(MAIL_ERROR_TEXT).sort()).toEqual([...MAIL_ERROR_CODES].sort());
  });

  it("says one thing for not_found and never repeats the API's sentence", () => {
    const err = new MailApiError(404, "not_found", "No such ticket.");
    expect(mailErrorText(err)).toBe("There is no such ticket, or it is not visible to you.");
  });

  it("adds the API's sentence only when it says something new", () => {
    const wording = MAIL_ERROR_TEXT.bad_request;
    expect(mailErrorText(new MailApiError(400, "bad_request", wording))).toBe(wording);
    expect(
      mailErrorText(new MailApiError(400, "bad_request", "Invalid request: text too_big")),
    ).toBe(`${wording} Invalid request: text too_big`);
  });

  it("covers the proxy words and the bare statuses", () => {
    expect(mailErrorText(new MailApiError(502, undefined, "upstream_unreachable"))).toBe(
      TRANSPORT_TEXT.upstream_unreachable,
    );
    expect(mailErrorText(new MailApiError(502, undefined, "upstream_redirect"))).toBe(
      TRANSPORT_TEXT.upstream_redirect,
    );
    expect(mailErrorText(new MailApiError(403, undefined, "origin_not_allowed"))).toBe(
      TRANSPORT_TEXT.origin_not_allowed,
    );
    expect(mailErrorText(new MailApiError(401))).toBe("Sign in again.");
    expect(mailErrorText(new MailApiError(403, undefined, "Admin access required"))).toBe(
      "Your account is not permitted to do that.",
    );
    expect(mailErrorText(new MailApiError(429))).toBe(TRANSPORT_TEXT.rate_limited);
    expect(mailErrorText(new MailApiError(502))).toBe("The request failed (502). Try again.");
  });

  it("covers a lost connection and a timeout", () => {
    expect(mailErrorText(new TypeError("Failed to fetch"))).toBe(TRANSPORT_TEXT.network);
    expect(mailErrorText(new DOMException("timed out", "TimeoutError"))).toBe(
      TRANSPORT_TEXT.timeout,
    );
  });
});

describe("classifyReplyFailure", () => {
  const err = (status: number, code?: (typeof MAIL_ERROR_CODES)[number], sentence?: string) =>
    new MailApiError(status, code, sentence);

  it("lets the three reply words decide, whatever the status", () => {
    expect(classifyReplyFailure(err(409, "reply_in_progress"))).toBe("retry_same_key");
    expect(classifyReplyFailure(err(502, "reply_not_sent"))).toBe("key_released");
    expect(classifyReplyFailure(err(502, "reply_delivery_unknown"))).toBe("outcome_unknown");
    expect(classifyReplyFailure(err(200, "reply_delivery_unknown"))).toBe("outcome_unknown");
  });

  it("refuses on every other mail code that is a 4xx", () => {
    for (const code of MAIL_ERROR_CODES) {
      if (code in { reply_in_progress: 1, reply_not_sent: 1, reply_delivery_unknown: 1 }) continue;
      expect(classifyReplyFailure(err(409, code))).toBe("refused");
      expect(classifyReplyFailure(err(404, code))).toBe("refused");
    }
  });

  it("treats a mail code on a 5xx as in doubt", () => {
    expect(classifyReplyFailure(err(500, "internal"))).toBe("retry_same_key");
    expect(classifyReplyFailure(err(503, "inbound_not_configured"))).toBe("retry_same_key");
  });

  it("refuses when the API turned the request away before any send", () => {
    expect(classifyReplyFailure(err(403, undefined, "origin_not_allowed"))).toBe("refused");
    expect(classifyReplyFailure(err(401))).toBe("refused");
    expect(classifyReplyFailure(err(403, undefined, "Admin access required"))).toBe("refused");
  });

  it("keeps the same key for a limiter and for a 4xx that is not the mail route's", () => {
    expect(classifyReplyFailure(err(429))).toBe("retry_same_key");
    expect(classifyReplyFailure(err(408))).toBe("retry_same_key");
    expect(classifyReplyFailure(err(400, undefined, "Bad Request"))).toBe("retry_same_key");
    expect(classifyReplyFailure(err(404))).toBe("retry_same_key");
    expect(classifyReplyFailure(err(413))).toBe("retry_same_key");
  });

  it("keeps the same key for every 5xx, the proxy's words and an unreadable success", () => {
    expect(classifyReplyFailure(err(502, undefined, "upstream_unreachable"))).toBe(
      "retry_same_key",
    );
    expect(classifyReplyFailure(err(502, undefined, "upstream_redirect"))).toBe("retry_same_key");
    expect(classifyReplyFailure(err(500))).toBe("retry_same_key");
    expect(classifyReplyFailure(err(503))).toBe("retry_same_key");
    expect(classifyReplyFailure(err(200, undefined, "unreadable"))).toBe("retry_same_key");
  });

  it("keeps the same key when the call did not get an answer", () => {
    expect(classifyReplyFailure(new TypeError("Failed to fetch"))).toBe("retry_same_key");
    expect(classifyReplyFailure(new DOMException("t", "TimeoutError"))).toBe("retry_same_key");
    expect(classifyReplyFailure(new DOMException("a", "AbortError"))).toBe("retry_same_key");
    expect(classifyReplyFailure(new Error("anything"))).toBe("retry_same_key");
  });
});

describe("fetchUnreadTicketCount", () => {
  beforeEach(() => resetBadgeWarning());
  afterEach(() => vi.restoreAllMocks());

  it("asks the unread-count route and returns the exact count", async () => {
    const { fetchImpl, seen } = stub(() => json({ count: 137 } satisfies UnreadCountResponse));
    expect(await fetchUnreadTicketCount({ fetch: fetchImpl })).toBe(137);
    expect(seen[0].url).toBe("/api/v1/admin/mail/unread-count");
  });

  it("returns null for an answer that is not a count", async () => {
    const { fetchImpl } = stub(() => json({ count: "many" }));
    expect(await fetchUnreadTicketCount({ fetch: fetchImpl })).toBeNull();
  });

  it("returns null and logs on failure, and never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const refused = stub(() => json({ error: "Not found" }, 404));
    expect(await fetchUnreadTicketCount({ fetch: refused.fetchImpl })).toBeNull();
    const dropped = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    expect(await fetchUnreadTicketCount({ fetch: dropped })).toBeNull();
    // Two failures in a row, one line: the fallback is logged at most once a minute.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("logs again once the minute has passed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const dropped = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-24T12:00:00Z"));
      await fetchUnreadTicketCount({ fetch: dropped });
      vi.setSystemTime(new Date("2026-10-24T12:00:30Z"));
      await fetchUnreadTicketCount({ fetch: dropped });
      vi.setSystemTime(new Date("2026-10-24T12:01:01Z"));
      await fetchUnreadTicketCount({ fetch: dropped });
    } finally {
      vi.useRealTimers();
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("loadStaffDirectory", () => {
  afterEach(() => vi.restoreAllMocks());

  const user = (over: Partial<AdminUserListRow>): AdminUserListRow => ({
    id: 1,
    username: null,
    email: "someone@example.org",
    github_username: null,
    status: "approved",
    email_verified: 1,
    role: "admin",
    created_at: "2026-01-01 00:00:00",
    approved_at: null,
    revoked_at: null,
    ...over,
  });

  function usersStub(byRole: Record<string, AdminUserListRow[] | "fail">) {
    return stub((url) => {
      const role = new URL(url, "https://x.example").searchParams.get("role") ?? "";
      const rows = byRole[role];
      if (rows === "fail" || rows === undefined) return json({ error: "boom" }, 500);
      return json({ users: rows, count: rows.length });
    });
  }

  it("merges owners and admins and labels username, then name, then id", async () => {
    const { fetchImpl, seen } = usersStub({
      owner: [user({ id: 1, role: "owner", username: "ada" })],
      admin: [
        user({ id: 2, given_name: "Grace", family_name: "Hopper" }),
        user({ id: 3 }),
        user({ id: 1, role: "owner", username: "ada" }),
      ],
    });
    const dir = await loadStaffDirectory({ fetch: fetchImpl });
    expect(dir.failed).toBe(false);
    expect(dir.assignable.map((p) => [p.id, p.label, p.role])).toEqual([
      [3, "#3", "admin"],
      [1, "ada", "owner"],
      [2, "Grace Hopper", "admin"],
    ]);
    expect(seen.map((s) => s.url).sort()).toEqual([
      "/api/v1/admin/users?role=admin",
      "/api/v1/admin/users?role=owner",
    ]);
    expect(personLabel(dir, 2)).toBe("Grace Hopper");
    expect(personLabel(dir, 99)).toBe("#99");
    expect(personLabel(dir, null)).toBe("Unassigned");
  });

  it("offers only approved accounts to a picker but still names everyone", async () => {
    const { fetchImpl } = usersStub({
      owner: [],
      admin: [
        user({ id: 2, username: "grace" }),
        user({ id: 3, username: "revoked-admin", status: "revoked" }),
        user({ id: 4, username: "pending-admin", status: "pending" }),
        user({ id: 5, username: "iam-admin", status: "revoked_iam_pending" }),
      ],
    });
    const dir = await loadStaffDirectory({ fetch: fetchImpl });
    expect(dir.assignable.map((p) => p.label)).toEqual(["grace"]);
    expect(isAssignable(dir, 2)).toBe(true);
    expect(isAssignable(dir, 3)).toBe(false);
    expect(isAssignable(dir, 99)).toBe(false);
    // History still resolves them, and a select that must keep one marks it.
    expect(personLabel(dir, 3)).toBe("revoked-admin");
    expect(notAssignableLabel(dir, 3)).toBe("revoked-admin (not assignable)");
    expect(notAssignableLabel(dir, 99)).toBe("#99 (not assignable)");
  });

  it("escapes a name once, in the label, so no caller can print it raw", async () => {
    const { fetchImpl } = usersStub({
      owner: [],
      admin: [
        user({ id: 2, given_name: "Eve\u202e", family_name: "Mallory\u200b" }),
        user({ id: 3, username: "x\u2066y" }),
      ],
    });
    const dir = await loadStaffDirectory({ fetch: fetchImpl });
    expect(dir.assignable.map((p) => p.label)).toEqual(["Eve\\u202e Mallory\\u200b", "x\\u2066y"]);
    expect(personLabel(dir, 2)).toBe("Eve\\u202e Mallory\\u200b");
    expect(notAssignableLabel(dir, 3)).toBe("x\\u2066y (not assignable)");
  });

  it("keeps what loaded and sets failed when one list fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl } = usersStub({
      owner: "fail",
      admin: [user({ id: 2, username: "grace" })],
    });
    const dir = await loadStaffDirectory({ fetch: fetchImpl });
    expect(dir.failed).toBe(true);
    expect(dir.assignable.map((p) => p.label)).toEqual(["grace"]);
  });

  it("is empty and failed when both fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fetchImpl } = usersStub({ owner: "fail", admin: "fail" });
    const dir = await loadStaffDirectory({ fetch: fetchImpl });
    expect(dir).toMatchObject({ failed: true, assignable: [] });
  });
});

describe("addNote", () => {
  it("refuses a malformed key before sending", async () => {
    const { fetchImpl, seen } = stub(() => json({}));
    await expect(addNote(7, "note", "bad key", { fetch: fetchImpl })).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(seen).toEqual([]);
  });

  it("returns the stored id", async () => {
    const { fetchImpl } = stub(() => json({ message_id: 31 }));
    expect(await addNote(7, "note", "web-k", { fetch: fetchImpl })).toEqual({ message_id: 31 });
  });
});

describe("classifyNoteFailure", () => {
  it("retries under the same key when the outcome is unknown", () => {
    expect(classifyNoteFailure(new TypeError("Failed to fetch"))).toBe("retry_same_key");
    expect(classifyNoteFailure(new DOMException("t", "TimeoutError"))).toBe("retry_same_key");
    expect(classifyNoteFailure(new MailApiError(500, "internal"))).toBe("retry_same_key");
    expect(classifyNoteFailure(new MailApiError(503))).toBe("retry_same_key");
    expect(classifyNoteFailure(new MailApiError(408))).toBe("retry_same_key");
    expect(classifyNoteFailure(new MailApiError(429))).toBe("retry_same_key");
    expect(classifyNoteFailure(new MailApiError(502, undefined, "upstream_unreachable"))).toBe(
      "retry_same_key",
    );
  });

  it("does not retry a definite refusal", () => {
    expect(classifyNoteFailure(new MailApiError(404, "not_found"))).toBe("refused");
    expect(classifyNoteFailure(new MailApiError(409, "ticket_purged"))).toBe("refused");
    expect(classifyNoteFailure(new MailApiError(400, "bad_request"))).toBe("refused");
    expect(classifyNoteFailure(new MailApiError(403, undefined, "origin_not_allowed"))).toBe(
      "refused",
    );
  });
});

describe("putSummary and the summary filter", () => {
  it("PUTs the summary and returns the ticket", async () => {
    const { fetchImpl, seen } = stub(() => json({ ticket: { ...SUMMARY, has_summary: true } }));
    const out = await putSummary(7, "Sign-in problem; resolved.", { fetch: fetchImpl });
    expect(out.ticket.has_summary).toBe(true);
    expect(seen[0].url).toBe("/api/v1/admin/mail/tickets/7/summary");
    expect(seen[0].init.method).toBe("PUT");
    expect(seen[0].init.body).toBe(JSON.stringify({ summary: "Sign-in problem; resolved." }));
    expect(header(seen[0], "Idempotency-Key")).toBeUndefined();
  });

  it("explains the two retention refusals", () => {
    expect(
      mailErrorText(
        new MailApiError(400, "summary_has_address", "The summary contains an email address."),
      ),
    ).toMatch(/without names, addresses, account ids or quoted text/);
    expect(mailErrorText(new MailApiError(409, "ticket_purged"))).toMatch(
      /Only its summary is kept/,
    );
  });

  it("sends only summary=missing", () => {
    expect(mailTicketsQuery({ summary: "missing" })).toBe("summary=missing");
    expect(mailTicketsQuery({ summary: "present" })).toBe("");
    expect(mailTicketsQuery({ summary: "" })).toBe("");
  });
});
