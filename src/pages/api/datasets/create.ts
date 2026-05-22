import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth";
import type { Dataset } from "../../../lib/types";
import { appendDraft } from "./_store";

// MOCK: removed in Phase 5 cutover. Frontend will call api.nemar.org/datasets
// directly once nemar-cli#572 lands (cookie-aware auth on /datasets routes).
// Real backend creates the GitHub repo, S3 prefix, and presigned URLs; this
// mock just returns a synthesized dataset id and presigned URLs pointing at
// the local upload-stub PUT route so the queue exercises the full XHR path.
// The created dataset is also recorded in the in-memory store so the
// dashboard at /dashboard reflects it immediately during the same dev session.

interface CreateRequest {
  name?: unknown;
  description?: unknown;
  files?: unknown;
}

interface DraftFile {
  path: string;
  size: number;
}

export const POST: APIRoute = async ({ request, locals }) => {
  if (!import.meta.env.DEV) {
    return json({ ok: false, error: "not_implemented" }, 501);
  }

  // CSRF: the session cookie is SameSite=Lax (issued in Phase 1), which blocks
  // cross-site form POSTs. A `Content-Type: application/json` requirement
  // additionally forces a CORS preflight for cross-origin scripts, which
  // unauthorized origins cannot satisfy.
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return json({ ok: false, error: "bad_content_type" }, 415);
  }

  const session = getSession(locals);
  if (!session) return json({ ok: false, error: "unauthenticated" }, 401);

  let body: CreateRequest;
  try {
    body = (await request.json()) as CreateRequest;
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 200) {
    return json({ ok: false, error: "invalid_name" }, 400);
  }
  const description = typeof body.description === "string" ? body.description : "";
  const files = parseFiles(body.files);
  if (!files) return json({ ok: false, error: "invalid_files" }, 400);
  if (files.length === 0) return json({ ok: false, error: "empty_files" }, 400);

  const id = `nm-mock-${Math.random().toString(36).slice(2, 10)}`;
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const upload_urls: Record<string, string> = {};
  for (const f of files) {
    upload_urls[f.path] =
      `${origin}/api/datasets/upload-stub/${encodeURIComponent(id)}/${encodePathSegments(f.path)}`;
  }

  console.info(
    `[datasets/mock] created draft ${id} with ${files.length} file(s) for ${session.user.email}`,
  );

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  const nowIso = new Date().toISOString();
  const username = session.user.email.split("@")[0] ?? "researcher";
  const draftRecord: Dataset = {
    dataset_id: id,
    id,
    name,
    description: description || null,
    status: "active",
    visibility: "private",
    github_repo: `nemarDatasets/${id}`,
    concept_doi: null,
    doi: null,
    created_at: nowIso,
    updated_at: nowIso,
    owner_username: username,
    nemar_sync_status: null,
    source: "managed",
    source_type: "managed",
    source_id: null,
    modalities: "",
    participants: 0,
    tasks: "",
    authors: username,
    file_size: totalBytes,
    file_size_formatted: formatBytes(totalBytes),
    latest_version: null,
  };
  appendDraft(session.user.email, draftRecord);

  return json(
    {
      dataset: {
        id,
        dataset_id: id,
        name,
        description,
        visibility: "private",
        owner_email: session.user.email,
        github_repo: `nemarDatasets/${id}`,
        github_url: `https://github.com/nemarDatasets/${id}`,
        s3_prefix: id,
      },
      upload_urls,
      s3_config: {
        bucket: "nemar-mock",
        region: "us-west-2",
        public_url: `${origin}/api/datasets/upload-stub`,
      },
    },
    201,
  );
};

function parseFiles(raw: unknown): DraftFile[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DraftFile[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const path = (item as { path?: unknown }).path;
    const size = (item as { size?: unknown }).size;
    if (typeof path !== "string" || path.length === 0) return null;
    if (typeof size !== "number" || size < 0 || !Number.isFinite(size)) return null;
    out.push({ path, size });
  }
  return out;
}

function encodePathSegments(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function formatBytes(n: number): string {
  if (n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
