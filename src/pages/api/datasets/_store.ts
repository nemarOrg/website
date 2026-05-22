// MOCK: removed in Phase 5 cutover (nemar-cli#572 + #575).
// Shared in-memory store backing the dashboard's list / publish-request /
// delete mock routes and the upload flow's create mock. The state resets
// with every dev server restart, which is fine for dev usage.
//
// Note: under `astro dev`, modules are cached per Vite reload, so the Map
// survives HMR'd page reloads. Under `wrangler pages dev` each worker
// invocation may use a fresh module instance; in DEV that's still OK
// because the fixture is deterministically seeded by email hash.

import type { Dataset } from "../../../lib/types";

export type PublishStatusState = "none" | "requested" | "approved" | "blocked";

export interface PublicationStatus {
  readonly dataset_id: string;
  readonly status: PublishStatusState;
  readonly requested_at?: string;
  readonly approved_at?: string;
  readonly denied_at?: string;
  readonly block_reason?: string;
  readonly requested_by?: string;
  readonly ci_url?: string;
}

interface OwnerEntry {
  datasets: Dataset[];
  publishStatusByDatasetId: Map<string, PublicationStatus>;
}

const store = new Map<string, OwnerEntry>();

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

function seedDatasets(email: string): { datasets: Dataset[]; statuses: PublicationStatus[] } {
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
      status: "approved",
      requested_at: days(30),
      approved_at: days(14),
      requested_by: email,
    },
  ];

  return { datasets: [draft, awaiting, published], statuses };
}

function ensureEntry(email: string): OwnerEntry {
  const k = emailKey(email);
  let entry = store.get(k);
  if (!entry) {
    const { datasets, statuses } = seedDatasets(email);
    const map = new Map<string, PublicationStatus>();
    for (const s of statuses) map.set(s.dataset_id, s);
    entry = { datasets, publishStatusByDatasetId: map };
    store.set(k, entry);
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
  const entry = ensureEntry(email);
  return entry.datasets.find((d) => d.dataset_id === id);
}

export function getPublishStatus(email: string, id: string): PublicationStatus | undefined {
  return ensureEntry(email).publishStatusByDatasetId.get(id);
}

export function setPublishStatus(email: string, status: PublicationStatus): void {
  ensureEntry(email).publishStatusByDatasetId.set(status.dataset_id, status);
}

export function removeForOwner(email: string, id: string): boolean {
  const entry = ensureEntry(email);
  const idx = entry.datasets.findIndex((d) => d.dataset_id === id);
  if (idx === -1) return false;
  entry.datasets.splice(idx, 1);
  entry.publishStatusByDatasetId.delete(id);
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
