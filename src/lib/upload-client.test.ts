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
  return { path, size, name, file };
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
    expect(out.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
  });
});

describe("runUploadQueue", () => {
  it("processes every file once with concurrency = 3 and emits all_done", async () => {
    const plan = Array.from({ length: 10 }, (_, i) => ({
      file: df(`sub-${String(i + 1).padStart(2, "0")}/eeg/file.set`),
      url: `mock://put/${i}`,
    }));
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
    expect(events.at(-1)?.type).toBe("all_done");
    expect(events.at(-1)?.bytesUploaded).toBe(1000);
    expect(events.at(-1)?.totalBytes).toBe(1000);
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

  it("surfaces a failure after exhausting retries", async () => {
    const plan = [{ file: df("a.set"), url: "mock://put/a" }];
    const putFn = async (): Promise<void> => {
      throw new UploadError("nope");
    };
    const events: UploadEvent[] = [];
    await expect(
      runUploadQueue(plan, (e) => events.push(e), { retries: 1, putFn }),
    ).rejects.toBeInstanceOf(UploadError);
    expect(events.some((e) => e.type === "failed" && e.error?.includes("nope"))).toBe(true);
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
    // Workers should bail out immediately. all_done still emits at the end.
    expect(events.filter((e) => e.type === "started").length).toBe(0);
    expect(events.at(-1)?.type).toBe("all_done");
  });
});
