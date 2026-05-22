// MOCK: replaced when nemar-cli#572 (cookie-aware auth on /datasets and
// /admin), #575 (owner-callable delete-draft), #577 (collaborator remove),
// and #578 (invite by email) land. Shared in-memory store backing every
// dashboard mock route (list / publish-request / delete / collaborators /
// admin publication-requests) and the upload flow's create mock.
//
// A single module-scoped Map is sufficient because both `astro dev` and
// `wrangler pages dev` run in one process; there is no cross-worker shared
// state requirement that would need KV or D1. Under `astro dev` the Map
// survives HMR. Under `wrangler pages dev` it can reset per Worker
// invocation, but the deterministic email-hash seed keeps reads idempotent.

import type { PublicationStatus } from "../../../lib/dashboard-api";
import type { Dataset } from "../../../lib/types";

export interface Collaborator {
  readonly username: string;
  readonly github_username: string;
  readonly access_type: "invited" | "requested";
  readonly granted_at: string;
  readonly granted_by_username: string;
}

interface OwnerEntry {
  // Intentionally mutable: helpers below splice/unshift/set against these
  // collections in place.
  datasets: Dataset[];
  publishStatusByDatasetId: Map<string, PublicationStatus>;
  collaboratorsByDatasetId: Map<string, Collaborator[]>;
}

/**
 * Cross-owner index of every publication request the admin surface needs to
 * see. Mirrors mutations made through {@link setPublishStatus} so the admin
 * route can list across owners without scanning every {@link OwnerEntry}.
 */
interface PublicationRequestRecord {
  readonly ownerEmail: string;
  readonly datasetId: string;
  readonly datasetName: string;
  status: PublicationStatus;
}

const store = new Map<string, OwnerEntry>();
const publicationRequestsByDatasetId = new Map<string, PublicationRequestRecord>();

function emailKey(email: string): string {
  return email.trim().toLowerCase();
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Three datasets, one per renderable publish-state, so the dashboard
 * exercises every card variant on first load without manual setup. The
 * second dataset's "requested" status doubles as a fixture for the admin
 * publication-review surface.
 */
function seedDatasets(email: string): {
  datasets: Dataset[];
  statuses: PublicationStatus[];
  collaborators: Map<string, Collaborator[]>;
} {
  const h = hash32(emailKey(email));
  const username = email.split("@")[0] ?? "researcher";
  const now = Date.now();
  const days = (n: number) => new Date(now - n * 86_400_000).toISOString();
  const id = (suffix: string) => `nm-mock-${(h % 1_000_000).toString(36)}-${suffix}`;

  const draft: Dataset = {
    dataset_id: id("a"),
    id: id("a"),
    name: "Resting-state EEG pilot",
    description: "Pilot recordings from the lab's new 64-channel cap.",
    status: "active",
    visibility: "private",
    github_repo: `nemarDatasets/${id("a")}`,
    concept_doi: null,
    doi: null,
    created_at: days(2),
    updated_at: days(0),
    owner_username: username,
    nemar_sync_status: null,
    source: "managed",
    source_type: "managed",
    source_id: null,
    modalities: "EEG",
    participants: 8,
    tasks: "rest",
    authors: username,
    file_size: 1_200_000_000,
    file_size_formatted: "1.2 GB",
    latest_version: null,
  };

  const awaiting: Dataset = {
    dataset_id: id("b"),
    id: id("b"),
    name: "Auditory oddball MEG",
    description: "Whole-head MEG during an auditory oddball paradigm.",
    status: "active",
    visibility: "private",
    github_repo: `nemarDatasets/${id("b")}`,
    concept_doi: null,
    doi: null,
    created_at: days(14),
    updated_at: days(3),
    owner_username: username,
    nemar_sync_status: null,
    source: "managed",
    source_type: "managed",
    source_id: null,
    modalities: "MEG",
    participants: 24,
    tasks: "auditory-oddball",
    authors: username,
    file_size: 18_000_000_000,
    file_size_formatted: "18 GB",
    latest_version: null,
  };

  const published: Dataset = {
    dataset_id: id("c"),
    id: id("c"),
    name: "iEEG sleep dataset",
    description: "Intracranial EEG recordings across the sleep-wake transition.",
    status: "active",
    visibility: "public",
    github_repo: `nemarDatasets/${id("c")}`,
    concept_doi: "10.18112/openneuro.mock.v1",
    doi: "10.18112/openneuro.mock.v1",
    created_at: days(90),
    updated_at: days(7),
    owner_username: username,
    nemar_sync_status: null,
    source: "managed",
    source_type: "managed",
    source_id: null,
    modalities: "iEEG",
    participants: 12,
    tasks: "sleep",
    authors: username,
    file_size: 42_000_000_000,
    file_size_formatted: "42 GB",
    latest_version: "1.0.0",
  };

  const statuses: PublicationStatus[] = [
    { dataset_id: draft.dataset_id, status: "none" },
    {
      dataset_id: awaiting.dataset_id,
      status: "requested",
      requested_at: days(2),
      requested_by: email,
    },
    {
      dataset_id: published.dataset_id,
      status: "published",
      requested_at: days(30),
      approved_at: days(20),
      published_at: days(14),
      requested_by: email,
    },
  ];

  // The second dataset gets one seeded collaborator so the dashboard's
  // "Manage collaborators" page has something to display on first load.
  const collaborators = new Map<string, Collaborator[]>();
  collaborators.set(awaiting.dataset_id, [
    {
      username: "labmate",
      github_username: "labmate",
      access_type: "invited",
      granted_at: days(10),
      granted_by_username: username,
    },
  ]);

  return { datasets: [draft, awaiting, published], statuses, collaborators };
}

function ensureEntry(email: string): OwnerEntry {
  const k = emailKey(email);
  let entry = store.get(k);
  if (!entry) {
    const { datasets, statuses, collaborators } = seedDatasets(email);
    const statusMap = new Map<string, PublicationStatus>();
    for (const s of statuses) statusMap.set(s.dataset_id, s);
    entry = {
      datasets,
      publishStatusByDatasetId: statusMap,
      collaboratorsByDatasetId: collaborators,
    };
    store.set(k, entry);
    // Mirror the seed into the cross-owner index so admin surfaces see it.
    for (const d of datasets) {
      const status = statusMap.get(d.dataset_id);
      if (status && status.status !== "none") {
        publicationRequestsByDatasetId.set(d.dataset_id, {
          ownerEmail: email,
          datasetId: d.dataset_id,
          datasetName: d.name,
          status,
        });
      }
    }
  }
  return entry;
}

export function listForOwner(
  email: string,
  opts: { limit?: number; offset?: number } = {},
): { datasets: Dataset[]; total: number } {
  const entry = ensureEntry(email);
  const sorted = entry.datasets.slice().sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? 50);
  return {
    datasets: sorted.slice(offset, offset + limit),
    total: sorted.length,
  };
}

export function findForOwner(email: string, id: string): Dataset | undefined {
  return ensureEntry(email).datasets.find((d) => d.dataset_id === id);
}

export function findDatasetAnyOwner(
  id: string,
): { dataset: Dataset; ownerEmail: string } | undefined {
  for (const [k, entry] of store) {
    const dataset = entry.datasets.find((d) => d.dataset_id === id);
    if (dataset) return { dataset, ownerEmail: k };
  }
  return undefined;
}

export function getPublishStatus(email: string, id: string): PublicationStatus | undefined {
  return ensureEntry(email).publishStatusByDatasetId.get(id);
}

export function setPublishStatus(email: string, status: PublicationStatus): void {
  const entry = ensureEntry(email);
  entry.publishStatusByDatasetId.set(status.dataset_id, status);
  const dataset = entry.datasets.find((d) => d.dataset_id === status.dataset_id);
  if (!dataset) return;
  if (status.status === "none") {
    publicationRequestsByDatasetId.delete(status.dataset_id);
    return;
  }
  publicationRequestsByDatasetId.set(status.dataset_id, {
    ownerEmail: email,
    datasetId: status.dataset_id,
    datasetName: dataset.name,
    status,
  });
}

export function removeForOwner(email: string, id: string): boolean {
  const entry = ensureEntry(email);
  const idx = entry.datasets.findIndex((d) => d.dataset_id === id);
  if (idx === -1) return false;
  entry.datasets.splice(idx, 1);
  entry.publishStatusByDatasetId.delete(id);
  entry.collaboratorsByDatasetId.delete(id);
  publicationRequestsByDatasetId.delete(id);
  return true;
}

export function appendDraft(email: string, draft: Dataset): void {
  const entry = ensureEntry(email);
  if (entry.datasets.some((d) => d.dataset_id === draft.dataset_id)) return;
  entry.datasets.unshift(draft);
  entry.publishStatusByDatasetId.set(draft.dataset_id, {
    dataset_id: draft.dataset_id,
    status: "none",
  });
}

// --- Collaborators ----------------------------------------------------------

export function listCollaboratorsForDataset(email: string, datasetId: string): Collaborator[] {
  return ensureEntry(email).collaboratorsByDatasetId.get(datasetId) ?? [];
}

export function addCollaboratorForDataset(
  ownerEmail: string,
  datasetId: string,
  collaborator: Collaborator,
): { ok: true } | { ok: false; reason: "duplicate" | "self" } {
  const owner = ownerEmail.split("@")[0] ?? "";
  if (collaborator.username === owner) return { ok: false, reason: "self" };
  const entry = ensureEntry(ownerEmail);
  const existing = entry.collaboratorsByDatasetId.get(datasetId) ?? [];
  if (existing.some((c) => c.username === collaborator.username)) {
    return { ok: false, reason: "duplicate" };
  }
  entry.collaboratorsByDatasetId.set(datasetId, [...existing, collaborator]);
  return { ok: true };
}

// --- Cross-owner publication requests (admin view) --------------------------

export function listAllPublicationRequests(filter?: {
  status?: PublicationStatus["status"];
}): PublicationRequestRecord[] {
  // Touch every owner so seeded data is materialized before the admin scans.
  // Without this, an admin signing in fresh (no other owners have hit the
  // store yet) would see an empty list.
  for (const entry of store.values()) void entry;
  const items = Array.from(publicationRequestsByDatasetId.values());
  if (filter?.status) {
    return items.filter((r) => r.status.status === filter.status);
  }
  return items.sort((a, b) => {
    const aReq = "requested_at" in a.status ? a.status.requested_at : "";
    const bReq = "requested_at" in b.status ? b.status.requested_at : "";
    return bReq.localeCompare(aReq);
  });
}

export function getPublicationRequestRecord(
  datasetId: string,
): PublicationRequestRecord | undefined {
  return publicationRequestsByDatasetId.get(datasetId);
}

/**
 * Applies the result of an admin approve action to the underlying dataset
 * and the cross-owner index. The real backend runs a 17-step orchestrator;
 * the mock collapses it into a single transition.
 */
export function applyAdminApprove(datasetId: string): { ok: true } | { ok: false; reason: string } {
  const record = publicationRequestsByDatasetId.get(datasetId);
  if (!record) return { ok: false, reason: "not_found" };
  if (record.status.status !== "requested") {
    return { ok: false, reason: `not_in_requested_state (${record.status.status})` };
  }
  const entry = ensureEntry(record.ownerEmail);
  const dataset = entry.datasets.find((d) => d.dataset_id === datasetId);
  if (!dataset) return { ok: false, reason: "dataset_missing" };
  const now = new Date().toISOString();
  const fakeDoi = `10.18112/nemar-mock.${datasetId}.v1`;
  const updated: Dataset = {
    ...dataset,
    visibility: "public",
    concept_doi: fakeDoi,
    doi: fakeDoi,
    latest_version: "1.0.0",
    updated_at: now,
  };
  const idx = entry.datasets.findIndex((d) => d.dataset_id === datasetId);
  entry.datasets[idx] = updated;
  const next: PublicationStatus = {
    dataset_id: datasetId,
    status: "published",
    requested_at: record.status.requested_at,
    approved_at: now,
    published_at: now,
    requested_by: "requested_by" in record.status ? record.status.requested_by : undefined,
  };
  entry.publishStatusByDatasetId.set(datasetId, next);
  publicationRequestsByDatasetId.set(datasetId, { ...record, status: next });
  return { ok: true };
}

export function applyAdminDeny(
  datasetId: string,
  reason: string,
): { ok: true } | { ok: false; reason: string } {
  const record = publicationRequestsByDatasetId.get(datasetId);
  if (!record) return { ok: false, reason: "not_found" };
  if (record.status.status !== "requested") {
    return { ok: false, reason: `not_in_requested_state (${record.status.status})` };
  }
  const entry = ensureEntry(record.ownerEmail);
  const now = new Date().toISOString();
  const next: PublicationStatus = {
    dataset_id: datasetId,
    status: "denied",
    requested_at: record.status.requested_at,
    denied_at: now,
    denied_reason: reason,
    requested_by: "requested_by" in record.status ? record.status.requested_by : undefined,
  };
  entry.publishStatusByDatasetId.set(datasetId, next);
  publicationRequestsByDatasetId.set(datasetId, { ...record, status: next });
  return { ok: true };
}
