/**
 * The real recordings of test/fixtures/ieeg-channel-names (SOURCES.json names dataset, version,
 * path, URL and SHA-256 of every file), read through the module's own resolver over a reader on
 * the committed files. Shared by the channel-match and provenance tests.
 *
 * Not a `.test.ts` file, so Vitest does not collect it.
 */

import { storeRelPath } from "../src/lib/zarr-base";
import {
  type GeometryInput,
  type RecordingGeometry,
  type SpaceGeometry,
  resolveRecordingGeometry,
} from "../src/lib/ieeg-spatial/geometry";
import { nodeFs, repoPath } from "./node";

const fs = await nodeFs();
const FIX = "test/fixtures/ieeg-channel-names";

export interface Case {
  id: string;
  version: string;
  recording: string;
}

export const CASES: Record<string, Case> = {
  "on005415-72": {
    id: "on005415",
    version: "v1.0.0",
    recording: "sub-72/ieeg/sub-72_task-numbers_run-1_ieeg.edf",
  },
  "on005415-86": {
    id: "on005415",
    version: "v1.0.0",
    recording: "sub-86/ieeg/sub-86_task-numbers_run-1_ieeg.edf",
  },
  nm000379: {
    id: "nm000379",
    version: "v1.0.2",
    recording: "sub-01/ieeg/sub-01_task-scenerecognition_run-01_ieeg.vhdr",
  },
  on004551: {
    id: "on004551",
    version: "v1.0.0",
    recording: "sub-001/ses-01/ieeg/sub-001_ses-01_task-sleep_run-01_ieeg.edf",
  },
  on005007: {
    id: "on005007",
    version: "v1.0.0",
    recording: "sub-01/ses-01/ieeg/sub-01_ses-01_task-namingtask_run-01_ieeg.edf",
  },
  on004473: {
    id: "on004473",
    version: "v1.0.0",
    recording: "sub-1/ieeg/sub-1_task-SlowFast_ieeg.edf",
  },
  on004194: {
    id: "on004194",
    version: "v1.0.0",
    recording:
      "sub-p09/ses-nyuecog01/ieeg/sub-p09_ses-nyuecog01_task-temporalpattern_acq-clinical_run-03_ieeg.vhdr",
  },
  on003848: {
    id: "on003848",
    version: "v1.0.0",
    recording: "sub-RESP0800/ses-1/ieeg/sub-RESP0800_ses-1_task-Sleep_run-090523_ieeg.vhdr",
  },
  on006233: {
    id: "on006233",
    version: "v1.0.0",
    recording: "sub-007/ses-1/ieeg/sub-007_ses-1_task-picture_ieeg.edf",
  },
  on005931: {
    id: "on005931",
    version: "v1.0.0",
    recording: "sub-01/ses-01/ieeg/sub-01_ses-01_task-game_run-01_ieeg.edf",
  },
  on007118: {
    id: "on007118",
    version: "v1.0.0",
    recording: "sub-001/ses-01/ieeg/sub-001_ses-01_task-sleep_acq-A_run-01_ieeg.edf",
  },
  on003374: {
    id: "on003374",
    version: "v1.0.0",
    recording: "sub-01/ses-01/ieeg/sub-01_ses-01_task-jokeit_run-01_ieeg.edf",
  },
  nm000454: {
    id: "nm000454",
    version: "v1.0.2",
    recording:
      "sub-PID02/ses-clinical01/ieeg/sub-PID02_ses-clinical01_task-ictal10046_run-04_ieeg.edf",
  },
  nm000463: {
    id: "nm000463",
    version: "v1.0.2",
    recording: "sub-UMHS0028/ieeg/sub-UMHS0028_task-background_ieeg.vhdr",
  },
  nm000360: {
    id: "nm000360",
    version: "v1.0.2",
    recording: "sub-01/ieeg/sub-01_task-sleep_ieeg.edf",
  },
  nm000377: {
    id: "nm000377",
    version: "v1.0.2",
    recording: "sub-EC192/ieeg/sub-EC192_task-heights_ieeg.vhdr",
  },
  nm000436: {
    id: "nm000436",
    version: "v1.0.2",
    recording: "sub-02/ieeg/sub-02_task-taps_acq-off_run-01_ieeg.vhdr",
  },
  on004624: {
    id: "on004624",
    version: "v1.0.0",
    recording:
      "sub-c04/ses-Longterm/ieeg/sub-c04_ses-Longterm_task-Stimulation_acq-rec_run-9_ieeg.mefd",
  },
  on006136: {
    id: "on006136",
    version: "v1.0.0",
    recording: "sub-MU1/ieeg/sub-MU1_task-OWM_ieeg.edf",
  },
  on005670: {
    id: "on005670",
    version: "v1.0.0",
    recording: "sub-01/ieeg/sub-01_task-rest_ieeg.edf",
  },
  nm000373: {
    id: "nm000373",
    version: "v1.0.2",
    recording: "sub-08/ieeg/sub-08_task-random_run-1_ieeg.edf",
  },
  on005522: {
    id: "on005522",
    version: "v1.0.0",
    recording: "sub-R1001P/ses-0/ieeg/sub-R1001P_ses-0_task-YC1_acq-bipolar_ieeg.edf",
  },
  nm000376: {
    id: "nm000376",
    version: "v1.0.2",
    recording: "sub-P1/ieeg/sub-P1_task-memact_ieeg.vhdr",
  },
  on005953: {
    id: "on005953",
    version: "v1.0.0",
    recording: "sub-01/ses-01/ieeg/sub-01_ses-01_task-visual_run-01_ieeg.vhdr",
  },
};

type Reader = Pick<GeometryInput, "listDir" | "readText">;

export function treeReader(c: Case): Reader {
  const at = (rel: string) => repoPath(`${FIX}/${c.id}/${c.version}/${rel}`);
  return {
    listDir: async (path) => {
      const file = at(path === "" ? "__listing.json" : `${path}/__listing.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    },
    readText: async (path) => (fs.existsSync(at(path)) ? fs.readFileSync(at(path), "utf8") : null),
  };
}

export interface Loaded {
  case: Case;
  /** Every space the recording offers. */
  geometry: RecordingGeometry;
  /** The first shown space. */
  space: SpaceGeometry;
  /** The Zarr store's channel labels, in row order. */
  labels: string[];
  /** Their channel_type, same order. */
  types: string[];
}

/** The first shown space of the recording and the Zarr channel labels of its first group. */
export async function load(key: string): Promise<Loaded> {
  const c = CASES[key];
  const geometry = await resolveRecordingGeometry({
    datasetId: c.id,
    version: c.version,
    recording: c.recording,
    ...treeReader(c),
  });
  const space = geometry.spaces.find((s) => s.reason === null);
  if (!space) throw new Error(`${key}: no shown space (${geometry.reason})`);
  const rel = storeRelPath(c.recording);
  const slash = rel.lastIndexOf("/");
  const dir = repoPath(`${FIX}/${c.id}/${c.version}/zarr-labels/${rel.slice(0, slash)}`);
  const prefix = `${rel.slice(slash + 1)}.`;
  const file = fs.readdirSync(dir).find((f) => f.startsWith(prefix));
  if (!file) throw new Error(`${key}: no label file for ${rel}`);
  const doc = JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8")) as {
    channels: { label: string; channel_type: string }[];
  };
  return {
    case: c,
    geometry,
    space,
    labels: doc.channels.map((x) => x.label),
    types: doc.channels.map((x) => x.channel_type),
  };
}
