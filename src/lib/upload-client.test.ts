import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DroppedFile,
  UPLOAD_TIMEOUTS_MS,
  UploadError,
  type UploadEvent,
  createDraftDataset,
  filesFromInput,
  finalizeDataset,
  resolveSubmitAction,
  runUploadQueue,
  stripLeadingDirectory,
} from "./upload-client";

function df(path: string, size = 100): DroppedFile {
  const name = path.split("/").pop() ?? path;
  const file = new File([new Uint8Array(size)], name);
  return { path, size, file };
}

describe("stripLeadingDirectory", () => {
  it("strips a common leading directory when all paths share it", () => {
    const out = stripLeadingDirectory([
      df("ds002718/sub-01/eeg/x.set"),
      df("ds002718/dataset_description.json"),
    ]);
    expect(out.map((f) => f.path)).toEqual(["sub-01/eeg/x.set", "dataset_description.json"]);
  });

  it("leaves paths untouched when they do not share a leading directory", () => {
    const original = [df("sub-01/eeg/x.set"), df("dataset_description.json")];
    const out = stripLeadingDirectory(original);
    expect(out.map((f) => f.path)).toEqual(["sub-01/eeg/x.set", "dataset_description.json"]);
  });

  it("does not strip when one path equals the leading directory itself", () => {
    const out = stripLeadingDirectory([df("ds002718"), df("ds002718/sub-01/eeg/x.set")]);
    expect(out.map((f) => f.path)).toEqual(["ds002718", "ds002718/sub-01/eeg/x.set"]);
  });

  it("leaves a single-file drop untouched", () => {
    const out = stripLeadingDirectory([df("dataset_description.json")]);
    expect(out.map((f) => f.path)).toEqual(["dataset_description.json"]);
  });

  it("returns empty input unchanged", () => {
    expect(stripLeadingDirectory([])).toEqual([]);
  });
});

describe("filesFromInput", () => {
  it("uses webkitRelativePath when present", () => {
    const a = new File(["a"], "a.txt");
    Object.defineProperty(a, "webkitRelativePath", { value: "root/sub-01/a.txt" });
    const b = new File(["b"], "b.txt");
    Object.defineProperty(b, "webkitRelativePath", { value: "root/sub-02/b.txt" });
    const list = { 0: a, 1: b, length: 2, item: (i: number) => [a, b][i] } as unknown as FileList;
    const out = filesFromInput(list);
    expect(out.map((f) => f.path)).toEqual(["root/sub-01/a.txt", "root/sub-02/b.txt"]);
  });

  it("skips dotfiles and OS junk", () => {
    const files = ["a.txt", ".DS_Store", "Thumbs.db", "desktop.ini", "b.txt"].map((n) => {
      const f = new File(["x"], n);
      Object.defineProperty(f, "webkitRelativePath", { value: `root/${n}` });
      return f;
    });
    const list = {
      length: files.length,
      ...Object.fromEntries(files.map((f, i) => [i, f])),
      item: (i: number) => files[i],
    } as unknown as FileList;
    const out = filesFromInput(list);
    expect(out.map((f) => f.file.name)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("runUploadQueue", () => {
  it("processes every file once with concurrency = 3 and emits all_done", async () => {
    const plan = Array.from({ length: 10 }, (_, i) => ({
      file: df(`sub-${String(i + 1).padStart(2, "0")}/eeg/file.set`),
      url: `mock://put/${i}`,
    }));
    const totalSize = plan.reduce((sum, p) => sum + p.file.size, 0);
    const events: UploadEvent[] = [];
    const putFn = async (
      _f: DroppedFile,
      _u: string,
      onProgress: (n: number) => void,
    ): Promise<void> => {
      onProgress(50);
      await Promise.resolve();
      onProgress(100);
    };
    await runUploadQueue(plan, (e) => events.push(e), { concurrency: 3, putFn });
    const completed = events.filter((e) => e.type === "complete");
    expect(completed.length).toBe(10);
    const last = events.at(-1);
    expect(last?.type).toBe("all_done");
    if (last?.type === "all_done") {
      expect(last.bytesUploaded).toBe(totalSize);
      expect(last.totalBytes).toBe(totalSize);
    }
  });

  it("retries a failing PUT once then succeeds", async () => {
    const plan = [{ file: df("a.set"), url: "mock://put/a" }];
    let attempts = 0;
    const putFn = async (
      _f: DroppedFile,
      _u: string,
      onProgress: (n: number) => void,
    ): Promise<void> => {
      attempts += 1;
      if (attempts === 1) throw new UploadError("transient");
      onProgress(100);
    };
    const events: UploadEvent[] = [];
    await runUploadQueue(plan, (e) => events.push(e), { retries: 1, putFn });
    expect(attempts).toBe(2);
    expect(events.some((e) => e.type === "complete")).toBe(true);
    expect(events.some((e) => e.type === "failed")).toBe(false);
  });

  it("keeps aggregate bytesUploaded monotonically non-decreasing across a retry that rewinds progress", async () => {
    const plan = [{ file: df("a.set", 100), url: "mock://put/a" }];
    let attempts = 0;
    const putFn = async (
      _f: DroppedFile,
      _u: string,
      onProgress: (n: number) => void,
    ): Promise<void> => {
      attempts += 1;
      if (attempts === 1) {
        onProgress(80);
        throw new UploadError("transient");
      }
      // Retry: XHR rewinds the progress to a lower value than the first
      // attempt reached before completing.
      onProgress(30);
      onProgress(100);
    };
    const events: UploadEvent[] = [];
    await runUploadQueue(plan, (e) => events.push(e), { retries: 1, putFn });
    const progressValues = events
      .filter((e) => e.type === "progress")
      .map((e) => (e.type === "progress" ? e.bytesUploaded : 0));
    for (let i = 1; i < progressValues.length; i++) {
      expect(progressValues[i]).toBeGreaterThanOrEqual(progressValues[i - 1]);
    }
    const last = events.at(-1);
    if (last?.type === "all_done") expect(last.bytesUploaded).toBe(100);
  });

  it("surfaces a failure after exhausting retries", async () => {
    const plan = [{ file: df("a.set"), url: "mock://put/a" }];
    const putFn = async (): Promise<void> => {
      throw new UploadError("nope");
    };
    const events: UploadEvent[] = [];
    await expect(
      runUploadQueue(plan, (e) => events.push(e), { retries: 1, putFn }),
    ).rejects.toBeInstanceOf(UploadError);
    expect(events.some((e) => e.type === "failed" && e.error.includes("nope"))).toBe(true);
  });

  it("aborts cleanly when the signal is already aborted", async () => {
    const plan = Array.from({ length: 5 }, (_, i) => ({
      file: df(`f-${i}.set`),
      url: `mock://put/${i}`,
    }));
    const controller = new AbortController();
    controller.abort();
    const putFn = async (
      _f: DroppedFile,
      _u: string,
      onProgress: (n: number) => void,
    ): Promise<void> => {
      onProgress(100);
    };
    const events: UploadEvent[] = [];
    await runUploadQueue(plan, (e) => events.push(e), { putFn, signal: controller.signal });
    expect(events.filter((e) => e.type === "started").length).toBe(0);
    expect(events.at(-1)?.type).toBe("all_done");
  });

  it("stops processing mid-queue when the signal aborts between files", async () => {
    const plan = Array.from({ length: 5 }, (_, i) => ({
      file: df(`f-${i}.set`),
      url: `mock://put/${i}`,
    }));
    const controller = new AbortController();
    let started = 0;
    const putFn = async (
      _f: DroppedFile,
      _u: string,
      onProgress: (n: number) => void,
    ): Promise<void> => {
      started += 1;
      if (started === 2) controller.abort();
      onProgress(100);
    };
    const events: UploadEvent[] = [];
    await runUploadQueue(plan, (e) => events.push(e), {
      concurrency: 1,
      putFn,
      signal: controller.signal,
    });
    const startedEvents = events.filter((e) => e.type === "started").length;
    // Worker should stop picking new files after the abort. With concurrency=1,
    // we expect at most one or two starts before the worker bails.
    expect(startedEvents).toBeLessThan(5);
  });
});

describe("createDraftDataset request contract", () => {
  it("declares every file as type=data (backend only issues URLs for data files)", async () => {
    let body: string | undefined;
    const capturingFetch = (async (_url: string, requestInit: RequestInit) => {
      body = requestInit.body as string;
      return new Response(
        JSON.stringify({ dataset: { id: "xx90001", visibility: "private", upload_urls: {} } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await createDraftDataset(
      {
        name: "test",
        files: [
          { path: "dataset_description.json", size: 120 },
          { path: "sub-01/eeg/x.set", size: 4096 },
        ],
      },
      { fetch: capturingFetch },
    );
    const parsed = JSON.parse(body ?? "{}");
    expect(parsed.files).toEqual([
      { path: "dataset_description.json", size: 120, type: "data" },
      { path: "sub-01/eeg/x.set", size: 4096, type: "data" },
    ]);
  });
});

describe("createDraftDataset error surfacing", () => {
  function failingFetch(status: number, body: unknown, statusText = ""): typeof fetch {
    return (async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        statusText,
      })) as unknown as typeof fetch;
  }

  it("flattens a zValidator rejection into readable issue text", async () => {
    // Shape produced by Hono's zValidator: { success: false, error: ZodError },
    // whose serialized form carries `issues`. Before this handling, the page
    // showed "Could not create dataset: " with nothing after the colon.
    const zodBody = {
      success: false,
      error: {
        name: "ZodError",
        issues: [
          { code: "invalid_type", path: ["files", 0, "type"], message: "Required" },
          { code: "invalid_type", path: ["files", 1, "type"], message: "Required" },
        ],
      },
    };
    await expect(
      createDraftDataset({ name: "x", files: [] }, { fetch: failingFetch(400, zodBody) }),
    ).rejects.toThrow(/files\.0\.type: Required/);
  });

  it("caps the rendered issues at three and skips malformed entries", async () => {
    const zodBody = {
      success: false,
      error: {
        issues: [
          null,
          { path: "not-an-array", message: "first" },
          { path: ["files", 1], message: "" },
          { path: ["files", 2], message: 42 },
          { path: ["files", 3], message: "second" },
          { path: ["files", 4], message: "third" },
          { path: ["files", 5], message: "fourth" },
        ],
      },
    };
    const err = await createDraftDataset(
      { name: "x", files: [] },
      { fetch: failingFetch(400, zodBody) },
    ).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as Error).message).toBe(
      "Could not create dataset: first; files.3: second; files.4: third",
    );
  });

  it("falls back to the HTTP status when the body is unreadable and statusText is empty", async () => {
    // HTTP/2 responses have empty statusText, so a non-JSON error body used to
    // yield a blank message.
    await expect(
      createDraftDataset({ name: "x", files: [] }, { fetch: failingFetch(500, undefined) }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("still prefers a string error field when the backend provides one", async () => {
    await expect(
      createDraftDataset(
        { name: "x", files: [] },
        { fetch: failingFetch(400, { error: "Sandbox file size limit exceeded" }) },
      ),
    ).rejects.toThrow(/Sandbox file size limit exceeded/);
  });
});

// A fetch that never settles on its own — it only rejects when its signal
// aborts. These two calls are browser-side rather than SSR, so the failure
// mode is a spinner that never resolves instead of a stalled render; the fix
// is the same. The byte-transfer path is deliberately NOT covered here: its
// signal is the user's cancel button and a multi-gigabyte PUT legitimately
// runs for a long time, so it carries no deadline by design.
const hangingFetch = ((_url: string, requestInit: RequestInit) =>
  new Promise((_resolve, reject) => {
    requestInit.signal?.addEventListener("abort", () => reject(requestInit.signal?.reason));
  })) as unknown as typeof fetch;

describe("request deadlines", () => {
  it("aborts a hung create rather than spinning forever", async () => {
    // createDraftDataset wraps every throw from fetch (including the deadline)
    // in a contextual UploadError, so assert on that rather than TimeoutError.
    await expect(
      createDraftDataset({ name: "x", files: [] }, { fetch: hangingFetch, timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(UploadError);
  });

  it("aborts a hung finalize with the orphaned-draft guidance", async () => {
    await expect(finalizeDataset("nm-xyz", { fetch: hangingFetch, timeoutMs: 10 })).rejects.toThrow(
      /dashboard/i,
    );
  });

  // Finalize runs after every byte is already in S3, so aborting it early is
  // the expensive mistake in this file; it must stay strictly longer than create.
  it("gives finalize a longer deadline than create", () => {
    expect(UPLOAD_TIMEOUTS_MS.finalize).toBeGreaterThan(UPLOAD_TIMEOUTS_MS.create);
  });
});

// The suite above proves a deadline EXISTS, not which constant a call site
// passes — every case there supplies an explicit `timeoutMs`, which
// `resolveSignal` always prefers over the fallback. Spy on the static instead,
// with no override, so the fallback becomes observable.
describe("deadline wiring", () => {
  function okFetch(body: unknown): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the create deadline when creating a draft", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await createDraftDataset(
      { name: "x", files: [] },
      { fetch: okFetch({ dataset: { id: "nm-xyz", visibility: "private", upload_urls: {} } }) },
    );
    expect(spy).toHaveBeenCalledWith(UPLOAD_TIMEOUTS_MS.create);
  });

  // The regression this exists for: finalize runs after every byte is in S3,
  // so inheriting the shorter create deadline would orphan drafts.
  it("passes the finalize deadline when finalizing", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    await finalizeDataset("nm-xyz", { fetch: okFetch({ dataset: { status: "ready" } }) });
    expect(spy).toHaveBeenCalledWith(UPLOAD_TIMEOUTS_MS.finalize);
  });
});

describe("resolveSubmitAction", () => {
  it("runs the full create + upload flow when no draft is pending finalize", () => {
    expect(resolveSubmitAction(null)).toEqual({ kind: "create-and-upload" });
  });

  it("retries finalize alone when an uploaded draft is pending finalize", () => {
    expect(resolveSubmitAction("nm-abc123")).toEqual({
      kind: "finalize-only",
      draftId: "nm-abc123",
    });
  });

  // Repeat failures keep the id set, so the decision must be stable across
  // retries: same input, same finalize-only answer (finalize is idempotent).
  it("keeps answering finalize-only for the same pending draft", () => {
    expect(resolveSubmitAction("nm-abc123")).toEqual(resolveSubmitAction("nm-abc123"));
  });

  it("falls back to the full flow for an empty id", () => {
    expect(resolveSubmitAction("")).toEqual({ kind: "create-and-upload" });
  });
});
