/**
 * `nemar.signal-window` on the panel (presets.md): a card that says which window the view names and
 * opens it in the page's signal viewer with the floor's decisions marked. The view's checks run once
 * the viewer has opened the store (`signal-window.ts`), before anything is drawn; a refusal shows
 * its sentence in the viewer in place of the traces.
 */

import { ViewRefused } from "../model";
import { openSignal } from "../panel-bridge";
import { PresetRefused } from "../preset-refused";
import { numberText } from "../read";
import { checkSignalWindow } from "../signal-window";
import type { ExtraContext } from "./context";

export async function draw(x: ExtraContext): Promise<void> {
  const { doc, view } = x;
  const p = (view.parameters ?? {}) as { start_s?: number; duration_s?: number };
  const input = (view.inputs ?? []).find((i) => i.role === "signal") as
    | { store?: { group?: string } }
    | undefined;
  const card = doc.createElement("figure");
  card.className = "qv-figure qp-signal";
  card.id = x.ctx.id;
  const caption = doc.createElement("figcaption");
  caption.textContent = `${view.caption} (${view.kind}, version ${view.kind_version})`;
  const what = doc.createElement("p");
  what.textContent = `A ${numberText(p.duration_s ?? 0)} s window from ${numberText(p.start_s ?? 0)} s, opened in the signal viewer with the floor's bad channels and bad segments marked.`;
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "qp-open";
  button.textContent = "Open in the signal viewer";
  const said = doc.createElement("p");
  said.className = "qp-signal-status";
  said.setAttribute("role", "status");
  card.append(caption, what, button, said);
  x.container.replaceChildren(card);
  button.addEventListener("click", async () => {
    said.textContent = "";
    const opened = await openSignal(x.record.recording, {
      group: input?.store?.group ?? null,
      prepare: async ({ labels, samples, rate }) => {
        try {
          const window = await checkSignalWindow(
            view,
            x.source,
            // The serving copy publishes no content digest yet (nemar-cli#2343): not checked.
            { labels, samples, rate, published_sha256: null },
            x.options,
          );
          const words = await Promise.all([window.state, ...window.notes].map(x.sentence));
          return {
            ok: true,
            startS: window.first / rate,
            durationS: window.count / rate,
            badChannels: window.bad_channels,
            segments: window.segments,
            note: words.join(" "),
          };
        } catch (error) {
          const word =
            error instanceof PresetRefused || error instanceof ViewRefused ? error.word : "failed";
          return { ok: false, sentence: await x.sentence(word) };
        }
      },
    });
    if (!opened) said.textContent = await x.sentence("no_viewer");
  });
}
