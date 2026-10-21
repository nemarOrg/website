import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type NodeThread, nodeWorkerThreads } from "../../../test/node";
import pin from "../../../validator-version.json";
import {
  VALIDATOR_VERSION,
  describeDuration,
  describeError,
  isValidationReport,
  runValidation,
  workerUrl,
} from "./client";
import { canUpload } from "./gate";

describe("workerUrl", () => {
  it("serves the pinned release by default", () => {
    expect(VALIDATOR_VERSION).toBe(pin.version);
    expect(workerUrl()).toBe(`/vendor/bids-validator/${pin.version}/bids-validator-worker.js`);
  });

  it("is a different address for another release, so a cached worker is never the new one", () => {
    expect(workerUrl("9.9.9")).toBe("/vendor/bids-validator/9.9.9/bids-validator-worker.js");
    expect(workerUrl("9.9.9")).not.toBe(workerUrl());
  });
});

describe("isValidationReport", () => {
  // The shape `toReport` makes, with a finding of each kind: what a worker sends. The real
  // validator's reports are held to this in `test/bids-validator-integration.test.ts`.
  const report = {
    issues: [
      {
        severity: "error",
        code: "MISSING_DATASET_DESCRIPTION",
        affects: ["/dataset_description.json"],
      },
      {
        severity: "warning",
        code: "JSON_KEY_RECOMMENDED",
        subCode: "HEDVersion",
        location: "/dataset_description.json",
        issueMessage: "A recommended key is missing.",
        suggestion: "Add it.",
        rule: "rules.x",
      },
    ],
    codeMessages: { JSON_KEY_RECOMMENDED: "A JSON key that is recommended is missing." },
    summary: {
      totalFiles: 7,
      size: 1898,
      subjectCount: 1,
      sessionCount: 0,
      tasks: ["rest"],
      modalities: ["EEG"],
      dataTypes: ["eeg"],
      schemaVersion: "1.2.7",
    },
  };

  it("accepts a report in the declared shape, empty or not", () => {
    expect(isValidationReport(report)).toBe(true);
    expect(isValidationReport({ ...report, issues: [], codeMessages: {} })).toBe(true);
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["a string", "report"],
    ["a list", [report]],
    ["no findings list", { ...report, issues: undefined }],
    ["findings that are not a list", { ...report, issues: "none" }],
    [
      "a finding with an unknown severity",
      { ...report, issues: [{ severity: "fatal", code: "X" }] },
    ],
    ["a finding with no code", { ...report, issues: [{ severity: "error" }] }],
    [
      "a finding whose location is not text",
      { ...report, issues: [{ severity: "error", code: "X", location: 4 }] },
    ],
    [
      "a finding whose affected files are not a list",
      { ...report, issues: [{ severity: "error", code: "X", affects: "/a" }] },
    ],
    ["a finding that is not an object", { ...report, issues: [null] }],
    ["code descriptions that are a list", { ...report, codeMessages: [] }],
    ["a description that is not text", { ...report, codeMessages: { X: 1 } }],
    ["no summary", { ...report, summary: undefined }],
    [
      "a summary with no schema version",
      { ...report, summary: { ...report.summary, schemaVersion: undefined } },
    ],
    [
      "a count that is not a number",
      { ...report, summary: { ...report.summary, totalFiles: "7" } },
    ],
    [
      "a list of tasks that is not a list",
      { ...report, summary: { ...report.summary, tasks: "rest" } },
    ],
  ])("rejects %s", (_what, value) => {
    expect(isValidationReport(value)).toBe(false);
  });
});

describe("describeError", () => {
  it("names an error and its message, and writes anything else out", () => {
    expect(describeError(new TypeError("x is not a function"))).toBe(
      "TypeError: x is not a function",
    );
    expect(describeError("plain text")).toBe("plain text");
  });
});

describe("runValidation, where there is no browser to run it in", () => {
  // Node has no `Worker` global, which is the situation of a browser that cannot run one.
  it("says so as an outcome, and does not throw", async () => {
    expect(await runValidation([])).toEqual({
      kind: "unavailable",
      reason: "this browser has no Web Workers",
    });
  });

  it("is cancelled at once when the person had already stopped it", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runValidation([], { signal: controller.signal })).toEqual({ kind: "cancelled" });
  });
});

describe("describeDuration", () => {
  it("says a length of time as a reason would", () => {
    expect(describeDuration(15 * 60 * 1000)).toBe("15 minutes");
    expect(describeDuration(60_000)).toBe("1 minute");
    expect(describeDuration(2000)).toBe("2 seconds");
    expect(describeDuration(1000)).toBe("1 second");
    expect(describeDuration(150)).toBe("150 milliseconds");
    expect(describeDuration(1500)).toBe("1500 milliseconds");
  });
});

// Node has no `Worker`, so `runValidation` is given the browser's `Worker` surface (`onmessage`,
// `onerror`, `postMessage`, `terminate`) over a real thread from `node:worker_threads`: a separate
// thread that really runs, never answers, and is really ended by `terminate()`. The timers are the
// real ones, with a deadline short enough to wait for. What these cover is `runValidation`'s own
// logic, the deadline and the cancel, against something that behaves as a hung worker does.
const { Worker: NodeWorker } = await nodeWorkerThreads();

describe("runValidation, against a worker that never answers", () => {
  const NEVER_ANSWERS = "setInterval(() => {}, 1000);";
  let exits: Promise<number>[] = [];
  let terminations = 0;

  class ThreadWorker {
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: { message: string }) => void) | null = null;
    onmessageerror: (() => void) | null = null;
    private readonly thread: NodeThread = new NodeWorker(NEVER_ANSWERS, { eval: true });

    constructor() {
      exits.push(new Promise<number>((resolve) => this.thread.on("exit", resolve)));
      this.thread.on("message", (data) => this.onmessage?.({ data }));
      this.thread.on("error", (error) => this.onerror?.({ message: String(error) }));
    }

    postMessage(message: unknown): void {
      this.thread.postMessage(message);
    }

    terminate(): void {
      terminations += 1;
      void this.thread.terminate();
    }
  }

  /** Run `run` and return what it wrote to the console. The writes still go through. */
  async function recordingConsole(run: () => Promise<void>): Promise<string[]> {
    const written: string[] = [];
    const originals = {
      error: console.error,
      warn: console.warn,
      info: console.info,
      log: console.log,
    };
    for (const name of ["error", "warn", "info", "log"] as const) {
      console[name] = (...args: unknown[]) => {
        written.push(`${name}: ${args.map(String).join(" ")}`);
        originals[name](...args);
      };
    }
    try {
      await run();
    } finally {
      Object.assign(console, originals);
    }
    return written;
  }

  beforeEach(() => {
    exits = [];
    terminations = 0;
    (globalThis as { Worker?: unknown }).Worker = ThreadWorker;
  });
  afterEach(() => {
    // Back to a browser that has none, which the tests above rely on.
    (globalThis as { Worker?: unknown }).Worker = undefined;
  });

  it("ends it at the deadline, and says the check could not run", async () => {
    const started = performance.now();
    const outcome = await runValidation([], { deadlineMs: 150 });

    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "the check had not finished after 150 milliseconds",
    });
    // The thread was ended: `terminate()` was called, and the thread's own `exit` followed.
    expect(exits).toHaveLength(1);
    expect(await exits[0]).toBeTypeOf("number");
    // What the page does with that state: the upload is possible, and it is not a pass.
    expect(
      canUpload({
        structurePassed: true,
        validation: { kind: "unavailable", reason: "the check had not finished" },
      }),
    ).toBe(true);
  });

  it("ends it when the person cancels, and the deadline stays silent afterwards", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const outcome = await runValidation([], { signal: controller.signal, deadlineMs: 200 });

    expect(outcome).toEqual({ kind: "cancelled" });
    expect(await exits[0]).toBeTypeOf("number");
    expect(terminations).toBe(1);

    // Wait past the deadline, which was 200 ms from the start and is, by now, well behind. One that
    // had not been cleared would fire here and end the worker a second time, and say something.
    const written = await recordingConsole(
      () => new Promise<void>((resolve) => setTimeout(resolve, 250)),
    );
    expect(terminations).toBe(1);
    expect(written).toEqual([]);
  });
});
