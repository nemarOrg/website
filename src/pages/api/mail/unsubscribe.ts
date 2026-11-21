import type { APIRoute } from "astro";
import {
  UNSUBSCRIBE_PRIVACY_HEADERS,
  isMailUnsubscribeToken,
  isUnsubscribeScope,
  resultForForwardStatus,
  unsubscribePagePath,
} from "../../../lib/mail-unsubscribe";
import { postUnsubscribe } from "../../../lib/mail-unsubscribe-api";

/**
 * The same-origin endpoint the unsubscribe page's two buttons post to (epic
 * nemarOrg/nemar-cli#2260 phase 5, nemar-cli ADR 0132).
 *
 * The form carries `token` and `scope` (`category` or `all`) in its body, so the token is never in
 * this endpoint's URL. The token's shape is checked before anything is sent; a body that is not a
 * press answers 400 and sends nothing upstream. The press is forwarded to
 * `POST /mail/unsubscribe/:token` built from nothing but the token and the scope: no cookie and no
 * `Authorization` header of the visitor's is ever forwarded (`postUnsubscribe`).
 *
 * The answer is a 303 back to the page with the result (`?result=category|all|invalid|error`), so
 * the press works without JavaScript and a reload does not post again. The page confirms the result
 * against the backend before it says anything changed.
 *
 * The site's cross-site form check (`src/middleware.ts`, ADR 0031) runs before this, as for every
 * form; the page's `same-origin` referrer policy is what keeps its own post's Origin intact.
 */

/** A press is two short fields; anything larger is not one. */
const MAX_BODY_BYTES = 2048;

function refuse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...UNSUBSCRIBE_PRIVACY_HEADERS },
  });
}

/**
 * Read at most {@link MAX_BODY_BYTES} bytes, counting what actually arrives: a declared
 * Content-Length is a hint a client may omit (chunked) or understate. Null when the body is larger;
 * the stream is cancelled at the first byte over. Undefined when the stream fails.
 */
async function readBounded(request: Request): Promise<Uint8Array | null | undefined> {
  const stream = request.body;
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const POST: APIRoute = async ({ request }) => {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return refuse("This is not an unsubscribe request.", 413);
  }
  const contentType = request.headers.get("content-type") ?? "";
  const type = contentType.toLowerCase();
  const urlencoded = type.startsWith("application/x-www-form-urlencoded");
  if (!urlencoded && !type.startsWith("multipart/form-data")) {
    return refuse("This is not an unsubscribe request.", 415);
  }
  const bytes = await readBounded(request);
  if (bytes === null) return refuse("This is not an unsubscribe request.", 413);
  if (bytes === undefined) return refuse("This is not an unsubscribe request.", 400);
  let form: URLSearchParams | FormData;
  try {
    form = urlencoded
      ? new URLSearchParams(new TextDecoder().decode(bytes))
      : await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return refuse("This is not an unsubscribe request.", 400);
  }
  const token = form.get("token");
  const scope = form.get("scope");
  if (!isMailUnsubscribeToken(token)) {
    return refuse("This unsubscribe link is not valid.", 400);
  }
  if (!isUnsubscribeScope(scope)) {
    return refuse("This is not an unsubscribe request.", 400);
  }

  const status = await postUnsubscribe(token, scope);
  return new Response(null, {
    status: 303,
    headers: {
      Location: unsubscribePagePath(token, resultForForwardStatus(status, scope)),
      ...UNSUBSCRIBE_PRIVACY_HEADERS,
    },
  });
};
