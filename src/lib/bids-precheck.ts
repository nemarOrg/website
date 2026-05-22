/**
 * Client-side BIDS structure pre-check for the upload flow. Pure helpers,
 * no DOM dependencies. The authoritative check happens server-side via the
 * BIDS validator GitHub Action that `POST /datasets/:id/finalize` deploys.
 *
 * The job here is to catch obviously-broken drops before we waste user time
 * uploading, and to surface enough metadata for a useful pre-upload preview.
 */

export type ModalityCode = "EEG" | "MEG" | "iEEG" | "EMG" | "MRI";

export interface DroppedFileMeta {
  /** Path relative to the drop root, e.g. "sub-01/eeg/sub-01_task-rest_eeg.set". */
  path: string;
  /** Size in bytes; zero is treated as a soft warning. */
  size: number;
  /** Basename, e.g. "sub-01_task-rest_eeg.set". */
  name: string;
}

export interface BidsScanError {
  code:
    | "empty_drop"
    | "no_dataset_description"
    | "no_subjects"
    | "no_modality"
    | "path_traversal"
    | "path_too_long"
    | "file_too_large"
    | "total_size_too_large";
  message: string;
  /** Optional path for file-scoped errors. */
  path?: string;
}

export interface BidsScanWarning {
  code: "missing_readme" | "zero_byte_file" | "non_bids_top_level";
  message: string;
  path?: string;
}

export interface BidsScanResult {
  subjects: string[];
  sessions: string[];
  modalities: ModalityCode[];
  datatypes: string[];
  totalBytes: number;
  fileCount: number;
  hasDatasetDescription: boolean;
  hasReadme: boolean;
  errors: BidsScanError[];
  warnings: BidsScanWarning[];
}

export const MAX_FILE_BYTES = 5 * 1024 ** 3;
export const MAX_DATASET_BYTES = 50 * 1024 ** 3;
export const MAX_PATH_LENGTH = 1024;

const DATATYPE_TO_MODALITY: Record<string, ModalityCode> = {
  eeg: "EEG",
  meg: "MEG",
  ieeg: "iEEG",
  emg: "EMG",
  anat: "MRI",
  func: "MRI",
  dwi: "MRI",
  fmap: "MRI",
  perf: "MRI",
};

const VALID_DATATYPES = new Set(Object.keys(DATATYPE_TO_MODALITY));

export function scanBidsDrop(files: DroppedFileMeta[]): BidsScanResult {
  const errors: BidsScanError[] = [];
  const warnings: BidsScanWarning[] = [];

  if (files.length === 0) {
    errors.push({
      code: "empty_drop",
      message: "Nothing was dropped. Drag a BIDS folder onto the area above.",
    });
    return emptyResult(errors, warnings);
  }

  const subjects = new Set<string>();
  const sessions = new Set<string>();
  const modalities = new Set<ModalityCode>();
  const datatypes = new Set<string>();
  let totalBytes = 0;
  let fileCount = 0;
  let hasDatasetDescription = false;
  let hasReadme = false;

  for (const f of files) {
    if (f.path.includes("..")) {
      errors.push({
        code: "path_traversal",
        message: `Path contains "..": ${f.path}`,
        path: f.path,
      });
      continue;
    }
    if (f.path.length > MAX_PATH_LENGTH) {
      errors.push({
        code: "path_too_long",
        message: `Path exceeds ${MAX_PATH_LENGTH} characters.`,
        path: f.path,
      });
      continue;
    }
    if (f.size > MAX_FILE_BYTES) {
      errors.push({
        code: "file_too_large",
        message: "File exceeds the 5 GB single-PUT cap.",
        path: f.path,
      });
      continue;
    }
    if (f.size === 0) {
      warnings.push({
        code: "zero_byte_file",
        message: "Zero-byte file ignored.",
        path: f.path,
      });
      continue;
    }

    totalBytes += f.size;
    fileCount += 1;

    const parts = f.path.split("/").filter((p) => p.length > 0);

    if (parts.length === 1) {
      if (parts[0] === "dataset_description.json") hasDatasetDescription = true;
      else if (parts[0] === "README" || parts[0] === "README.md" || parts[0] === "README.txt") {
        hasReadme = true;
      } else if (
        parts[0] !== "CHANGES" &&
        parts[0] !== "LICENSE" &&
        !parts[0].endsWith(".tsv") &&
        !parts[0].endsWith(".json")
      ) {
        warnings.push({
          code: "non_bids_top_level",
          message: "Top-level file does not look BIDS-shaped.",
          path: f.path,
        });
      }
      continue;
    }

    const sub = parts[0];
    if (!sub.startsWith("sub-") || sub.length <= 4) {
      continue;
    }
    subjects.add(sub);

    let datatypeIndex = 1;
    if (parts[1]?.startsWith("ses-") && parts[1].length > 4) {
      sessions.add(parts[1]);
      datatypeIndex = 2;
    }

    const dt = parts[datatypeIndex];
    if (dt && VALID_DATATYPES.has(dt)) {
      datatypes.add(dt);
      const mod = DATATYPE_TO_MODALITY[dt];
      if (mod) modalities.add(mod);
    }
  }

  if (totalBytes > MAX_DATASET_BYTES) {
    errors.push({
      code: "total_size_too_large",
      message: "Dataset exceeds the 50 GB upload cap. Trim or split before uploading.",
    });
  }

  if (!hasDatasetDescription) {
    errors.push({
      code: "no_dataset_description",
      message: "A BIDS dataset must include dataset_description.json at the root.",
    });
  }

  if (subjects.size === 0) {
    errors.push({
      code: "no_subjects",
      message: "No sub-* directories found. BIDS datasets need at least one subject.",
    });
  }

  if (modalities.size === 0) {
    errors.push({
      code: "no_modality",
      message:
        "No recognizable modality datatype found (expected one of: eeg, meg, ieeg, emg, anat, func, dwi, fmap, perf).",
    });
  }

  if (!hasReadme && errors.length === 0) {
    warnings.push({
      code: "missing_readme",
      message: "Consider adding a README describing the dataset.",
    });
  }

  return {
    subjects: [...subjects].sort(),
    sessions: [...sessions].sort(),
    modalities: [...modalities].sort(),
    datatypes: [...datatypes].sort(),
    totalBytes,
    fileCount,
    hasDatasetDescription,
    hasReadme,
    errors,
    warnings,
  };
}

function emptyResult(errors: BidsScanError[], warnings: BidsScanWarning[]): BidsScanResult {
  return {
    subjects: [],
    sessions: [],
    modalities: [],
    datatypes: [],
    totalBytes: 0,
    fileCount: 0,
    hasDatasetDescription: false,
    hasReadme: false,
    errors,
    warnings,
  };
}

export function detectModalityFromPath(bidsPath: string): ModalityCode | null {
  const parts = bidsPath.split("/").filter((p) => p.length > 0);
  for (const p of parts) {
    const m = DATATYPE_TO_MODALITY[p];
    if (m) return m;
  }
  return null;
}

export function detectDatatypeFromPath(bidsPath: string): string | null {
  const parts = bidsPath.split("/").filter((p) => p.length > 0);
  for (const p of parts) {
    if (VALID_DATATYPES.has(p)) return p;
  }
  return null;
}

export interface DatasetDescriptionValidation {
  ok: boolean;
  parsed?: { Name?: string; BIDSVersion?: string; Authors?: string[]; License?: string };
  errors: string[];
  warnings: string[];
}

export function validateDatasetDescription(text: string): DatasetDescriptionValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      errors: [`dataset_description.json is not valid JSON: ${(err as Error).message}`],
      warnings,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: ["dataset_description.json must be a JSON object."],
      warnings,
    };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.Name !== "string" || obj.Name.trim().length === 0) {
    errors.push("Name (required) is missing or empty.");
  }
  if (typeof obj.BIDSVersion !== "string" || obj.BIDSVersion.trim().length === 0) {
    errors.push("BIDSVersion (required) is missing or empty.");
  }
  if (!Array.isArray(obj.Authors) || obj.Authors.length === 0) {
    warnings.push("Authors is recommended.");
  }
  return {
    ok: errors.length === 0,
    parsed: {
      Name: typeof obj.Name === "string" ? obj.Name : undefined,
      BIDSVersion: typeof obj.BIDSVersion === "string" ? obj.BIDSVersion : undefined,
      Authors: Array.isArray(obj.Authors)
        ? (obj.Authors.filter((a) => typeof a === "string") as string[])
        : undefined,
      License: typeof obj.License === "string" ? obj.License : undefined,
    },
    errors,
    warnings,
  };
}
