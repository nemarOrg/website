/**
 * Client-side BIDS structure pre-check for the upload flow. Pure helpers,
 * no DOM dependencies. The job here is to catch obviously-broken drops
 * before we waste user time uploading; the authoritative check is the
 * server-side BIDS validator triggered after finalization.
 */

export type BidsModalityCode = "EEG" | "MEG" | "iEEG" | "EMG" | "MRI";

export interface DroppedFileMeta {
  /** Path relative to the BIDS root, e.g. "sub-01/eeg/sub-01_task-rest_eeg.set". */
  readonly path: string;
  /** Size in bytes; zero is treated as a soft warning. */
  readonly size: number;
}

export interface BidsScanError {
  readonly code:
    | "empty_drop"
    | "no_dataset_description"
    | "invalid_dataset_description"
    | "no_subjects"
    | "no_modality"
    | "path_traversal"
    | "path_too_long"
    | "file_too_large"
    | "total_size_too_large";
  readonly message: string;
  /** Optional path for file-scoped errors. */
  readonly path?: string;
}

export interface BidsScanWarning {
  readonly code:
    | "missing_readme"
    | "zero_byte_file"
    | "non_bids_top_level"
    | "dataset_description_warning";
  readonly message: string;
  readonly path?: string;
}

export interface BidsScanResult {
  readonly subjects: readonly string[];
  readonly sessions: readonly string[];
  readonly modalities: readonly BidsModalityCode[];
  readonly datatypes: readonly string[];
  readonly totalBytes: number;
  readonly fileCount: number;
  readonly hasDatasetDescription: boolean;
  readonly hasReadme: boolean;
  readonly errors: readonly BidsScanError[];
  readonly warnings: readonly BidsScanWarning[];
}

// 5 GB: S3 single-PUT maximum. Multipart required above this (nemar-cli#573).
export const MAX_FILE_BYTES = 5 * 1024 ** 3;
// 50 GB: soft frontend cap to keep the drop-zone responsive on slow networks.
export const MAX_DATASET_BYTES = 50 * 1024 ** 3;
// 1024 chars: the S3 object key length cap (UTF-8 bytes; we approximate via .length).
export const MAX_PATH_LENGTH = 1024;

const DATATYPE_TO_MODALITY: Record<string, BidsModalityCode> = {
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

export function scanBidsDrop(files: readonly DroppedFileMeta[]): BidsScanResult {
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
  const modalities = new Set<BidsModalityCode>();
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

export function detectModalityFromPath(bidsPath: string): BidsModalityCode | null {
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

interface ParsedDatasetDescription {
  readonly Name: string;
  readonly BIDSVersion: string;
  readonly Authors?: readonly string[];
  readonly License?: string;
}

interface PartialDatasetDescription {
  readonly Name?: string;
  readonly BIDSVersion?: string;
  readonly Authors?: readonly string[];
  readonly License?: string;
}

export type DatasetDescriptionValidation =
  | {
      readonly ok: true;
      readonly parsed: ParsedDatasetDescription;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly parsed?: PartialDatasetDescription;
      readonly errors: readonly string[];
      readonly warnings: readonly string[];
    };

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

  const nameOk = typeof obj.Name === "string" && obj.Name.trim().length > 0;
  if (!nameOk) errors.push("Name (required) is missing or empty.");

  const bidsVersionOk = typeof obj.BIDSVersion === "string" && obj.BIDSVersion.trim().length > 0;
  if (!bidsVersionOk) errors.push("BIDSVersion (required) is missing or empty.");

  const authorsArrayOk = Array.isArray(obj.Authors) && obj.Authors.length > 0;
  if (!authorsArrayOk) {
    if (obj.Authors !== undefined && !Array.isArray(obj.Authors)) {
      warnings.push("Authors should be a JSON array of strings.");
    } else {
      warnings.push("Authors is recommended.");
    }
  }

  const partial: PartialDatasetDescription = {
    Name: typeof obj.Name === "string" ? obj.Name : undefined,
    BIDSVersion: typeof obj.BIDSVersion === "string" ? obj.BIDSVersion : undefined,
    Authors: Array.isArray(obj.Authors)
      ? (obj.Authors.filter((a) => typeof a === "string") as string[])
      : undefined,
    License: typeof obj.License === "string" ? obj.License : undefined,
  };

  if (errors.length === 0) {
    return {
      ok: true,
      parsed: {
        Name: partial.Name as string,
        BIDSVersion: partial.BIDSVersion as string,
        Authors: partial.Authors,
        License: partial.License,
      },
      warnings,
    };
  }
  return { ok: false, parsed: partial, errors, warnings };
}
