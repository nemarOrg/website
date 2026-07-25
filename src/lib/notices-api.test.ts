import { describe, expect, it } from "vitest";
import {
  NOTICE_LEVELS,
  type Notice,
  type NoticeLevel,
  activeNotices,
  createNotice,
  deleteNotice,
  dismissalKey,
  dismissalStore,
  fetchActiveNotices,
  isNoticeDismissed,
  isNoticeExpired,
  listAdminNotices,
  presentationLevel,
  rememberNoticeDismissal,
  resolveDismissalStorage,
  sortNotices,
  toRfc3339,
} from "./notices-api";

function notice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: 1,
    message: "Scheduled maintenance tonight.",
    level: "tip",
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
  it("orders the full vocabulary most urgent first", () => {
    const sorted = sortNotices([
      notice({ id: 1, level: "tip" }),
      notice({ id: 2, level: "announcement" }),
      notice({ id: 3, level: "maintenance" }),
      notice({ id: 4, level: "warning" }),
      notice({ id: 5, level: "critical" }),
    ]);
    expect(sorted.map((n) => n.level)).toEqual([
      "critical",
      "warning",
      "maintenance",
      "announcement",
      "tip",
    ]);
  });

  // The ranking is derived from NOTICE_LEVELS, so the two can never disagree
  // — a level added to the array can't silently sort to the bottom.
  it("ranks exactly in NOTICE_LEVELS order", () => {
    const shuffled = [...NOTICE_LEVELS].reverse().map((level, i) => notice({ id: i, level }));
    expect(sortNotices(shuffled).map((n) => n.level)).toEqual([...NOTICE_LEVELS]);
  });

  it("puts the newest first within a level", () => {
    const sorted = sortNotices([
      notice({ id: 1, level: "tip", created_at: "2026-01-01 00:00:00" }),
      notice({ id: 2, level: "tip", created_at: "2026-07-01 00:00:00" }),
    ]);
    expect(sorted.map((n) => n.id)).toEqual([2, 1]);
  });

  it("does not mutate its input", () => {
    const input = [notice({ id: 1, level: "tip" }), notice({ id: 2, level: "critical" })];
    sortNotices(input);
    expect(input.map((n) => n.id)).toEqual([1, 2]);
  });
});

describe("presentationLevel", () => {
  it("passes through every level in the current vocabulary", () => {
    for (const level of NOTICE_LEVELS) {
      expect(presentationLevel(level)).toBe(level);
    }
  });

  // Production api.nemar.org still serves `info` (nemar-cli#1025 is on that
  // repo's `dev`, not promoted to `main`), so this build must render rows
  // from BOTH backends. Without the alias, `info` would miss LEVEL_RANK,
  // produce NaN in the sort comparator — which randomizes the whole stack,
  // not just that row — and get an unstyled `site-notice--info` class.
  it("maps the legacy info level onto tip", () => {
    expect(presentationLevel("info")).toBe("tip");
  });

  it("falls back to the quietest level for anything unrecognized", () => {
    expect(presentationLevel("wat")).toBe("tip");
    expect(presentationLevel("")).toBe("tip");
  });

  it("keeps sorting total when the backend sends a legacy level", () => {
    const sorted = sortNotices([
      notice({ id: 1, level: "info" as NoticeLevel }),
      notice({ id: 2, level: "critical" }),
      notice({ id: 3, level: "warning" }),
    ]);
    // info ranks as tip (last), not NaN — which would leave the order
    // arbitrary for every element, not just this one.
    expect(sorted.map((n) => n.id)).toEqual([2, 3, 1]);
  });

  it("routes a legacy level's dismissal to the store its mapped level uses", () => {
    expect(dismissalStore("info")).toBe(dismissalStore("tip"));
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
          level: "tip",
          message: "Site has moved",
          expires_at: "2026-10-31T00:00:00.000Z",
        }),
        notice({
          id: 2,
          level: "maintenance",
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
  // The split is "operationally live" vs "read-once", not raw severity: an
  // upcoming maintenance window must keep re-asserting like an outage does,
  // while a conference announcement stays dismissed.
  it("session-scopes the operational levels and persists the rest", () => {
    expect(dismissalStore("critical")).toBe("session");
    expect(dismissalStore("warning")).toBe("session");
    expect(dismissalStore("maintenance")).toBe("session");
    expect(dismissalStore("announcement")).toBe("local");
    expect(dismissalStore("tip")).toBe("local");
  });

  it("covers every level in the vocabulary", () => {
    for (const level of NOTICE_LEVELS) {
      expect(["local", "session"]).toContain(dismissalStore(level));
    }
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
  });

  // Asserts the *direction* of the conversion independently, rather than
  // against `new Date(...)` — the same call the implementation makes, which
  // would agree with itself no matter which way it interpreted the input.
  // A bare datetime-local value is local time, so the UTC instant must be
  // offset by exactly the runner's own offset for that date. On a UTC
  // runner that difference is zero, which is still the correct assertion.
  it("interprets a bare datetime-local value as local time, not UTC", () => {
    const local = "2026-07-25T14:30";
    const offsetMinutes = new Date(local).getTimezoneOffset();
    const asIfUtc = Date.parse(`${local}:00.000Z`);
    expect(Date.parse(toRfc3339(local) as string)).toBe(asIfUtc + offsetMinutes * 60_000);
  });

  // An explicit offset must be honoured as given, not re-interpreted.
  it("preserves an explicit offset", () => {
    expect(toRfc3339("2026-07-25T14:30:00+02:00")).toBe("2026-07-25T12:30:00.000Z");
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
        notices: [notice({ id: 1, level: "tip" }), notice({ id: 2, level: "critical" })],
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

  // REGRESSION (the bug that shipped and was caught only by running it):
  // `/api/notices` runs server-side, but an anonymous visitor sends no
  // cookie. Without the explicit `baseUrl`, the cookie-presence heuristic
  // resolves to the relative `/api/v1`, which is unfetchable from the
  // server. Because the banner fails soft, the symptom is not an error — it
  // is a banner that silently never appears for signed-out visitors, i.e.
  // most of the marketing surface. Deleting the `init.baseUrl ??` from
  // `baseFor` must fail a test, not pass CI.
  it("honours baseUrl over the cookie heuristic when there is no cookie", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string) => {
      calledUrl = url;
      return jsonResponse({ notices: [] });
    }) as unknown as typeof fetch;
    await fetchActiveNotices({ fetch: fakeFetch, baseUrl: "https://api.nemar.org" }, NOW);
    expect(calledUrl).toBe("https://api.nemar.org/notices");
    // The failure mode being guarded, stated explicitly.
    expect(calledUrl.startsWith("/")).toBe(false);
  });

  it("prefers baseUrl even when a cookie is also present", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string) => {
      calledUrl = url;
      return jsonResponse({ notices: [] });
    }) as unknown as typeof fetch;
    await fetchActiveNotices(
      {
        fetch: fakeFetch,
        cookieHeader: "nemar_session=abc",
        baseUrl: "https://api-test.nemar.org",
      },
      NOW,
    );
    expect(calledUrl).toBe("https://api-test.nemar.org/notices");
  });
});

describe("dismissal storage", () => {
  // Real Storage objects, not mocks: jsdom's localStorage/sessionStorage are
  // genuine implementations, so this is the same "real-shape input" policy
  // the fetch-shaped fakes above follow.
  function freshStorage(): Storage {
    const store = new Map<string, string>();
    return {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k: string) => store.get(k) ?? null,
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => void store.delete(k),
      setItem: (k: string, v: string) => void store.set(k, v),
    } as Storage;
  }

  it("routes critical to session storage and the rest to local", () => {
    const local = freshStorage();
    const session = freshStorage();
    const get = (level: Parameters<typeof resolveDismissalStorage>[0]) =>
      resolveDismissalStorage(
        level,
        () => local,
        () => session,
      );
    expect(get("critical")).toBe(session);
    expect(get("warning")).toBe(session);
    expect(get("maintenance")).toBe(session);
    expect(get("announcement")).toBe(local);
    expect(get("tip")).toBe(local);
  });

  // The access itself throws in some privacy modes — not the get/set, the
  // property read — so the try has to wrap the accessor call.
  it("returns null when reading the storage object throws", () => {
    const result = resolveDismissalStorage(
      "tip",
      () => {
        throw new DOMException("denied", "SecurityError");
      },
      () => freshStorage(),
    );
    expect(result).toBeNull();
  });

  it("round-trips a dismissal", () => {
    const storage = freshStorage();
    const n = notice({ id: 42 });
    expect(isNoticeDismissed(n, storage)).toBe(false);
    expect(rememberNoticeDismissal(n, storage)).toBe(true);
    expect(isNoticeDismissed(n, storage)).toBe(true);
  });

  it("keeps dismissals independent per notice", () => {
    const storage = freshStorage();
    rememberNoticeDismissal(notice({ id: 1 }), storage);
    // Dismissing a standing announcement must not suppress a maintenance
    // banner posted later — the whole reason keys are per-id.
    expect(isNoticeDismissed(notice({ id: 2 }), storage)).toBe(false);
  });

  // Safe direction: unreadable storage shows the notice again (annoying)
  // rather than hiding a live one (information lost).
  it("treats unavailable storage as not-dismissed", () => {
    expect(isNoticeDismissed(notice({ id: 1 }), null)).toBe(false);
  });

  it("reports a failed write rather than throwing", () => {
    const readOnly = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("QuotaExceededError");
      },
    } as unknown as Storage;
    expect(rememberNoticeDismissal(notice({ id: 1 }), readOnly)).toBe(false);
    expect(rememberNoticeDismissal(notice({ id: 1 }), null)).toBe(false);
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
        level: "tip",
        scope: "all",
        expires_at: "2026-10-31T00:00:00.000Z",
      });
      return jsonResponse(notice({ id: 9, message: "Site has moved" }), 201);
    }) as unknown as typeof fetch;
    const created = await createNotice(
      {
        message: "Site has moved",
        level: "tip",
        scope: "all",
        expires_at: "2026-10-31T00:00:00.000Z",
      },
      { fetch: fakeFetch },
    );
    expect(created.id).toBe(9);
  });

  it("surfaces the backend's validation error when creating fails", async () => {
    const fakeFetch = (async () =>
      jsonResponse(
        { error: "message: String must contain at most 1000 character(s)" },
        400,
      )) as unknown as typeof fetch;
    await expect(
      createNotice({ message: "x".repeat(1001), level: "tip", scope: "all" }, { fetch: fakeFetch }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Could not create notice: message: String must contain at most 1000 character(s)",
    });
  });

  it("omits expires_at entirely for a notice with no expiry", async () => {
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).not.toHaveProperty("expires_at");
      return jsonResponse(notice(), 201);
    }) as unknown as typeof fetch;
    await createNotice({ message: "m", level: "tip", scope: "all" }, { fetch: fakeFetch });
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
        { message: "m", level: "tip", scope: "all" },
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
