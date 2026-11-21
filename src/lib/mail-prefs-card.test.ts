/**
 * The Settings "Email" card's rules, driven through the real controller. The switches are plain
 * objects with the three fields the card touches (what an `<input type="checkbox">` has), and the
 * load and save answers are the client's own result shapes, resolved by hand so a test can hold a
 * save in flight while another answers.
 */

import { describe, expect, it } from "vitest";
import type { MailPreferencesResult } from "./mail-prefs-api";
import { type MailPrefSwitch, createMailPrefsCard, saveOutcomeUnknown } from "./mail-prefs-card";

type Prefs = { news: boolean; rfcs: boolean; maintenance: boolean };

function switches(): Record<keyof Prefs, MailPrefSwitch> {
  const make = (mailPref: string): MailPrefSwitch => ({
    checked: false,
    disabled: true,
    dataset: { mailPref },
  });
  return { news: make("news"), rfcs: make("rfcs"), maintenance: make("maintenance") };
}

const ok = (prefs: Prefs): MailPreferencesResult => ({ ok: true, prefs });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function harness(opts: {
  loads: Array<MailPreferencesResult | Promise<MailPreferencesResult>>;
  saves?: Array<MailPreferencesResult | Promise<MailPreferencesResult>>;
}) {
  const sw = switches();
  const messages: Array<[string | null, string | undefined]> = [];
  let retry = false;
  const saveCalls: Array<[string, boolean]> = [];
  let loadCalls = 0;
  const card = createMailPrefsCard({
    switches: Object.values(sw),
    load: async () => {
      loadCalls++;
      const next = opts.loads.shift();
      if (!next) throw new Error("unexpected load");
      return next;
    },
    save: async (category, on) => {
      saveCalls.push([category, on]);
      const next = opts.saves?.shift();
      if (!next) throw new Error("unexpected save");
      return next;
    },
    message: (text, tone) => {
      messages.push([text, tone]);
    },
    retryVisible: (visible) => {
      retry = visible;
    },
  });
  return {
    card,
    sw,
    messages,
    saveCalls,
    get retry() {
      return retry;
    },
    get loadCalls() {
      return loadCalls;
    },
  };
}

/** Flip a switch the way a click does, then hand it to the card. */
function toggle(h: ReturnType<typeof harness>, key: keyof Prefs): Promise<void> {
  h.sw[key].checked = !h.sw[key].checked;
  return h.card.change(h.sw[key]);
}

describe("load", () => {
  it("enables the switches with the account's values", async () => {
    const h = harness({ loads: [ok({ news: true, rfcs: false, maintenance: true })] });
    await h.card.load();
    expect(h.sw.news).toMatchObject({ checked: true, disabled: false });
    expect(h.sw.rfcs).toMatchObject({ checked: false, disabled: false });
    expect(h.retry).toBe(false);
    expect(h.messages.at(-1)).toEqual([null, undefined]);
  });

  it("keeps the switches disabled after a failed load and offers Try again, which loads again", async () => {
    const h = harness({
      loads: [{ ok: false, status: "network" }, ok({ news: false, rfcs: true, maintenance: true })],
    });
    await h.card.load();
    expect(Object.values(h.sw).every((s) => s.disabled)).toBe(true);
    expect(h.retry).toBe(true);
    expect(h.messages.at(-1)?.[1]).toBe("error");
    await h.card.load();
    expect(h.retry).toBe(false);
    expect(h.sw.rfcs).toMatchObject({ checked: true, disabled: false });
  });
});

describe("Try again", () => {
  it("sends one request for a double click", async () => {
    const held = deferred<MailPreferencesResult>();
    const h = harness({ loads: [held.promise] });
    const first = h.card.load();
    const second = h.card.load();
    held.resolve(ok({ news: true, rfcs: true, maintenance: true }));
    await Promise.all([first, second]);
    expect(h.loadCalls).toBe(1);
    expect(h.sw.news).toMatchObject({ checked: true, disabled: false });
  });
});

describe("save", () => {
  const LOADED = { news: true, rfcs: true, maintenance: true };

  it("shows the account as the PUT answers it", async () => {
    const h = harness({ loads: [ok(LOADED)], saves: [ok({ ...LOADED, news: false })] });
    await h.card.load();
    await toggle(h, "news");
    expect(h.saveCalls).toEqual([["news", false]]);
    expect(h.sw.news).toMatchObject({ checked: false, disabled: false });
    expect(h.messages.at(-1)).toEqual(["Saved.", "success"]);
  });

  it("puts the switch back and shows the backend's sentence on a refusal", async () => {
    const message = "news must be true or false.";
    const h = harness({
      loads: [ok(LOADED)],
      saves: [{ ok: false, status: 400, code: "invalid_mail_preference", message }],
    });
    await h.card.load();
    await toggle(h, "news");
    expect(h.sw.news).toMatchObject({ checked: true, disabled: false });
    expect(h.messages.at(-1)).toEqual([message, "error"]);
    expect(h.loadCalls).toBe(1);
  });

  it.each([
    ["a network failure", { ok: false, status: "network" } as const],
    ["a 5xx", { ok: false, status: 502 } as const],
  ])("re-reads the account after %s instead of guessing", async (_name, failure) => {
    // The save landed even though its answer was lost: the re-read says news is off.
    const h = harness({
      loads: [ok(LOADED), ok({ ...LOADED, news: false })],
      saves: [failure],
    });
    await h.card.load();
    await toggle(h, "news");
    expect(h.loadCalls).toBe(2);
    expect(h.sw.news).toMatchObject({ checked: false, disabled: false });
    expect(h.messages.at(-1)?.[1]).toBe("error");
  });

  it("locks the switches, shows the switch's old value and offers Try again when the re-read fails too", async () => {
    const h = harness({
      loads: [ok(LOADED), { ok: false, status: "network" }],
      saves: [{ ok: false, status: "network" }],
    });
    await h.card.load();
    await toggle(h, "rfcs");
    expect(Object.values(h.sw).every((s) => s.disabled)).toBe(true);
    // rfcs was on; the change to off was never confirmed.
    expect(h.sw.rfcs.checked).toBe(true);
    expect(h.retry).toBe(true);
  });

  it("discards a re-read that started before a newer PUT answer was shown", async () => {
    const reread = deferred<MailPreferencesResult>();
    const rfcsSave = deferred<MailPreferencesResult>();
    const h = harness({
      loads: [ok(LOADED), reread.promise],
      saves: [{ ok: false, status: "network" }, rfcsSave.promise],
    });
    await h.card.load();
    // A: news's save has an unknown outcome, so its re-read goes out and is held open.
    const newsDone = toggle(h, "news");
    for (let i = 0; i < 10 && h.loadCalls < 2; i++) await Promise.resolve();
    expect(h.loadCalls).toBe(2);
    // B: rfcs is turned off and its PUT answers with the account as it is now.
    const rfcsDone = toggle(h, "rfcs");
    rfcsSave.resolve(ok({ news: true, rfcs: false, maintenance: true }));
    await rfcsDone;
    expect(h.sw.rfcs).toMatchObject({ checked: false, disabled: false });
    // The old read lands, from before rfcs changed: it must not put rfcs back on.
    reread.resolve(ok(LOADED));
    await newsDone;
    expect(h.sw.rfcs).toMatchObject({ checked: false, disabled: false });
    expect(h.sw.news).toMatchObject({ checked: true, disabled: false });
  });

  it("never lets one switch's answer overwrite or re-enable another switch still saving", async () => {
    const newsSave = deferred<MailPreferencesResult>();
    // The rfcs PUT answers first, with the account as it was before news's PUT landed.
    const h = harness({
      loads: [ok(LOADED)],
      saves: [newsSave.promise, ok({ news: true, rfcs: false, maintenance: true })],
    });
    await h.card.load();
    const newsDone = toggle(h, "news");
    expect(h.card.inFlight.has("news")).toBe(true);
    await toggle(h, "rfcs");
    expect(h.sw.rfcs).toMatchObject({ checked: false, disabled: false });
    // news keeps the person's pending choice and stays disabled.
    expect(h.sw.news).toMatchObject({ checked: false, disabled: true });
    newsSave.resolve(ok({ news: false, rfcs: false, maintenance: true }));
    await newsDone;
    expect(h.card.inFlight.size).toBe(0);
    expect(h.sw.news).toMatchObject({ checked: false, disabled: false });
  });

  it("ignores a second change to a switch whose save is in flight", async () => {
    const newsSave = deferred<MailPreferencesResult>();
    const h = harness({ loads: [ok(LOADED)], saves: [newsSave.promise] });
    await h.card.load();
    const first = toggle(h, "news");
    await h.card.change(h.sw.news);
    expect(h.saveCalls).toHaveLength(1);
    newsSave.resolve(ok({ ...LOADED, news: false }));
    await first;
  });
});

describe("saveOutcomeUnknown", () => {
  it("is true only for the network and 5xx", () => {
    expect(saveOutcomeUnknown({ ok: false, status: "network" })).toBe(true);
    expect(saveOutcomeUnknown({ ok: false, status: 503 })).toBe(true);
    expect(saveOutcomeUnknown({ ok: false, status: 400 })).toBe(false);
    expect(saveOutcomeUnknown({ ok: false, status: 401 })).toBe(false);
  });
});
