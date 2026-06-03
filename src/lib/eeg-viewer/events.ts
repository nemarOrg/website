/**
 * Event-layer helpers (website#99). Events are a recording-level layer: one
 * `events/` group per store (onset/duration/code + a `label_map` of code ->
 * description), shared across all channel groups. The viewer reads them once,
 * resolves each code to a human label and a stable color, and overlays the
 * subset that falls in the visible window on every frame.
 *
 * Pure (no zarr/DOM) so the windowing + color assignment are unit-tested.
 */
import { OKABE_ITO } from "./dsp";
import type { FrameEvent } from "./render";
import type { EventTable } from "./store";

export interface EventType {
  code: number;
  label: string;
  color: string;
  count: number;
}

/**
 * Distinct event types present, each with a stable color (assigned in
 * first-appearance order from the Okabe-Ito palette) and an occurrence count.
 * Drives the legend and the per-event coloring.
 */
export function buildEventTypes(events: EventTable): EventType[] {
  const order: number[] = [];
  const counts = new Map<number, number>();
  for (const code of events.code) {
    if (!counts.has(code)) order.push(code);
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return order.map((code, i) => ({
    code,
    label: events.labelMap[String(code)] ?? String(code),
    color: OKABE_ITO[i % OKABE_ITO.length],
    count: counts.get(code) ?? 0,
  }));
}

/**
 * Events overlapping `[startS, endS)` as render-ready `FrameEvent`s. An event
 * with a duration counts as visible if its span intersects the window, so
 * shading that begins off-screen still draws.
 */
export function eventsInWindow(
  events: EventTable,
  types: EventType[],
  startS: number,
  endS: number,
): FrameEvent[] {
  const colorByCode = new Map(types.map((t) => [t.code, t.color]));
  const labelByCode = new Map(types.map((t) => [t.code, t.label]));
  const out: FrameEvent[] = [];
  for (let i = 0; i < events.onsetS.length; i++) {
    const onset = events.onsetS[i];
    const duration = events.durationS[i] || 0;
    if (onset + duration < startS || onset >= endS) continue;
    const code = events.code[i];
    out.push({
      onsetS: onset,
      durationS: duration,
      label: labelByCode.get(code) ?? String(code),
      color: colorByCode.get(code) ?? "#888888",
    });
  }
  return out;
}
