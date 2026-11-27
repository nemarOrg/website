/**
 * The view kinds this site knows and the renderer rule (the live-views plan's C2; neuroschema 0.6.0
 * `docs/views.md`, Kinds and the renderer rule; website ADR 0035 decision 3).
 *
 * The registry (`vocabulary/registry.json`, copied by digest from nemar-cli) lists the kinds. A
 * view of a kind at a version it lists draws with that kind's renderer; otherwise, when it names a
 * generic kind as its base and its data meet that base's role contract, the base's renderer draws
 * it; otherwise its data show as tables with a download of each file. An unknown kind, an unknown
 * base or a view that misses its base's contract is never an error: `drawAs` never throws, and
 * `render/index.ts` draws any model it is given, falling back to the tables.
 *
 * `neuroschema.views.registry.draw_as` and `meets_role_contract` are the Python reference.
 */

import { type Drawing, TABLE, type ViewCheck } from "./checks";
import {
  CONTENT_SCHEMAS,
  type ExtraSchemas,
  GENERIC_DATA,
  GENERIC_ROLES,
  declarationValid,
  needsComputedSchemas,
} from "./guards";
import type { ViewDecl } from "./model";

export interface KindEntry {
  readonly kind: string;
  readonly kind_version: number;
  readonly base: string | null;
  readonly base_version: number | null;
}
/**
 * The registry's kinds (`vocabulary/registry.json`), with only what the renderer rule reads: each
 * kind, its version and its base. Written out so the map worker does not carry the registry's
 * schema paths, roles and dimensions; `test/quality-views-kinds.test.ts` holds this table equal to
 * the vendored registry, which the vocabulary drift test holds to nemar-cli's.
 */
export const KIND_TABLE: readonly KindEntry[] = [
  { kind: "nemar.table", kind_version: 1, base: null, base_version: null },
  { kind: "nemar.lines", kind_version: 1, base: null, base_version: null },
  { kind: "nemar.heatmap", kind_version: 1, base: null, base_version: null },
  { kind: "nemar.histogram", kind_version: 1, base: null, base_version: null },
  { kind: "nemar.sensor-field", kind_version: 1, base: null, base_version: null },
  { kind: "nemar.spectrum", kind_version: 1, base: "nemar.lines", base_version: 1 },
  { kind: "nemar.ic-maps", kind_version: 1, base: "nemar.sensor-field", base_version: 1 },
  { kind: "nemar.ic-classes", kind_version: 1, base: "nemar.histogram", base_version: 1 },
  { kind: "nemar.ic-activity", kind_version: 1, base: "nemar.lines", base_version: 1 },
  { kind: "nemar.signal-window", kind_version: 1, base: "nemar.lines", base_version: 1 },
];
const KINDS: ReadonlyMap<string, KindEntry> = new Map(
  KIND_TABLE.map((entry) => [`${entry.kind}@${entry.kind_version}`, entry]),
);

/** A kind or base version as a version: an integer, never a boolean. */
const versionOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;
const kindEntry = (kind: unknown, version: unknown): KindEntry | undefined =>
  typeof kind === "string" && versionOf(version) !== null
    ? KINDS.get(`${kind}@${versionOf(version)}`)
    : undefined;

export { type Drawing, TABLE } from "./checks";

/** Whether a view's stored data meet a generic kind's role contract (docs/views.md). */
export function meetsRoleContract(view: ViewDecl, kind: string): boolean {
  const data = (view as { data?: unknown }).data;
  const contract = GENERIC_ROLES[kind];
  if (!Array.isArray(data) || !contract) return false;
  const files = data.filter(
    (entry) =>
      typeof entry === "object" && entry !== null && contract.roles.includes(String(entry.role)),
  );
  for (const role of contract.roles) {
    const count = files.filter((entry) => entry.role === role).length;
    if (count > 1 || (count === 0 && !contract.optional.includes(role))) return false;
  }
  return GENERIC_DATA[kind](files);
}

/** The renderer rule for a renderer that does not know the view's own kind. */
export function drawByBase(view: ViewDecl): Drawing {
  const base = kindEntry(view.base, view.base_version);
  if (base && base.base === null && meetsRoleContract(view, base.kind)) {
    return { via: "base", kind: base.kind, kind_version: base.kind_version };
  }
  return TABLE;
}

/** The renderer rule (C2): a known kind draws itself; else a known base whose role contract the
 *  data meet draws them; else the data show as tables with downloads. Never throws. */
export function drawAs(view: ViewDecl): Drawing {
  const own = kindEntry(view.kind, view.kind_version);
  if (own) return { via: "kind", kind: own.kind, kind_version: own.kind_version };
  return drawByBase(view);
}

/**
 * A declaration's checks with the schemas at hand: what the worker answers `check` with. Null when
 * the view names a computed preset or its transform and `schemas` (`guards-computed.ts`) are not
 * given: the worker does not hold them, and the page checks such a view itself
 * (`local-checks.ts`).
 */
export function checkView(view: unknown, schemas?: ExtraSchemas): ViewCheck | null {
  if (needsComputedSchemas(view) && !schemas) return null;
  if (!declarationValid(view, schemas)) return { valid: false, drawing: TABLE, byBase: TABLE };
  const decl = view as ViewDecl;
  return { valid: true, drawing: drawAs(decl), byBase: drawByBase(decl) };
}

export function checkContent(schema: string, content: unknown): boolean {
  const guard = CONTENT_SCHEMAS[schema];
  return guard ? guard(content) : false;
}
