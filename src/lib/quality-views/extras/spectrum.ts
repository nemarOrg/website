/**
 * `nemar.spectrum`'s extras on the panel (presets.md): its recorded parameters, printed and never
 * recomputed, and the scalp maps of the sensors' stored values at the rows `initial_maps_hz` snaps
 * to, redrawn at the row a click or Enter picks on the lines (`qv-pick`).
 */

import type { BuiltModel } from "../model";
import { spectrumMaps } from "../preset-spectrum";
import { numberText } from "../read";
import { viewContext } from "../render/index";
import { type ExtraContext, intoFigure, noteOf } from "./context";

async function maps(
  x: ExtraContext,
  into: HTMLElement,
  asked: { hz?: readonly number[]; rows?: readonly number[] },
): Promise<void> {
  const drawn = await spectrumMaps(x.view, x.source, asked, x.options, x.built ?? undefined);
  if (!drawn) return;
  if (drawn.refused !== null || !drawn.model) {
    into.replaceChildren(await noteOf(x, drawn.refused ?? "empty"));
    return;
  }
  const labels = drawn.model.maps.items.map((m) => m.label).join(", ");
  const built: BuiltModel = {
    drawing: { via: "kind", kind: "nemar.sensor-field", kind_version: 1 },
    refused: null,
    downloads: [],
    model: drawn.model,
    ...(drawn.layout ? { layout: drawn.layout } : {}),
  };
  const ctx = viewContext(
    { ...x.view, caption: `Scalp maps of the spectrum at ${labels} Hz.` },
    `${x.ctx.id}-maps`,
  );
  await x.mount(into, built, ctx);
}

export async function draw(x: ExtraContext): Promise<void> {
  const p = (x.view.parameters ?? {}) as Record<string, unknown>;
  const line = x.doc.createElement("p");
  line.className = "qp-parameters";
  line.textContent = `Welch's method (${String(p.method)}): ${String(p.window)} windows of ${String(p.window_s)} s, ${numberText(Number(p.overlap) * 100)}% overlap, ${String(p.unit)} re 1 µV²/Hz, up to ${String(p.upper_hz)} Hz. Click the chart, or press Enter on it, to draw the scalp map at a frequency.`;
  intoFigure(x.figure, line);
  const into = x.doc.createElement("div");
  into.className = "qp-spectrum-maps";
  x.container.append(into);
  const initial = Array.isArray(p.initial_maps_hz) ? (p.initial_maps_hz as number[]) : [];
  await maps(x, into, { hz: initial });
  x.figure?.addEventListener("qv-pick", (event) => {
    void maps(x, into, { rows: [(event as CustomEvent<{ row: number }>).detail.row] });
  });
}
