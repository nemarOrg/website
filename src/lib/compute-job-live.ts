/**
 * The browser side of the job page that touches a clock or a timer (website ADR 0030 phase E3, issue
 * #496). It is the ONE job module allowed to: the schedule itself is pure (`nextPoll` in
 * `compute-job-view.ts`, tested with an injected clock), and this file only holds the `setTimeout`, the
 * `AbortController` and the page-visibility events. The source scan in `test/compute-dashboard-ui.test.ts`
 * names this file as its single exception.
 *
 * `setTimeout` chains, never `setInterval`; at most one request in flight; a hidden tab clears the
 * timer and aborts the request; `pagehide` aborts.
 */
import {
  type PollEvent,
  type PollState,
  type PollStep,
  type StopReason,
  initialPoll,
  nextPoll,
} from "./compute-job-view";

/** The current time in epoch milliseconds. */
export function nowMs(): number {
  return Date.now();
}

export interface PollerHandlers {
  /** One read of the job; throw to report an error. Resolve with what the schedule needs to know. */
  read(signal: AbortSignal): Promise<{ state: string; changed: boolean }>;
  /** Called when the poller stops for good (or is paused by the hard stop and can be resumed). */
  onStop(reason: StopReason): void;
  /** Classify a thrown error: fatal ones end the poller at once. */
  fatal(err: unknown): "session" | "not_found" | undefined;
}

export interface Poller {
  /** Start (or restart) from a fresh schedule, as after Resume. */
  start(): void;
  /** Read once now, outside the schedule (after a cancel), and continue the schedule from it. */
  refreshNow(): void;
  stop(): void;
}

export function createPoller(handlers: PollerHandlers): Poller {
  let state: PollState = initialPoll(nowMs());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let lastReadAt = nowMs();
  let running = false;

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const abort = (): void => {
    controller?.abort();
    controller = undefined;
  };

  const apply = (event: PollEvent): void => {
    const out = nextPoll(state, event, nowMs(), Math.random());
    state = out.next;
    handle(out.step);
  };

  const handle = (step: PollStep): void => {
    clear();
    if (step.action === "stop") {
      abort();
      running = false;
      handlers.onStop(step.reason);
    } else if (step.action === "pause") {
      abort();
    } else if (step.action === "refresh_now") {
      void tick();
    } else {
      timer = setTimeout(() => void tick(), step.delayMs);
    }
  };

  const tick = async (): Promise<void> => {
    clear();
    if (!running || controller) return; // one request in flight at most
    const mine = new AbortController();
    controller = mine;
    let event: PollEvent;
    try {
      const got = await handlers.read(mine.signal);
      lastReadAt = nowMs();
      event = { kind: "read", state: got.state, changed: got.changed };
    } catch (err) {
      if (mine.signal.aborted) {
        if (controller === mine) controller = undefined;
        return; // aborted on purpose (hidden tab, pagehide): the visibility event restarts it
      }
      event = { kind: "error", fatal: handlers.fatal(err) };
    }
    if (controller === mine) controller = undefined;
    if (running) apply(event);
  };

  const onVisibility = (): void => {
    if (!running) return;
    if (document.hidden) {
      apply({ kind: "hidden" });
      clear();
    } else {
      apply({ kind: "visible", sinceLastReadMs: nowMs() - lastReadAt });
    }
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pagehide", () => {
    clear();
    abort();
  });

  return {
    start() {
      state = initialPoll(nowMs());
      running = true;
      lastReadAt = nowMs();
      clear();
      abort();
      if (!document.hidden) timer = setTimeout(() => void tick(), state.delayMs);
    },
    refreshNow() {
      if (!running) return;
      clear();
      abort();
      state = { ...state, delayMs: 10_000 };
      void tick();
    },
    stop() {
      running = false;
      clear();
      abort();
    },
  };
}
