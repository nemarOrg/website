/**
 * News wire client: the public read path and the admin CRUD behind
 * `/admin/news` (nemarOrg/nemar-cli#1551).
 *
 * - `GET /news`, `GET /news/:slug`, `GET /news/media/:file` are public and
 *   read server-side, always against {@link apiBase}: an anonymous request
 *   has no cookie, so the `dashboardApiBase` heuristic would hand back the
 *   relative `/api/v1`, which a server cannot fetch (the trap `notices-api.ts`
 *   documents).
 * - `/admin/news*` goes through the same-origin `/api/v1` proxy from the
 *   browser, or straight to the API with the admin's cookie during SSR.
 *
 * Shapes and parsing live in `news.ts`.
 */
import { apiBase, dashboardApiBase, readError } from "./api-base";
import { DashboardApiError } from "./dashboard-api";
import {
  type NewsInput,
  type NewsPost,
  type NewsPostSummary,
  parseAdminNewsList,
  parseNewsList,
  parseNewsPost,
} from "./news";
import { resolveSignal } from "./request-deadline";

type Init = {
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
  readonly cookieHeader?: string;
  readonly timeoutMs?: number;
  /** Explicit API origin; the public reads default to {@link apiBase}. */
  readonly baseUrl?: string;
};

function headersFor(init: Init, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (contentType) headers["Content-Type"] = contentType;
  if (init.cookieHeader) headers.Cookie = init.cookieHeader;
  return headers;
}

/** Admin calls: the cookie heuristic, as every other authenticated client uses. */
function adminBase(init: Init): string {
  return init.baseUrl ?? dashboardApiBase(init.cookieHeader);
}

async function failure(res: Response, action: string): Promise<DashboardApiError> {
  const detail = await readError(res);
  return new DashboardApiError(
    `Could not ${action}: ${detail.message ?? detail.code ?? res.statusText}`,
    res.status,
    detail.code,
  );
}

export interface NewsListPage {
  readonly posts: readonly NewsPostSummary[];
  /** The server's count of public posts, for pagination. */
  readonly totalCount: number;
}

/**
 * One page of public posts, newest first.
 *
 * Throws on a failed request so each caller chooses its own degradation: the
 * landing column hides itself, while `/news` says the list could not load.
 */
export async function listNews(
  query: { readonly limit?: number; readonly offset?: number } = {},
  init: Init = {},
): Promise<NewsListPage> {
  const fetchImpl = init.fetch ?? fetch;
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const qs = params.toString();
  const res = await fetchImpl(`${init.baseUrl ?? apiBase()}/news${qs ? `?${qs}` : ""}`, {
    method: "GET",
    headers: headersFor(init),
    signal: resolveSignal(init),
  });
  if (!res.ok) throw await failure(res, "list news");
  const body = (await res.json()) as unknown;
  const posts = parseNewsList(body);
  const total = (body as { total_count?: unknown } | null)?.total_count;
  return { posts, totalCount: typeof total === "number" ? total : posts.length };
}

/**
 * Every public post, paging through the list endpoint (50 at a time, the
 * backend's cap). Stops after 20 pages, far beyond any plausible archive,
 * so a server that miscounts cannot keep it looping.
 */
export async function listAllNews(init: Init = {}): Promise<NewsPostSummary[]> {
  const PAGE = 50;
  const all: NewsPostSummary[] = [];
  for (let page = 0; page < 20; page++) {
    const { posts, totalCount } = await listNews({ limit: PAGE, offset: page * PAGE }, init);
    all.push(...posts);
    if (posts.length === 0 || all.length >= totalCount) break;
  }
  return all;
}

/**
 * A public post by slug, or null when there is none to show (never existed,
 * a draft, or scheduled for later: the backend answers 404 for all three).
 * Throws on any other failure, so the article page can tell "no such post"
 * from "could not ask".
 */
export async function getNewsPost(slug: string, init: Init = {}): Promise<NewsPost | null> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`${init.baseUrl ?? apiBase()}/news/${encodeURIComponent(slug)}`, {
    method: "GET",
    headers: headersFor(init),
    signal: resolveSignal(init),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res, "load the post");
  const body = (await res.json()) as { post?: unknown } | null;
  const post = parseNewsPost(body?.post);
  if (!post)
    throw new DashboardApiError("Could not load the post: the response was unreadable.", 502);
  return post;
}

/** Every post, drafts and scheduled ones included, newest first. */
export async function listAdminNews(init: Init = {}): Promise<NewsPost[]> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`${adminBase(init)}/admin/news`, {
    method: "GET",
    headers: headersFor(init),
    credentials: "include",
    signal: resolveSignal(init),
  });
  if (!res.ok) throw await failure(res, "list news");
  return parseAdminNewsList(await res.json());
}

export async function getAdminNewsPost(id: number, init: Init = {}): Promise<NewsPost | null> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`${adminBase(init)}/admin/news/${encodeURIComponent(String(id))}`, {
    method: "GET",
    headers: headersFor(init),
    credentials: "include",
    signal: resolveSignal(init),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw await failure(res, "load the post");
  const body = (await res.json()) as { post?: unknown } | null;
  return parseNewsPost(body?.post);
}

async function writePost(
  method: "POST" | "PUT",
  path: string,
  input: NewsInput,
  init: Init,
): Promise<NewsPost> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`${adminBase(init)}${path}`, {
    method,
    headers: headersFor(init, "application/json"),
    credentials: "include",
    body: JSON.stringify(input),
    signal: resolveSignal(init),
  });
  if (!res.ok) throw await failure(res, "save the post");
  const body = (await res.json()) as { post?: unknown } | null;
  const post = parseNewsPost(body?.post);
  if (!post)
    throw new DashboardApiError("Saved, but the response was unreadable. Reload to check.", 502);
  return post;
}

export function createNewsPost(input: NewsInput, init: Init = {}): Promise<NewsPost> {
  return writePost("POST", "/admin/news", input, init);
}

export function updateNewsPost(id: number, input: NewsInput, init: Init = {}): Promise<NewsPost> {
  return writePost("PUT", `/admin/news/${encodeURIComponent(String(id))}`, input, init);
}

export async function deleteNewsPost(id: number, init: Init = {}): Promise<void> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`${adminBase(init)}/admin/news/${encodeURIComponent(String(id))}`, {
    method: "DELETE",
    headers: headersFor(init),
    credentials: "include",
    signal: resolveSignal(init),
  });
  if (!res.ok) throw await failure(res, "delete the post");
}

/** An uploaded image: its site-relative URL, ready for a banner or `![alt](url)`. */
export interface UploadedNewsMedia {
  readonly url: string;
  readonly contentType: string;
  readonly bytes: number;
}

/**
 * Upload one image as the raw request body (not multipart), typed by the
 * file's own MIME type. The backend checks the bytes agree with that type,
 * caps the size, and names the object by its hash, so uploading the same
 * image twice returns the same URL.
 *
 * Longer deadline than a D1 read: this is up to 5 MiB through two hops.
 */
export async function uploadNewsMedia(file: Blob, init: Init = {}): Promise<UploadedNewsMedia> {
  const fetchImpl = init.fetch ?? fetch;
  const res = await fetchImpl(`${adminBase(init)}/admin/news/media`, {
    method: "POST",
    headers: headersFor(init, file.type || "application/octet-stream"),
    credentials: "include",
    body: file,
    signal: resolveSignal(init, 60_000),
  });
  if (!res.ok) throw await failure(res, "upload the image");
  const body = (await res.json()) as {
    url?: unknown;
    content_type?: unknown;
    bytes?: unknown;
  } | null;
  if (typeof body?.url !== "string") {
    throw new DashboardApiError("Uploaded, but the response had no image URL.", 502);
  }
  return {
    url: body.url,
    contentType: typeof body.content_type === "string" ? body.content_type : file.type,
    bytes: typeof body.bytes === "number" ? body.bytes : file.size,
  };
}
