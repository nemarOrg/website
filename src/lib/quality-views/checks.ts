/**
 * What the page asks of a view's declaration and contents before it builds a model, and where the
 * answers come from (website ADR 0035 decision 1; the owner's ruling on #594's size).
 *
 * The guards (`guards.ts`) and the renderer rule (`kinds.ts`) run in the map worker, so the page's
 * main thread never loads them: `SensorFieldClient.checks()` asks the worker, and falls back to
 * running them on this thread, loaded on demand, when the worker cannot answer. The tests and the
 * worker itself use `localChecks` from `kinds.ts`. This file holds only types and constants.
 */

/** How a view is drawn: by its own kind, by its base, or as tables. */
export interface Drawing {
  readonly via: "kind" | "base" | "table";
  readonly kind: string | null;
  readonly kind_version: number | null;
}
export const TABLE: Drawing = { via: "table", kind: null, kind_version: null };

export interface ViewCheck {
  /** Whether the declaration has a digest and meets `view.schema.json#/$defs/view`. */
  readonly valid: boolean;
  /** The renderer rule's drawing (the table for an invalid declaration). */
  readonly drawing: Drawing;
  /** The drawing a renderer that does not know the view's own kind would choose. */
  readonly byBase: Drawing;
}

export interface ViewChecks {
  view(view: unknown): Promise<ViewCheck>;
  /** Whether a JSON role's content meets the content schema of that file name. */
  content(schema: string, content: unknown): Promise<boolean>;
}

export const HISTOGRAM_CONTENT = "content.nemar.histogram.v1.schema.json";
