/**
 * The schemas of the computed presets, `nemar.ic-activity` and `nemar.signal-window` version 1, and
 * of the transform `nemar.ic-activity.v1`, written out as predicates like the rest of `guards.ts`
 * and held to the same verdict corpus. They are a chunk of their own, loaded by the worker only for
 * a view that names one of them (`kinds.ts`), so the map worker stays within its size budget.
 */

import { type ExtraSchemas, type Guard, kit } from "./guards";
import { MAX_SAFE } from "./read";

const {
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
} = kit;

const signalStore = obj({ req: ["role", "store"], props: { role: eq("signal") } });
const contained = (role: string, min: number, max: number) => [hasRole(role), min, max] as const;

const kindSignalWindow = obj({
  req: ["base", "base_version", "inputs", "parameters"],
  props: {
    base: eq("nemar.lines"),
    base_version: eq(1),
    data: absent,
    transform: absent,
    inputs: arr({
      items: exactlyOne(
        signalStore,
        obj({
          req: ["role", "file"],
          props: { role: oneIn("channels", "badsegments"), file: tsvFile(/\.tsv$/) },
          also: [
            ifThen(
              obj({ props: { role: eq("channels") } }),
              obj({ props: { file: tsvFile(/_channels\.tsv$/) } }),
              obj({ props: { file: tsvFile(/_badsegments\.tsv$/) } }),
            ),
          ],
        }),
      ),
      contains: [
        contained("signal", 1, 1),
        contained("channels", 1, 1),
        contained("badsegments", 0, 1),
      ],
    }),
    parameters: obj({
      req: ["start_s", "duration_s", "bad_segment_table"],
      props: {
        start_s: num({ min: 0 }),
        duration_s: num({ exclusiveMin: 0, max: 30 }),
        bad_segment_table: bool,
      },
      closed: true,
    }),
  },
  also: [
    ifThen(
      obj({
        req: ["parameters"],
        props: {
          parameters: obj({ req: ["bad_segment_table"], props: { bad_segment_table: eq(true) } }),
        },
      }),
      obj({ props: { inputs: containing(hasRole("badsegments")) } }),
      obj({ props: { inputs: arr({ also: [not(containing(hasRole("badsegments")))] }) } }),
    ),
  ],
});

const displayFilter = obj({
  req: ["highpass_hz", "order"],
  props: { highpass_hz: num({ exclusiveMin: 0 }), order: eq(2) },
  closed: true,
});
const maxWindow = num({ exclusiveMin: 0, max: 30 });
const decompositionInput = obj({
  req: [
    "source",
    "preprocessing",
    "channels",
    "channel_types",
    "channel_types_sha256",
    "reference",
    "unit",
  ],
  props: {
    source: oneIn("archive", "serving_copy"),
    preprocessing: arr({
      max: 64,
      items: obj({
        req: ["step", "function"],
        props: {
          step: str({ pattern: NAME }),
          function: str({
            max: 128,
            pattern: /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/,
          }),
        },
        closed: true,
      }),
    }),
    channels: arr({ min: 1, max: 1024, unique: true, items: columnName }),
    reference: str({ min: 1, max: 64 }),
    unit: str({ min: 1, max: 32 }),
    store: obj({
      req: ["path", "group", "content_sha256"],
      props: { path: relativeLocation, group: str({ pattern: MONTAGE }), content_sha256: sha256 },
      closed: true,
    }),
    channel_types: arr({
      min: 1,
      max: 4096,
      items: arr({
        min: 2,
        max: 2,
        prefix: [str({ max: 128 }), any(str({ max: 32 }), isNull)],
      }),
    }),
    channel_types_sha256: sha256,
  },
  closed: true,
  also: [
    ifThen(
      obj({ req: ["source"], props: { source: eq("serving_copy") } }),
      req("store"),
      ifObj({ props: { store: absent } }),
    ),
  ],
});
const sourceIs = (source: string): Guard =>
  obj({
    req: ["parameters"],
    props: {
      parameters: obj({
        req: ["decomposition_input"],
        props: { decomposition_input: obj({ req: ["source"], props: { source: eq(source) } }) },
      }),
    },
  });
const signalProfile = (value: string): Guard =>
  obj({
    props: {
      inputs: arr({
        items: ifThen(
          hasRole("signal"),
          obj({ props: { store: obj({ props: { profile: eq(value) } }) } }),
        ),
      }),
    },
  });

const kindIcActivity = obj({
  req: ["base", "base_version", "inputs", "transform", "parameters"],
  props: {
    base: eq("nemar.lines"),
    base_version: eq(1),
    data: absent,
    transform: obj({ req: ["name"], props: { name: eq("nemar.ic-activity.v1") } }),
    inputs: arr({
      items: exactlyOne(
        obj({
          req: ["role", "file"],
          props: {
            role: oneIn("unmixing", "components", "badsegments"),
            file: tsvFile(/\.tsv$/),
          },
        }),
        signalStore,
      ),
      contains: [contained("badsegments", 0, 1)],
    }),
    parameters: obj({
      req: ["display_filter", "max_window_s", "decomposition_input"],
      props: {
        display_filter: displayFilter,
        max_window_s: maxWindow,
        decomposition_input: decompositionInput,
      },
      closed: true,
    }),
  },
  also: [
    ifThen(sourceIs("archive"), signalProfile("archive")),
    ifThen(sourceIs("serving_copy"), signalProfile("serving")),
  ],
});

const badsegmentsFile = all(relativeLocation, str({ pattern: /_badsegments\.tsv$/ }));
const shadedFiles = (files: Guard): Guard =>
  obj({
    req: ["transform"],
    props: {
      transform: obj({
        req: ["parameters"],
        props: {
          parameters: obj({
            req: ["shaded"],
            props: { shaded: obj({ req: ["files"], props: { files } }) },
          }),
        },
      }),
    },
  });
const signalOfProfile = (value: string): Guard =>
  obj({
    req: ["inputs"],
    props: {
      inputs: containing(
        obj({
          req: ["role", "store"],
          props: {
            role: eq("signal"),
            store: obj({ req: ["profile"], props: { profile: eq(value) } }),
          },
        }),
      ),
    },
  });
const matchIs = (value: string): Guard =>
  obj({
    props: { transform: obj({ props: { parameters: obj({ props: { match: eq(value) } }) } }) },
  });
const fileRole = (roles: Guard, pattern: RegExp): Guard =>
  ifThen(
    obj({ req: ["role"], props: { role: roles } }),
    obj({ req: ["file"], props: { file: tsvFile(pattern) } }),
  );

const transformIcActivity = obj({
  req: ["inputs", "transform", "parameters"],
  props: {
    parameters: obj({
      req: ["display_filter", "max_window_s", "decomposition_input"],
      props: {
        display_filter: displayFilter,
        max_window_s: maxWindow,
        decomposition_input: decompositionInput,
      },
    }),
    inputs: arr({
      items: all(
        fileRole(oneIn("unmixing", "components"), /\.tsv$/),
        fileRole(eq("badsegments"), /_badsegments\.tsv$/),
        ifThen(hasRole("signal"), obj({ req: ["store"] })),
      ),
      contains: [
        contained("badsegments", 0, 1),
        contained("unmixing", 1, 1),
        contained("signal", 1, 1),
        contained("components", 1, 1),
      ],
    }),
    transform: obj({
      props: {
        parameters: obj({
          req: [
            "matrix",
            "applies_to",
            "note",
            "match",
            "rows",
            "columns",
            "unit",
            "caption",
            "shaded",
          ],
          props: {
            matrix: relativeLocation,
            applies_to: str({ min: 1, max: 500 }),
            note: str({ min: 1, max: 500 }),
            match: oneIn("store_row", "label"),
            rows: any(arr({ min: 1, max: 1024, unique: true, items: int(0, MAX_SAFE) }), isNull),
            columns: arr({ min: 1, max: 1024, unique: true, items: columnName }),
            unit: oneIn("V", "mV", "uV", "µV", "μV"),
            caption: any(str({ min: 1, max: 500 }), isNull),
            shaded: obj({
              req: ["label", "files"],
              props: {
                label: str({ pattern: NAME }),
                files: any(arr({ min: 1, max: 1, items: badsegmentsFile }), isNull),
              },
              closed: true,
            }),
          },
          closed: true,
          also: [
            ifThen(
              obj({ req: ["match"], props: { match: eq("store_row") } }),
              obj({ props: { rows: (v) => Array.isArray(v) } }),
              obj({ props: { rows: isNull, caption: str() } }),
            ),
          ],
        }),
      },
    }),
  },
  also: [
    ifThen(signalOfProfile("archive"), matchIs("label")),
    ifThen(signalOfProfile("serving"), matchIs("store_row")),
    ifThen(
      shadedFiles((v) => Array.isArray(v)),
      obj({ props: { inputs: containing(hasRole("badsegments")) } }),
    ),
    ifThen(
      shadedFiles(isNull),
      obj({ props: { inputs: arr({ also: [not(containing(hasRole("badsegments")))] }) } }),
    ),
  ],
});

export const COMPUTED_SCHEMAS: ExtraSchemas = {
  kinds: { "nemar.ic-activity": kindIcActivity, "nemar.signal-window": kindSignalWindow },
  transforms: { "nemar.ic-activity.v1": transformIcActivity },
};
