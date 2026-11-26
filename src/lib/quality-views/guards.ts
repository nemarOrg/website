/**
 * Hand-written guards for view declarations and JSON contents (neuroschema 0.6.0; website ADR 0035
 * decision 3; the live-views plan's W4).
 *
 * The page cannot run a JSON Schema engine: ajv compiles schemas with `new Function`, which the
 * site's Content Security Policy does not allow outside `/dataset/*`, and the drawing code must stay
 * small. So each schema a renderer needs is written out here as a predicate, rule for rule:
 * `view.schema.json#/$defs/view` (the envelope), each registered kind's schema (the five generic
 * kinds and the five presets), the transforms `nemar.sensor-layout.v1` and `nemar.ic-activity.v1`,
 * and the contents `content.nemar.histogram.v1` and `content.nemar.ic-classes.v1`. They are held to
 * neuroschema's verdict corpus (`views/vectors/kinds-verdicts.v1.json`) by
 * `test/quality-views-guards.test.ts`: every case's verdict, valid or not, is this file's.
 *
 * The combinators below read like the schema keywords they stand for (`obj` is `type: object` with
 * `properties`, `required` and `additionalProperties: false`; `arr` is `type: array` with `items`,
 * `contains` and the counts). A string's length is counted in code points, as JSON Schema counts it.
 */

import { MAX_SAFE } from "./read";
import { digestable } from "./verify";

/** One rule: whether a value meets it. */
export type Guard = (value: unknown) => boolean;
type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const own = (value: Json, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** Any value. */
const anything: Guard = () => true;
/** `not: {}`: the member must be absent. */
const absent: Guard = () => false;

const all =
  (...guards: Guard[]): Guard =>
  (value) =>
    guards.every((guard) => guard(value));
const any =
  (...guards: Guard[]): Guard =>
  (value) =>
    guards.some((guard) => guard(value));
const exactlyOne =
  (...guards: Guard[]): Guard =>
  (value) =>
    guards.filter((guard) => guard(value)).length === 1;
const not =
  (guard: Guard): Guard =>
  (value) =>
    !guard(value);
const ifThen =
  (condition: Guard, then: Guard, otherwise: Guard = anything): Guard =>
  (value) =>
    condition(value) ? then(value) : otherwise(value);

/** A JSON value's identity for `const` and `uniqueItems`: numbers by value, keys sorted. */
function jsonKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonKey).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jsonKey(value[key])}`)
      .join(",")}}`;
  }
  return typeof value === "number" ? String(value + 0) : JSON.stringify(value);
}

const eq =
  (expected: unknown): Guard =>
  (value) =>
    jsonKey(value) === jsonKey(expected);
const oneIn =
  (...values: unknown[]): Guard =>
  (value) =>
    values.some((v) => jsonKey(v) === jsonKey(value));

interface StringRule {
  readonly pattern?: RegExp;
  readonly min?: number;
  readonly max?: number;
}
const str =
  ({ pattern, min = 0, max = Number.POSITIVE_INFINITY }: StringRule = {}): Guard =>
  (value) => {
    if (typeof value !== "string") return false;
    const length = [...value].length;
    return length >= min && length <= max && (!pattern || pattern.test(value));
  };

interface NumberRule {
  readonly min?: number;
  readonly max?: number;
  readonly exclusiveMin?: number;
  readonly exclusiveMax?: number;
}
const inRange = (value: number, rule: NumberRule): boolean =>
  (rule.min === undefined || value >= rule.min) &&
  (rule.max === undefined || value <= rule.max) &&
  (rule.exclusiveMin === undefined || value > rule.exclusiveMin) &&
  (rule.exclusiveMax === undefined || value < rule.exclusiveMax);
const num =
  (rule: NumberRule = {}): Guard =>
  (value) =>
    typeof value === "number" && Number.isFinite(value) && inRange(value, rule);
const int =
  (min: number, max: number): Guard =>
  (value) =>
    typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const isNull: Guard = (value) => value === null;
const bool: Guard = (value) => typeof value === "boolean";

interface ObjectRule {
  readonly props?: Readonly<Record<string, Guard>>;
  readonly req?: readonly string[];
  /** `additionalProperties: false`. */
  readonly closed?: boolean;
  readonly maxProps?: number;
  /** Further rules on the whole object (`allOf`, `oneOf`, `if`, ...). */
  readonly also?: readonly Guard[];
}
function objectRule(rule: ObjectRule, value: Json): boolean {
  for (const key of rule.req ?? []) if (!own(value, key)) return false;
  const keys = Object.keys(value);
  if (rule.maxProps !== undefined && keys.length > rule.maxProps) return false;
  for (const key of keys) {
    const guard = rule.props?.[key];
    if (guard ? !guard(value[key]) : rule.closed) return false;
  }
  return (rule.also ?? []).every((guard) => guard(value));
}
/** `type: object` with the rule. */
const obj =
  (rule: ObjectRule): Guard =>
  (value) =>
    isObject(value) && objectRule(rule, value);
/** The rule with no `type`: any value that is not an object passes, as JSON Schema has it. */
const ifObj =
  (rule: ObjectRule): Guard =>
  (value) =>
    !isObject(value) || objectRule(rule, value);
/** `required: [...]` alone. */
const req = (...keys: string[]): Guard => ifObj({ req: keys });

interface ArrayRule {
  readonly items?: Guard;
  /** `prefixItems`. */
  readonly prefix?: readonly Guard[];
  readonly min?: number;
  readonly max?: number;
  readonly unique?: boolean;
  /** `contains` with `minContains` (default 1) and `maxContains`. */
  readonly contains?: readonly (readonly [Guard, number?, number?])[];
  readonly also?: readonly Guard[];
}
function arrayRule(rule: ArrayRule, value: unknown[]): boolean {
  if (rule.min !== undefined && value.length < rule.min) return false;
  if (rule.max !== undefined && value.length > rule.max) return false;
  for (let i = 0; i < value.length; i++) {
    const guard = rule.prefix && i < rule.prefix.length ? rule.prefix[i] : rule.items;
    if (guard && !guard(value[i])) return false;
  }
  if (rule.unique && new Set(value.map(jsonKey)).size !== value.length) return false;
  for (const [guard, min = 1, max = Number.POSITIVE_INFINITY] of rule.contains ?? []) {
    const count = value.filter((item) => guard(item)).length;
    if (count < min || count > max) return false;
  }
  return (rule.also ?? []).every((guard) => guard(value));
}
const arr =
  (rule: ArrayRule): Guard =>
  (value) =>
    Array.isArray(value) && arrayRule(rule, value);
const ifArr =
  (rule: ArrayRule): Guard =>
  (value) =>
    !Array.isArray(value) || arrayRule(rule, value);
/** An array that contains an item meeting `guard` (`{type: array, contains}`). */
const containing = (guard: Guard): Guard => arr({ contains: [[guard]] });
/** An object whose `role` is `role` (`{type: object, properties: {role: {const}}, required}`). */
const hasRole = (role: string): Guard => obj({ req: ["role"], props: { role: eq(role) } });

// ── processingTypes.schema.json ─────────────────────────────────────────

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const viewKey = str({ pattern: NAME });
const roleName = str({ pattern: NAME });
const dimName = str({ pattern: NAME });
const kindName = str({ max: 128, pattern: /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/ });
const formatName = str({ pattern: /^[a-z][a-z0-9]{0,15}$/ });
const transformName = str({
  max: 128,
  pattern: /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+\.v[1-9][0-9]{0,2}$/,
});
const relativeLocation = str({
  min: 1,
  max: 1024,
  // Written with escapes: U+2028 and U+2029 would end a line of source.
  pattern:
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the schema refuses control characters in a location by naming them
    /^(?! )(?![\s\S]* $)(?!\/)(?![A-Za-z][A-Za-z0-9+.-]*:)(?!(?:[\s\S]*\/)?\.\.?(?:\/|$))(?![\s\S]*\/\/)(?![\s\S]*\/$)[^\\%?#\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]+$/u,
});
const sha256 = str({ pattern: /^[0-9a-f]{64}$/ });
const version = str({ pattern: /^[0-9A-Za-z._+-]{1,64}$/ });
const plugin = obj({
  req: ["name", "version"],
  props: { name: str({ pattern: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/ }), version },
  closed: true,
});
const recipe = obj({
  req: ["name", "version"],
  props: { name: str({ pattern: /^[a-z0-9-]{1,64}$/ }), version },
  closed: true,
});
const profile = oneIn("archive", "serving");

// ── view.schema.json ────────────────────────────────────────────────────

export const PRESETS: readonly string[] = [
  "nemar.spectrum",
  "nemar.ic-maps",
  "nemar.ic-classes",
  "nemar.ic-activity",
  "nemar.signal-window",
];

const COORDINATE_SYSTEM = /^(n\/a|[A-Za-z0-9][A-Za-z0-9_-]{0,63})$/;
const MONTAGE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const BYTES_CAP = 4194304;
const columnName = str({ min: 1, max: 128, pattern: /^[^\t\r\n]+$/ });
const valueType = oneIn("number", "integer", "string");
const unit = str({ min: 1, max: 32 });
const column = obj({
  req: ["name", "type"],
  props: { name: columnName, type: valueType, unit },
  closed: true,
});
const coords = all(
  obj({}),
  exactlyOne(
    ifObj({ req: ["column"], props: { column: columnName }, closed: true }),
    ifObj({ req: ["header"], props: { header: eq(true) }, closed: true }),
    ifObj({ req: ["role", "column"], props: { role: roleName, column: columnName }, closed: true }),
  ),
);
const dim = obj({
  req: ["name", "axis", "type", "coords"],
  props: { name: dimName, axis: oneIn("rows", "columns"), type: valueType, unit, coords },
  closed: true,
  also: [
    ifThen(
      obj({ req: ["name"], props: { name: eq("time") } }),
      obj({ req: ["unit"], props: { unit: eq("s") } }),
    ),
  ],
});
const locationEnds = (pattern: RegExp): Guard => ifObj({ props: { location: str({ pattern }) } });
const viewData = obj({
  req: ["role", "location", "format", "size", "sha256"],
  props: {
    role: roleName,
    location: relativeLocation,
    format: formatName,
    size: int(1, BYTES_CAP),
    sha256,
    columns: arr({ min: 1, items: column }),
    dims: arr({ min: 1, items: dim }),
    coordinate_system: str({ pattern: COORDINATE_SYSTEM }),
    position_source: oneIn("measured", "template"),
    montage: str({ pattern: MONTAGE }),
    cap_model: str({ max: 256 }),
    reference: str({ max: 256 }),
  },
  closed: true,
  also: [
    // dependentSchemas
    ifThen(
      req("montage"),
      obj({ req: ["position_source"], props: { position_source: eq("template") } }),
    ),
    ifThen(
      all(req("position_source"), obj({ props: { position_source: eq("template") } })),
      obj({ req: ["montage", "coordinate_system"], props: { coordinate_system: eq("n/a") } }),
    ),
    ifThen(obj({ req: ["format"], props: { format: eq("tsv") } }), locationEnds(/\.tsv$/)),
    ifThen(obj({ req: ["format"], props: { format: eq("json") } }), locationEnds(/\.json$/)),
    ifThen(
      obj({ req: ["location"], props: { location: str({ pattern: /\.[Tt][Ss][Vv]$/ }) } }),
      ifObj({ props: { format: eq("tsv") } }),
    ),
    ifThen(
      obj({ req: ["location"], props: { location: str({ pattern: /\.[Jj][Ss][Oo][Nn]$/ }) } }),
      ifObj({ props: { format: eq("json") } }),
    ),
  ],
});
const fileInput = obj({
  req: ["location", "sha256", "size"],
  props: { location: relativeLocation, sha256, size: int(1, BYTES_CAP) },
  closed: true,
});
const storeInput = obj({
  req: ["recording", "group", "content_sha256", "profile"],
  props: {
    recording: relativeLocation,
    path: relativeLocation,
    group: str({ pattern: MONTAGE }),
    content_sha256: any(sha256, isNull),
    profile,
  },
  closed: true,
  also: [
    ifThen(
      obj({ req: ["profile"], props: { profile: eq("serving") } }),
      ifObj({ props: { content_sha256: str() } }),
    ),
  ],
});
const viewInput = obj({
  req: ["role"],
  props: { role: roleName, file: fileInput, store: storeInput },
  closed: true,
  also: [exactlyOne(req("file"), req("store"))],
});
const transform = obj({
  req: ["name", "parameters"],
  props: { name: transformName, parameters: obj({}) },
  closed: true,
});
const viewSource = obj({
  props: { plugin, recipe },
  closed: true,
  also: [exactlyOne(req("plugin"), req("recipe"))],
});
const scopeSource = obj({ req: ["record_sha256"], props: { record_sha256: sha256 }, closed: true });

// ── The generic kinds (schema/views/kind.nemar.<kind>.v1.schema.json) ─────

const noBase = { base: absent, base_version: absent, inputs: absent, transform: absent };
const noParameters = obj({ maxProps: 0 });
const headerIsText = ifThen(
  obj({ req: ["coords"], props: { coords: obj({ req: ["header"] }) } }),
  obj({ props: { type: eq("string") } }),
);
const columnsAxis = obj({
  req: ["axis", "coords"],
  props: { axis: eq("columns"), coords: obj({ also: [any(req("header"), req("role"))] }) },
});
const noRoleCoords = ifObj({
  props: {
    data: ifArr({
      items: ifObj({
        props: {
          dims: ifArr({ items: ifObj({ props: { coords: obj({ also: [not(req("role"))] }) } }) }),
        },
      }),
    }),
  },
});

const tableItem = obj({
  req: ["columns"],
  props: { role: eq("table"), format: eq("tsv"), dims: absent },
});
const tableData = arr({ min: 1, max: 1, items: tableItem });

const linesItem = obj({
  req: ["role", "format", "columns", "dims"],
  props: {
    role: eq("values"),
    format: eq("tsv"),
    columns: arr({ min: 2, items: obj({ props: { type: oneIn("number", "integer") } }) }),
    dims: arr({
      min: 2,
      max: 2,
      items: obj({ also: [headerIsText] }),
      contains: [
        [
          obj({
            req: ["axis", "type", "coords"],
            props: {
              axis: eq("rows"),
              type: oneIn("number", "integer"),
              coords: obj({ req: ["column"], also: [not(req("role"))] }),
            },
          }),
          1,
          1,
        ],
        [columnsAxis, 1, 1],
      ],
    }),
  },
});
const linesData = arr({ min: 1, max: 1, items: linesItem });

const heatmapData = arr({
  min: 1,
  max: 1,
  items: obj({
    req: ["role", "format", "columns", "dims"],
    props: {
      role: eq("values"),
      format: eq("tsv"),
      columns: arr({ min: 1 }),
      dims: arr({
        min: 2,
        max: 2,
        items: obj({ also: [headerIsText] }),
        contains: [
          [
            obj({
              req: ["axis", "coords"],
              props: { axis: eq("rows"), coords: obj({ req: ["column"] }) },
            }),
            1,
            1,
          ],
          [columnsAxis, 1, 1],
        ],
      }),
    },
  }),
});

const histogramItem = obj({
  req: ["role", "format"],
  props: { role: eq("histogram"), format: eq("json"), columns: absent, dims: absent },
});
const histogramData = arr({ min: 1, max: 1, items: histogramItem });

const named = (name: string): Guard => obj({ req: ["name"], props: { name: eq(name) } });
const once = (guard: Guard): readonly [Guard, number, number] => [guard, 1, 1];

const fieldValues = obj({
  req: ["role", "format", "columns", "dims"],
  props: {
    role: eq("values"),
    format: eq("tsv"),
    dims: arr({
      min: 1,
      max: 2,
      items: obj({
        also: [
          ifThen(
            named("sensor"),
            all(
              ifObj({ props: { type: eq("string") } }),
              any(
                obj({
                  props: { axis: eq("rows"), coords: obj({ also: [not(req("header"))] }) },
                }),
                obj({
                  props: {
                    axis: eq("columns"),
                    coords: obj({ also: [any(req("header"), req("role"))] }),
                  },
                }),
              ),
            ),
          ),
        ],
      }),
      contains: [once(named("sensor"))],
      also: [
        ifThen(
          arr({ min: 2 }),
          all(
            containing(obj({ req: ["axis"], props: { axis: eq("rows") } })),
            containing(obj({ req: ["axis"], props: { axis: eq("columns") } })),
          ),
        ),
      ],
    }),
  },
});

/** A layout's or positions' sensor dimension: `sensor` along the rows, named by `name`. */
const sensorRows = arr({
  min: 1,
  max: 1,
  items: obj({
    props: {
      name: eq("sensor"),
      axis: eq("rows"),
      type: eq("string"),
      coords: obj({ req: ["column"], props: { column: eq("name") }, also: [not(req("role"))] }),
    },
  }),
});
const typedIfMeasured = ifThen(
  obj({ req: ["position_source"], props: { position_source: eq("measured") } }),
  ifObj({ props: { columns: containing(named("sensor_type")) } }),
);
const placeColumn = (name: string, rule: Guard): Guard =>
  ifThen(obj({ req: ["name"], props: { name: eq(name) } }), rule);
const fieldLayout = obj({
  req: ["role", "format", "columns", "dims", "coordinate_system", "position_source"],
  props: {
    role: eq("layout"),
    format: eq("tsv"),
    columns: arr({
      items: obj({
        props: { name: oneIn("name", "theta_deg", "radius", "sensor_type") },
        also: [
          ifThen(
            obj({ req: ["name"], props: { name: oneIn("name", "sensor_type") } }),
            obj({ props: { type: eq("string") } }),
          ),
          placeColumn(
            "theta_deg",
            obj({ req: ["unit"], props: { type: eq("number"), unit: eq("deg") } }),
          ),
          placeColumn("radius", obj({ props: { type: eq("number") } })),
        ],
      }),
      contains: [once(named("name")), once(named("theta_deg")), once(named("radius"))],
    }),
    dims: sensorRows,
    cap_model: absent,
    reference: absent,
  },
  also: [typedIfMeasured],
});
const fieldPositions = obj({
  req: ["role", "format", "columns", "dims", "coordinate_system", "position_source"],
  props: {
    role: eq("positions"),
    format: eq("tsv"),
    columns: arr({
      items: obj({
        props: { name: oneIn("name", "x", "y", "z", "sensor_type") },
        also: [
          ifThen(
            obj({ req: ["name"], props: { name: oneIn("name", "sensor_type") } }),
            obj({ props: { type: eq("string") } }),
          ),
          ifThen(
            obj({ req: ["name"], props: { name: oneIn("x", "y", "z") } }),
            obj({ props: { type: eq("number") } }),
          ),
        ],
      }),
      contains: [once(named("name")), once(named("x")), once(named("y")), once(named("z"))],
    }),
    dims: sensorRows,
  },
  also: [typedIfMeasured],
});
/** Every `values` entry's sensor dimension takes its coordinates by `rule`. */
const valuesSensorCoords = (rule: Guard): Guard =>
  ifArr({
    items: ifThen(
      hasRole("values"),
      obj({
        props: {
          dims: ifArr({ items: ifThen(named("sensor"), obj({ props: { coords: rule } })) }),
        },
      }),
    ),
  });
const fromRole = (role: string): Guard =>
  obj({ req: ["role", "column"], props: { role: eq(role), column: eq("name") } });
const fieldData = arr({
  items: exactlyOne(fieldValues, fieldLayout, fieldPositions),
  contains: [once(hasRole("values")), [hasRole("layout"), 0, 1], [hasRole("positions"), 0, 1]],
  also: [
    not(all(containing(hasRole("layout")), containing(hasRole("positions")))),
    ifThen(containing(hasRole("layout")), valuesSensorCoords(fromRole("layout"))),
    ifThen(containing(hasRole("positions")), valuesSensorCoords(fromRole("positions"))),
    ifThen(
      arr({ also: [not(any(containing(hasRole("layout")), containing(hasRole("positions"))))] }),
      valuesSensorCoords(obj({ also: [not(req("role"))] })),
    ),
  ],
});

/**
 * The `data` subschema of each generic kind (`properties.data` of its schema): what the role
 * contract checks a view's entries in the kind's roles against (docs/views.md, Kinds and the
 * renderer rule; `neuroschema.views.meets_role_contract`).
 */
export const GENERIC_DATA: Readonly<Record<string, Guard>> = {
  "nemar.table": tableData,
  "nemar.lines": linesData,
  "nemar.heatmap": heatmapData,
  "nemar.histogram": histogramData,
  "nemar.sensor-field": fieldData,
};

/** The roles each generic kind admits, and which of them are optional. */
export const GENERIC_ROLES: Readonly<
  Record<string, { readonly roles: readonly string[]; readonly optional: readonly string[] }>
> = {
  "nemar.table": { roles: ["table"], optional: [] },
  "nemar.lines": { roles: ["values"], optional: [] },
  "nemar.heatmap": { roles: ["values"], optional: [] },
  "nemar.histogram": { roles: ["histogram"], optional: [] },
  "nemar.sensor-field": {
    roles: ["values", "layout", "positions"],
    optional: ["layout", "positions"],
  },
};

const kindTable = obj({
  req: ["data"],
  props: { ...noBase, parameters: noParameters, data: tableData },
});
const kindLines = obj({
  req: ["data"],
  props: { ...noBase, parameters: noParameters, data: linesData },
  also: [noRoleCoords],
});
const kindHeatmap = obj({
  req: ["data"],
  props: {
    ...noBase,
    parameters: obj({ props: { limits: oneIn("minmax", "absmax") }, closed: true }),
    data: heatmapData,
  },
  also: [noRoleCoords],
});
const kindHistogram = obj({
  req: ["data"],
  props: { ...noBase, parameters: noParameters, data: histogramData },
});
const kindSensorField = obj({
  req: ["data"],
  props: {
    base: absent,
    base_version: absent,
    inputs: absent,
    transform: obj({ req: ["name"], props: { name: eq("nemar.sensor-layout.v1") } }),
    parameters: obj({ props: { limits: oneIn("absmax", "minmax") }, closed: true }),
    data: fieldData,
  },
  also: [
    ifThen(
      obj({ req: ["data"], props: { data: containing(hasRole("positions")) } }),
      req("transform"),
      ifObj({ props: { transform: absent } }),
    ),
  ],
});

// ── The presets ─────────────────────────────────────────────────────────

const presetLayout = all(
  fieldLayout,
  obj({
    props: {
      role: eq("layout"),
      format: eq("tsv"),
      dims: ifArr({ items: ifObj({ props: { name: eq("sensor") } }) }),
    },
  }),
);

const kindSpectrum = obj({
  req: ["base", "base_version", "parameters", "data"],
  props: {
    base: eq("nemar.lines"),
    base_version: eq(1),
    inputs: absent,
    transform: absent,
    parameters: obj({
      req: ["method", "window", "window_s", "overlap", "unit", "upper_hz"],
      props: {
        method: eq("welch"),
        window: str({ pattern: /^[a-z][a-z0-9_-]{0,31}$/ }),
        window_s: num({ exclusiveMin: 0 }),
        overlap: num({ min: 0, exclusiveMax: 1 }),
        unit: eq("dB"),
        upper_hz: num({ exclusiveMin: 0 }),
        initial_maps_hz: arr({ min: 1, max: 8, unique: true, items: num({ min: 0 }) }),
      },
      closed: true,
    }),
    data: arr({
      items: exactlyOne(
        all(
          linesItem,
          obj({
            req: ["role", "format", "columns", "dims"],
            props: {
              role: eq("values"),
              format: eq("tsv"),
              columns: arr({
                items: obj({
                  req: ["unit"],
                  props: { type: eq("number") },
                  also: [
                    ifThen(
                      named("freq_hz"),
                      ifObj({ props: { unit: eq("Hz") } }),
                      ifObj({ props: { unit: eq("dB") } }),
                    ),
                  ],
                }),
                contains: [once(named("freq_hz"))],
              }),
              dims: arr({
                items: obj({ props: { name: oneIn("freq", "sensor") } }),
                contains: [
                  once(
                    obj({
                      req: ["name", "axis", "type", "unit", "coords"],
                      props: {
                        name: eq("freq"),
                        axis: eq("rows"),
                        type: eq("number"),
                        unit: eq("Hz"),
                        coords: obj({ req: ["column"], props: { column: eq("freq_hz") } }),
                      },
                    }),
                  ),
                  once(
                    obj({
                      req: ["name", "axis", "type"],
                      props: { name: eq("sensor"), axis: eq("columns"), type: eq("string") },
                    }),
                  ),
                ],
              }),
            },
          }),
        ),
        presetLayout,
      ),
      contains: [once(hasRole("values")), [hasRole("layout"), 0, 1]],
      also: [
        ifThen(
          containing(hasRole("layout")),
          valuesSensorCoords(fromRole("layout")),
          valuesSensorCoords(obj({ req: ["header"] })),
        ),
      ],
    }),
  },
});

const kindIcMaps = obj({
  req: ["base", "base_version", "data"],
  props: {
    base: eq("nemar.sensor-field"),
    base_version: eq(1),
    inputs: absent,
    transform: absent,
    parameters: noParameters,
    data: arr({
      items: exactlyOne(
        all(
          fieldValues,
          obj({
            props: {
              role: eq("values"),
              format: eq("tsv"),
              columns: arr({ items: obj({ props: { type: eq("number") } }) }),
              dims: arr({
                min: 2,
                max: 2,
                items: obj({ props: { name: oneIn("sensor", "component") } }),
                contains: [
                  once(
                    obj({
                      req: ["name", "axis", "coords"],
                      props: { name: eq("sensor"), axis: eq("rows"), coords: fromRole("layout") },
                    }),
                  ),
                  once(
                    obj({
                      req: ["name", "axis", "type", "coords"],
                      props: {
                        name: eq("component"),
                        axis: eq("columns"),
                        type: eq("string"),
                        coords: obj({ req: ["header"] }),
                      },
                    }),
                  ),
                ],
              }),
            },
          }),
        ),
        presetLayout,
        obj({
          req: ["role", "format", "columns", "dims"],
          props: {
            role: eq("components"),
            format: eq("tsv"),
            columns: arr({
              min: 1,
              contains: [
                once(
                  obj({
                    req: ["name", "type"],
                    props: { name: eq("component"), type: eq("string") },
                  }),
                ),
              ],
            }),
            dims: arr({
              min: 1,
              max: 1,
              items: obj({
                req: ["name", "axis", "type", "coords"],
                props: {
                  name: eq("component"),
                  axis: eq("rows"),
                  type: eq("string"),
                  coords: obj({
                    req: ["column"],
                    props: { column: eq("component") },
                    also: [not(req("role"))],
                  }),
                },
              }),
            }),
          },
        }),
      ),
      contains: [once(hasRole("values")), once(hasRole("layout")), once(hasRole("components"))],
    }),
  },
});

const kindIcClasses = obj({
  req: ["base", "base_version", "data"],
  props: {
    base: eq("nemar.histogram"),
    base_version: eq(1),
    inputs: absent,
    transform: absent,
    parameters: noParameters,
    data: arr({ min: 1, max: 1, items: histogramItem }),
  },
});

const tsvFile = (pattern: RegExp): Guard => obj({ props: { location: str({ pattern }) } });

// ── The transforms (schema/views/transform.<name>.schema.json) ──────────

const transformSensorLayout = obj({
  req: ["transform"],
  also: [
    ifThen(
      obj({ req: ["data"], props: { data: containing(hasRole("positions")) } }),
      obj({
        props: {
          inputs: absent,
          transform: obj({ props: { parameters: obj({ maxProps: 0 }) } }),
        },
      }),
      obj({
        req: ["inputs"],
        props: {
          inputs: arr({
            min: 1,
            max: 1,
            items: obj({
              req: ["role", "file"],
              props: { role: eq("positions"), file: tsvFile(/\.tsv$/) },
            }),
          }),
          transform: obj({
            props: {
              parameters: obj({
                req: ["coordinate_system"],
                props: {
                  coordinate_system: str({ pattern: COORDINATE_SYSTEM }),
                  montage: str({ pattern: MONTAGE }),
                },
                closed: true,
                also: [ifThen(req("montage"), obj({ props: { coordinate_system: eq("n/a") } }))],
              }),
            },
          }),
        },
      }),
    ),
  ],
});

// ── The envelope ────────────────────────────────────────────────────────

/** Each registered kind's own schema, by `kind` at `kind_version` 1. */
/** Schemas loaded apart from this file (`guards-computed.ts`): the computed presets' kinds and
 *  transform, which only views of those kinds need. */
export interface ExtraSchemas {
  readonly kinds: Readonly<Record<string, Guard>>;
  readonly transforms: Readonly<Record<string, Guard>>;
}

/** The kinds and transforms whose schemas `guards-computed.ts` holds. */
export const COMPUTED_KINDS: readonly string[] = ["nemar.ic-activity", "nemar.signal-window"];
export const COMPUTED_TRANSFORMS: readonly string[] = ["nemar.ic-activity.v1"];

/** Whether a declaration names a kind or transform whose schema is in `guards-computed.ts`. */
export function needsComputedSchemas(view: unknown): boolean {
  if (!isObject(view)) return false;
  const t = view.transform;
  return (
    (typeof view.kind === "string" && COMPUTED_KINDS.includes(view.kind)) ||
    (isObject(t) && typeof t.name === "string" && COMPUTED_TRANSFORMS.includes(t.name))
  );
}

let extra: ExtraSchemas = { kinds: {}, transforms: {} };

const KIND_SCHEMAS: Readonly<Record<string, Guard>> = {
  "nemar.table": kindTable,
  "nemar.lines": kindLines,
  "nemar.heatmap": kindHeatmap,
  "nemar.histogram": kindHistogram,
  "nemar.sensor-field": kindSensorField,
  "nemar.spectrum": kindSpectrum,
  "nemar.ic-maps": kindIcMaps,
  "nemar.ic-classes": kindIcClasses,
};
const TRANSFORM_SCHEMAS: Readonly<Record<string, Guard>> = {
  "nemar.sensor-layout.v1": transformSensorLayout,
};

const RESERVED_SCOPES = ["subject", "dataset", "collection"];

const envelope = obj({
  req: ["key", "kind", "kind_version", "caption", "source"],
  props: {
    key: viewKey,
    kind: kindName,
    kind_version: int(1, 999),
    base: all(kindName, not(oneIn(...PRESETS))),
    base_version: int(1, 999),
    caption: str({ min: 1, max: 500 }),
    source: viewSource,
    scope: oneIn("recording", ...RESERVED_SCOPES),
    sources: arr({ min: 1, items: scopeSource }),
    parameters: obj({}),
    data: arr({ items: viewData }),
    inputs: arr({ items: viewInput }),
    transform,
  },
  closed: true,
  also: [
    ifThen(req("base"), req("base_version")),
    ifThen(req("base_version"), req("base")),
    any(
      obj({ req: ["data"], props: { data: arr({ min: 1 }) } }),
      obj({ req: ["inputs"], props: { inputs: arr({ min: 1 }) } }),
    ),
    ifThen(
      obj({ req: ["scope"], props: { scope: oneIn(...RESERVED_SCOPES) } }),
      req("sources"),
      ifObj({ props: { sources: absent } }),
    ),
    (view) => {
      const { kind, kind_version } = view as Json;
      const schema =
        typeof kind === "string" && kind_version === 1
          ? (KIND_SCHEMAS[kind] ?? extra.kinds[kind])
          : undefined;
      return !schema || schema(view);
    },
    (view) => {
      const t = (view as Json).transform;
      const name = isObject(t) ? t.name : undefined;
      const schema =
        typeof name === "string" ? (TRANSFORM_SCHEMAS[name] ?? extra.transforms[name]) : undefined;
      return !schema || schema(view);
    },
  ],
});

/** Whether a declaration is valid: it has a digest, and it meets `view.schema.json#/$defs/view`. */
export function declarationValid(view: unknown, schemas?: ExtraSchemas): boolean {
  if (needsComputedSchemas(view) && !schemas) {
    throw new Error("declarationValid: this view needs the schemas of guards-computed.ts");
  }
  extra = schemas ?? { kinds: {}, transforms: {} };
  try {
    return digestable(view) && envelope(view);
  } finally {
    extra = { kinds: {}, transforms: {} };
  }
}

/** What `guards-computed.ts` builds its schemas from. */
export const kit = {
  absent,
  all,
  any,
  arr,
  bool,
  columnName,
  containing,
  eq,
  exactlyOne,
  hasRole,
  ifObj,
  ifThen,
  int,
  isNull,
  MONTAGE,
  NAME,
  not,
  num,
  obj,
  oneIn,
  relativeLocation,
  req,
  sha256,
  str,
  tsvFile,
};

// ── Contents ────────────────────────────────────────────────────────────

const count = int(0, MAX_SAFE);
const histogramContent = obj({
  props: {
    edges: arr({ min: 2, max: 1025, items: num() }),
    categories: arr({ min: 1, max: 1024, unique: true, items: columnName }),
    counts: arr({ min: 1, max: 1024, items: count }),
    underflow: count,
    overflow: count,
    unit,
    missing: count,
  },
  also: [
    exactlyOne(
      ifObj({
        req: ["edges", "counts", "underflow", "overflow"],
        also: [not(req("categories"))],
      }),
      ifObj({
        req: ["categories", "counts"],
        also: [not(any(req("edges"), req("underflow"), req("overflow"), req("unit")))],
      }),
    ),
  ],
});

const PRINTABLE = /^[!-~](?:[ -~]*[!-~])?$/;
export const ICLABEL_CLASSES: readonly string[] = [
  "Brain",
  "Muscle",
  "Eye",
  "Heart",
  "Line Noise",
  "Channel Noise",
  "Other",
];
const icClassesContent = obj({
  req: ["classifier", "categories", "counts", "summed_variance_pct", "n_components"],
  props: {
    classifier: str({ min: 1, max: 64, pattern: PRINTABLE }),
    categories: arr({ items: str({ pattern: PRINTABLE }) }),
    counts: anything,
    summed_variance_pct: arr({ min: 1, max: 1024, items: num() }),
    n_components: int(1, 1024),
  },
  also: [
    histogramContent,
    ifThen(
      obj({ req: ["classifier"], props: { classifier: eq("ICLabel") } }),
      obj({ props: { categories: eq(ICLABEL_CLASSES) } }),
    ),
    ifThen(
      obj({
        req: ["classifier"],
        props: { classifier: str({ pattern: /^[IiLl1|][Cc][IiLl1|][Aa][Bb][Ee][IiLl1|]$/ }) },
      }),
      obj({ props: { classifier: eq("ICLabel") } }),
    ),
  ],
});

/** The content schemas a renderer checks a JSON role against, by file name. */
export const CONTENT_SCHEMAS: Readonly<Record<string, Guard>> = {
  "content.nemar.histogram.v1.schema.json": histogramContent,
  "content.nemar.ic-classes.v1.schema.json": icClassesContent,
};

export const histogramContentValid: Guard = histogramContent;
