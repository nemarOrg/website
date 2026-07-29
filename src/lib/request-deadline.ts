/**
 * Request deadlines for every backend client in this app.
 *
 * A plain `try/catch` around `fetch` only covers outright rejection: a refused
 * connection, a DNS failure, a TLS error. It does NOT cover a connection that
 * opens and then never writes a response — that promise simply never settles,
 * so there is nothing to catch and nothing to time out. Most of these calls run
 * during SSR at the Cloudflare edge, so an unbounded one stalls the page render
 * itself, bounded only by the platform wall-clock ceiling rather than by any
 * deadline this app chose.
 *
 * `resolveSignal` was copied by hand into four clients before this module
 * existed (`observability`, `users-admin-api`, `imports-admin-api`,
 * `notices-api`), each carrying a "mirrors the other one deliberately" comment.
 * They all import it from here now, so "every authenticated client behaves
 * identically under a hung upstream" is enforced by construction instead of by
 * comment. See website#173.
 */

/**
 * The shape every client's `init` argument shares. Clients declare their own
 * `Init` types (they differ in whether they accept `cookieHeader`, a `fetch`
 * override, and so on) and this is the slice {@link resolveSignal} needs.
 */
export interface DeadlineInit {
  /** Caller's own abort signal, e.g. a component unmounting. Combined with, not replaced by, the deadline. */
  readonly signal?: AbortSignal;
  /** Abort the request after this many ms. Defaults to the call site's own fallback. */
  readonly timeoutMs?: number;
}

/**
 * A plain D1-backed read or state flip. Clients override this per operation
 * where the work is genuinely slower (an S3 re-read, a cascade delete) or
 * genuinely more decorative (a badge count).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/**
 * Decorative chrome — badge counts, status pills — that sits on the critical
 * path of a page which renders fine without it. Short on purpose: a degraded
 * backend should cost the page a missing pill, not seconds of blank screen.
 */
export const DECORATIVE_TIMEOUT_MS = 2500;

/**
 * Combines a caller-supplied abort signal (if any) with a deadline.
 *
 * `AbortSignal.any()` combines the two rather than replacing one with the
 * other, so a caller that aborts early still wins and the deadline still
 * applies to a caller that never does.
 *
 * Aborting on the deadline rejects with a `TimeoutError` `DOMException`;
 * aborting via `init.signal` rejects with whatever reason the caller passed to
 * `AbortController.abort()`. Callers that need to tell the two apart should
 * check `err.name === "TimeoutError"`.
 */
export function resolveSignal(
  init: DeadlineInit,
  fallbackMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? fallbackMs);
  return init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
}
