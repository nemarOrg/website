import { describe, expect, it } from "vitest";
import {
  type Notice,
  activeNotices,
  createNotice,
  deleteNotice,
  dismissalKey,
  dismissalStore,
  fetchActiveNotices,
  isNoticeExpired,
  listAdminNotices,
  sortNotices,
  toRfc3339,
} from "./notices-api";

function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: 1,
    message: "Scheduled maintenance tonight.",
    level: "info",
    scope: "all",
    created_at: "2026-07-20 12:00:00",
    expires_at: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const NOW = new Date("2026-07-25T09:00:00.000Z");

describe("isNoticeExpired", () => {
  it("false when there is no expiry", () => {
    expect(isNoticeExpired(notice({ expires_at: null }), NOW)).toBe(false);
  });

  it("false for an expiry in the future", () => {
    expect(isNoticeExpired(notice({ expires_at: "2026-10-31T00:00:00.000Z" }), NOW)).toBe(false);
  });

  it("true for an expiry in the past", () => {
    expect(isNoticeExpired(notice({ expires_at: "2026-07-24T00:00:00.000Z" }), NOW)).toBe(true);
  });

  // The whole reason this helper exists (nemar-cli#1024). The backend
  // compares an ISO expires_at against SQLite's "YYYY-MM-DD HH:MM:SS" as
  // strings; 'T' sorts after ' ', so a same-day expiry is still served as
  // active until the next UTC day. Computing it here gets it right.
  it("true for a same-day expiry the backend would still serve as active", () => {
    expect(isNoticeExpired(notice({ expires_at: "2026-07-25T00:00:00.000Z" }), NOW)).toBe(true);
  });

  it("true at the exact expiry instant", () => {
    expect(isNoticeExpired(notice({ expires_at: "2026-07-25T09:00:00.000Z" }), NOW)).toBe(true);
  });

  // Showing a banner an admin meant to show beats hiding it over a
  // malformed timestamp, so an unparseable value is NOT treated as expired.
  it("false for an unparseable expiry rather than hiding the notice", () => {
    expect(isNoticeExpired(notice({ expires_at: "not a date" }), NOW)).toBe(false);
  });
});

describe("sortNotices", () => {
  // A transient maintenance banner must sit above a months-long standing
  // announcement, never under it.
  it("puts critical above warning above info", () => {
    const sorted = sortNotices([
      notice({ id: 1, level: "info" }),
      notice({ id: 2, level: "critical" }),
      notice({ id: 3, level: "warning" }),
    ]);
    expect(sorted.map((n) => n.id)).toEqual([2, 3, 1]);
  });

  it("puts the newest first within a level", () => {
    const sorted = sortNotices([
      notice({ id: 1, level: "info", created_at: "2026-01-01 00:00:00" }),
      notice({ id: 2, level: "info", created_at: "2026-07-01 00:00:00" }),
    ]);
    expect(sorted.map((n) => n.id)).toEqual([2, 1]);
  });

  it("does not mutate its input", () => {
    const input = [notice({ id: 1, level: "info" }), notice({ id: 2, level: "critical" })];
    sortNotices(input);
    expect(input.map((n) => n.id)).toEqual([1, 2]);
  });
});

describe("activeNotices", () => {
  // The scenario this was built for: a long-running announcement with a
  // maintenance banner stacked on top of it.
  it("drops expired notices and orders the rest by urgency", () => {
    const result = activeNotices(
      [
        notice({
          id: 1,
          level: "info",
          message: "Site has moved",
          expires_at: "2026-10-31T00:00:00.000Z",
        }),
        notice({
          id: 2,
          level: "critical",
          message: "Maintenance",
          expires_at: "2026-07-25T18:00:00.000Z",
        }),
        notice({
          id: 3,
          level: "warning",
          message: "Lapsed",
          expires_at: "2026-07-01T00:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(result.map((n) => n.id)).toEqual([2, 1]);
  });

  it("returns an empty array when everything has lapsed", () => {
    expect(activeNotices([notice({ expires_at: "2026-01-01T00:00:00.000Z" })], NOW)).toEqual([]);
  });
});

describe("dismissal", () => {
  it("keys dismissals per notice id", () => {
    expect(dismissalKey(7)).toBe("nemar:notice-dismissed:7");
    expect(dismissalKey(7)).not.toBe(dismissalKey(8));
  });

  // A standing announcement stays dismissed; a live outage re-asserts on
  // the next visit. This is the behavioural difference between the levels.
  it("persists info and warning dismissals but not critical ones", () => {
    expect(dismissalStore("info")).toBe("local");
    expect(dismissalStore("warning")).toBe("local");
    expect(dismissalStore("critical")).toBe("session");
  });
});

describe("toRfc3339", () => {
  // datetime-local yields "2026-07-25T14:30" — no seconds, no zone — which
  // z.string().datetime({offset: true}) rejects outright. Converting via
  // Date treats it as the admin's local time (what they typed and meant)
  // and renders UTC with a Z, which that validator accepts.
  it("converts a datetime-local value to a Z-suffixed RFC3339 string", () => {
    const result = toRfc3339("2026-07-25T14:30");
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result).toBe(new Date("2026-07-25T14:30").toISOString());
  });

  // Distinguishable from the error case by the caller: empty means "no
  // expiry", unparseable must be reported rather than silently creating a
  // never-expiring notice.
  it("returns undefined for empty or whitespace input", () => {
    expect(toRfc3339("")).toBeUndefined();
    expect(toRfc3339("   ")).toBeUndefined();
  });

  it("returns undefined for an unparseable value", () => {
    expect(toRfc3339("tomorrow-ish")).toBeUndefined();
  });
});

describe("fetchActiveNotices", () => {
  it("returns active notices in urgency order", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/notices");
      return jsonResponse({
        notices: [notice({ id: 1, level: "info" }), notice({ id: 2, level: "critical" })],
      });
    }) as unknown as typeof fetch;
    const result = await fetchActiveNotices({ fetch: fakeFetch }, NOW);
    expect(result.map((n) => n.id)).toEqual([2, 1]);
  });

  // Applied on top of whatever the server returns, because the server's own
  // expiry filter is unreliable until nemar-cli#1024 lands.
  it("filters out an expired notice the backend still served", async () => {
    const fakeFetch = (async () =>
      jsonResponse({
        notices: [notice({ id: 1, expires_at: "2026-07-25T00:00:00.000Z" })],
      })) as unknown as typeof fetch;
    await expect(fetchActiveNotices({ fetch: fakeFetch }, NOW)).resolves.toEqual([]);
  });

  // The banner is chrome: every failure mode degrades to "no banner", never
  // to a thrown error that would break the page it renders on.
  it("returns an empty array on a non-ok response", async () => {
    const fakeFetch = (async () => jsonResponse({ error: "boom" }, 500)) as unknown as typeof fetch;
    await expect(fetchActiveNotices({ fetch: fakeFetch }, NOW)).resolves.toEqual([]);
  });

  it("returns an empty array on a raw fetch rejection", async () => {
    const fakeFetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(fetchActiveNotices({ fetch: fakeFetch }, NOW)).resolves.toEqual([]);
  });

  it("tolerates a response with no notices key", async () => {
    const fakeFetch = (async () => jsonResponse({})) as unknown as typeof fetch;
    await expect(fetchActiveNotices({ fetch: fakeFetch }, NOW)).resolves.toEqual([]);
  });

  it("attaches the Cookie header and targets the API host when SSR", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.nemar.org/notices");
      expect((init.headers as Record<string, string>).Cookie).toBe("nemar_session=abc");
      return jsonResponse({ notices: [] });
    }) as unknown as typeof fetch;
    await fetchActiveNotices({ fetch: fakeFetch, cookieHeader: "nemar_session=abc" }, NOW);
  });
});

describe("admin CRUD", () => {
  it("lists every notice, expired included, without filtering", async () => {
    const fakeFetch = (async (url: string) => {
      expect(url).toBe("/api/v1/admin/notices");
      return jsonResponse({
        notices: [notice({ id: 1, expires_at: "2026-01-01T00:00:00.000Z" }), notice({ id: 2 })],
      });
    }) as unknown as typeof fetch;
    const result = await listAdminNotices({ fetch: fakeFetch });
    // The admin view must keep expired rows so they can be cleaned up.
    expect(result.map((n) => n.id)).toEqual([1, 2]);
  });

  it("surfaces the backend's error sentence when listing fails", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: "Admin access required" }, 403)) as unknown as typeof fetch;
    await expect(listAdminNotices({ fetch: fakeFetch })).rejects.toMatchObject({
      status: 403,
      message: "Could not list notices: Admin access required",
    });
  });

  it("posts the notice body and returns the created row", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/notices");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        message: "Site has moved",
        level: "info",
        scope: "all",
        expires_at: "2026-10-31T00:00:00.000Z",
      });
      return jsonResponse(notice({ id: 9, message: "Site has moved" }), 201);
    }) as unknown as typeof fetch;
    const created = await createNotice(
      {
        message: "Site has moved",
        level: "info",
        scope: "all",
        expires_at: "2026-10-31T00:00:00.000Z",
      },
      { fetch: fakeFetch },
    );
    expect(created.id).toBe(9);
  });

  it("omits expires_at entirely for a notice with no expiry", async () => {
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).not.toHaveProperty("expires_at");
      return jsonResponse(notice(), 201);
    }) as unknown as typeof fetch;
    await createNotice({ message: "m", level: "info", scope: "all" }, { fetch: fakeFetch });
  });

  it("deletes by id", async () => {
    const fakeFetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe("/api/v1/admin/notices/9");
      expect(init.method).toBe("DELETE");
      return jsonResponse({ message: "Notice deleted" });
    }) as unknown as typeof fetch;
    await deleteNotice(9, { fetch: fakeFetch });
  });

  it("surfaces the backend's 404 on a delete of an absent notice", async () => {
    const fakeFetch = (async () =>
      jsonResponse({ error: "Notice not found" }, 404)) as unknown as typeof fetch;
    await expect(deleteNotice(999, { fetch: fakeFetch })).rejects.toMatchObject({
      status: 404,
      message: "Could not delete notice: Notice not found",
    });
  });
});

// A fetch that never settles on its own — it only rejects when its signal
// aborts. The failure mode a plain try/catch cannot cover: a connection
// that opens and then never writes a response.
const hangingFetch = ((_url: string, requestInit: RequestInit) =>
  new Promise((_resolve, reject) => {
    requestInit.signal?.addEventListener("abort", () => reject(requestInit.signal?.reason));
  })) as unknown as typeof fetch;

describe("request deadlines", () => {
  // The banner runs on every page, including SSR of cached marketing pages.
  // An unbounded fetch here would stall a page render for every visitor.
  it("degrades the banner to an empty array when the request hangs", async () => {
    await expect(fetchActiveNotices({ fetch: hangingFetch, timeoutMs: 10 }, NOW)).resolves.toEqual(
      [],
    );
  });

  it("aborts a hung admin list", async () => {
    await expect(listAdminNotices({ fetch: hangingFetch, timeoutMs: 10 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("aborts a hung create", async () => {
    await expect(
      createNotice(
        { message: "m", level: "info", scope: "all" },
        { fetch: hangingFetch, timeoutMs: 10 },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a hung delete", async () => {
    await expect(deleteNotice(1, { fetch: hangingFetch, timeoutMs: 10 })).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });
});
