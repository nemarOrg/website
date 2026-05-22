import { describe, expect, it } from "vitest";
import {
  type DroppedFile,
  UploadError,
  type UploadEvent,
  filesFromInput,
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
