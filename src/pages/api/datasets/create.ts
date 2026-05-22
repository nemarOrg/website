import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth";

// MOCK: removed in Phase 5 cutover. Frontend will call api.nemar.org/datasets
// directly once nemar-cli#572 lands (cookie-aware auth on /datasets routes).
// Real backend creates the GitHub repo, S3 prefix, and presigned URLs; this
// mock just returns a synthesized dataset id and presigned URLs pointing at
// the local upload-stub PUT route so the queue exercises the full XHR path.

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

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
