/**
 * `nemar.ic-activity` on the panel's Activations tab (website phase W7; neuroschema 0.6.0
 * `docs/views/ic-activity.md`, The kind; nemar-cli ADR 0137 decision 9 as amended): the view's
 * checks, then the serving copy's window read and its activations computed in the map worker
 * (`activations.ts`), drawn as stacked traces with the spans ASR repaired shaded, and the captions
 * the specification fixes: computed in the browser with no preprocessing, the display filter, the
 * store digest's state, and the transform's own caption. A refusal draws no activations: it says
 * why and offers the view's files. A chunk of its own, loaded with the tab.
 */

import {
  type Activity,
  ActivityRefused,
  activity,
  activityHeight,
  burstsRepaired,
  checkDeclaration,
  drawActivity,
  fetchInputs,
  firstWindow,
  openServingStore,
  shownActivity,
  workerTransform,
} from "../activations";
import { CAPS, downloadsOf } from "../model";
import { storeUrlOf } from "../panel-bridge";
import { numberText } from "../read";
import { renderRefusal } from "../render/index";
import { toDom } from "../tree";
import type { ExtraContext } from "./context";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (typeof v === "object" && v !== null ? (v as Json) : {});

export async function draw(x: ExtraContext): Promise<void> {
  const { doc, view, signal } = x;
  const say = (key: string) => x.sentence(`activity:${key}`);
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = "") => {
    const node = doc.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };
  const refuse = async (word: string): Promise<void> => {
    const figure = toDom(renderRefusal(word, downloadsOf(view), x.ctx), doc) as HTMLElement;
    const text = await say(word);
    if (signal.aborted) return;
    const note = figure.querySelector(".qv-note");
    if (note) note.textContent = text;
    x.container.replaceChildren(figure);
  };
  const store = obj(obj((view.inputs ?? []).find((i) => i.role === "signal")).store);
  try {
    const word =
      (await checkDeclaration(view, x.options.checks)) ??
      (store.recording === x.record.recording ? null : "signal_recording_mismatch");
    if (signal.aborted) return;
    if (word !== null) return refuse(word);
    const files = await fetchInputs(view, x.source, x.options.caps);
    if (signal.aborted) return;
    // Checks 2 to 4 in the worker before the store is opened: a view whose tables or files are
    // not the record's is refused for that, whether or not the page can read a serving copy.
    const run = workerTransform(x.client);
    const prepared = await run.prepare({ view, files, caps: x.options.caps ?? CAPS });
    if (signal.aborted) return;
    if (prepared.word !== null) return refuse(prepared.word);
    const url = storeUrlOf(x.record.recording);
    const serving = url && (await openServingStore(url, String(store.group), signal));
    if (signal.aborted) return;
    if (!serving) return refuse("no_store");
    const parameters = obj(view.parameters);
    const transform = obj(obj(obj(view).transform).parameters);
    const label = String(obj(transform.shaded).label);
    const bursts = burstsRepaired(x.record.metrics);
    const shown = (w: { start: number; count: number }, stop = signal) =>
      activity(view, files, serving, w, bursts, run, stop, x.options.caps ?? CAPS);

    let window = firstWindow(serving.samples, serving.rate, parameters.max_window_s as number);
    const first = await shown(window);
    if (!first) return;

    // The figure: caption, the window's controls, the traces, and what was computed and how.
    const figure = el("figure", "qv-figure qp-activity");
    figure.id = x.ctx.id;
    const caption = el(
      "figcaption",
      "",
      `${view.caption} (${view.kind}, version ${view.kind_version})`,
    );
    const nav = el("div", "qp-activity__nav");
    // Never `disabled`: a button that loses focus as it ends the recording drops the keyboard user.
    const earlier = el("button", "qp-open", "Earlier window");
    const later = el("button", "qp-open", "Later window");
    const where = el("span", "qp-activity__where");
    where.setAttribute("role", "status");
    nav.append(earlier, where, later);
    const plot = el("div", "qp-activity__plot");
    plot.setAttribute("role", "img");
    const gl = el("canvas");
    const chrome = el("canvas");
    plot.append(gl, chrome);
    const notes = el("div", "qp-activity__notes");
    figure.append(caption, nav, plot, notes);
    x.container.replaceChildren(figure);

    const decomposition = obj(parameters.decomposition_input);
    const lines = await Promise.all([
      say("computed"),
      decomposition.source === "archive" ? say("archive") : "",
      say("filter"),
      x.sentence(first.plan.state),
      ...first.plan.notes.map(x.sentence),
    ]);
    if (signal.aborted) return;
    const own = typeof transform.caption === "string" ? `${transform.caption}.` : "";
    const hz = numberText(first.plan.highpassHz);
    const said = el("p", "qv-note", "");
    said.textContent = [...lines, own]
      .filter(Boolean)
      .map((t) => t.replaceAll("{hz}", hz))
      .join(" ");
    const spans = el("p", "qv-note");
    notes.append(said, spans);

    let dispose = (): void => {};
    signal.addEventListener("abort", () => dispose(), { once: true });
    // The window on show, for the view's export (W8).
    let shownNow = first;
    shownActivity.set(figure, () => ({ activity: shownNow, label }));
    const paint = async (a: Activity): Promise<void> => {
      shownNow = a;
      const style = getComputedStyle(x.container);
      const token = (name: string, fallback: string) =>
        style.getPropertyValue(name).trim() || fallback;
      const n = a.plan.components.length;
      const width = Math.max(320, plot.clientWidth || x.container.clientWidth || 640);
      const height = activityHeight(n);
      plot.style.height = `${height}px`;
      dispose();
      const out = await drawActivity(
        a,
        {
          gl,
          chrome,
          width,
          height,
          colors: {
            background: token("--color-bg", "#ffffff"),
            foreground: token("--color-fg", "#1a1a1a"),
            grid: token("--color-border", "#e6e6e6"),
          },
        },
        label,
      );
      dispose = out.dispose;
      const t0 = numberText(a.result.time[0]);
      const t1 = numberText(a.result.time[a.plan.count - 1]);
      where.textContent = `${t0} s to ${t1} s of ${numberText(serving.samples / serving.rate)} s`;
      spans.textContent = `${out.spans.length} span${out.spans.length === 1 ? "" : "s"} ASR repaired in this window ${out.spans.length === 1 ? "is" : "are"} shaded (${label}).`;
      plot.setAttribute(
        "aria-label",
        `Activations of ${n} components (${a.plan.components.join(", ")}) from ${t0} s to ${t1} s, in arbitrary units, filtered for display.`,
      );
      earlier.setAttribute("aria-disabled", String(window.start === 0));
      later.setAttribute("aria-disabled", String(window.start + window.count >= serving.samples));
    };
    await paint(first);
    let moving: AbortController | null = null;
    const move = async (button: HTMLElement, direction: number): Promise<void> => {
      if (button.getAttribute("aria-disabled") === "true") return;
      const start = Math.max(
        0,
        Math.min(serving.samples - window.count, window.start + direction * window.count),
      );
      window = { start, count: window.count };
      // A newer window stops the one still computing, in the worker too.
      moving?.abort();
      moving = new AbortController();
      const stop = AbortSignal.any([signal, moving.signal]);
      try {
        const next = await shown(window, stop);
        if (next && !stop.aborted) await paint(next);
      } catch (error) {
        if (stop.aborted) return;
        if (error instanceof ActivityRefused) return refuse(error.word);
        console.error("[quality-views] the activations could not be drawn:", error);
        await refuse("failed");
      }
    };
    earlier.addEventListener("click", () => void move(earlier, -1));
    later.addEventListener("click", () => void move(later, 1));
  } catch (error) {
    if (signal.aborted) return;
    if (error instanceof ActivityRefused) return refuse(error.word);
    throw error;
  }
}
