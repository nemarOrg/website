/**
 * Pure view model for `/cli/authorize` (epic #1272 phase 2, nemarOrg/website#316).
 *
 * Maps a {@link DeviceApiResult} from `./device-auth-api.ts` onto exactly one
 * of the page's rendered states. No local refusal-code vocabulary is mirrored
 * here (ADR 0005, 0015): every sentence a person reads comes verbatim off the
 * wire (`body.message`), and the only thing this module decides is which
 * TEMPLATE renders that sentence and whether a next-step link accompanies it.
 * `AUTHORIZE_COPY` holds the page's own framing prose — the words around the
 * wire sentence, never a replacement for it.
 *
 * `authorizeView` (a GET lookup) and `decisionView` (a POST confirm/deny)
 * share one state union so the page's markup does not need two render paths:
 * a decide call that fails renders through the exact same `refused` /
 * `unavailable` template a lookup failure would.
 */

export interface AuthorizeAccount {
  readonly username: string | null;
  readonly emailMasked: string;
}

export interface NextStep {
  readonly href: string;
  readonly label: string;
}

/**
 * Why this page could not render a wire-shaped answer: `"network"` when the
 * fetch itself never got a response, `"server"` for a 5xx, `"malformed"`
 * for a 2xx/4xx whose body did not match the shape this page knows how to
 * read — which is exactly the case ADR 0016 describes for a `403` with no
 * `message` (`{ error: "Origin not allowed" }`). `"server"` and
 * `"malformed"` share one user-facing sentence (nothing an end user did
 * wrong, in either case) but are logged and typed separately, because they
 * mean different things to whoever reads the log.
 */
export type UnavailableReason = "network" | "server" | "malformed";

export type AuthorizeViewState =
  | { readonly kind: "enter_code" }
  | {
      readonly kind: "confirm";
      readonly code: string;
      readonly machineName: string;
      readonly account: AuthorizeAccount;
      readonly requestedAt: string;
      readonly minutesLeft: number;
    }
  | {
      readonly kind: "refused";
      readonly message: string;
      readonly showEnterCodeForm: boolean;
      readonly nextStep?: NextStep;
    }
  | { readonly kind: "signed_out" }
  | { readonly kind: "unavailable"; readonly reason: UnavailableReason }
  | { readonly kind: "done"; readonly done: "authorized" | "denied"; readonly machine?: string };

export type DecisionOutcome =
  | { readonly kind: "redirect"; readonly location: string }
  | AuthorizeViewState;

/** Framing copy local to this page — never `ACCOUNT_COPY` (its drift test
 *  fails on a website-only key; this page's copy has no nemar-cli mirror to
 *  drift from, being CLI-sign-in specific). Every sentence here is prose
 *  the page writes ABOUT the wire's answer; the wire's own `message` always
 *  renders verbatim alongside it, never replaced. */
export const AUTHORIZE_COPY = {
  enterCode: {
    title: "Enter the code",
    lede: "Enter the code shown in your terminal.",
    label: "Code",
    submit: "Continue",
  },
  confirm: {
    questionPrefix: "Did you just run",
    questionCommand: "nemar auth login",
    questionSuffix: "on",
    authorize: "Authorize",
    deny: "Deny",
    denyHint: "If this isn't you, or you didn't start this, choose Deny.",
    noUsername: "no username yet",
  },
  done: {
    authorized: "Done. You can close this tab. Your terminal will finish signing in on its own.",
    denied: "Nothing was authorized.",
  },
  unavailable: {
    network: "We couldn't reach NEMAR. Reload this page to try again.",
    // Covers both "server" and "malformed" (decision: one sentence for
    // "nothing you did wrong, we couldn't make sense of NEMAR's answer").
    error:
      "NEMAR answered with an error. Try again in a moment, and if it keeps happening tell us at support@nemar.org.",
  },
} as const;

/** The done view's sentence, machine-aware when the redirect that produced
 *  it carried one (`decisionView`'s hidden `machine` form field, threaded
 *  through the query string — see `doneViewFromQuery`). Falls back to the
 *  machine-less sentence when it did not (an old bookmark from before this
 *  field existed, or a `deny` whose hidden field was blank). */
export function doneMessage(done: "authorized" | "denied", machine?: string): string {
  if (done === "authorized") {
    return machine
      ? `Done. You can close this tab. Your terminal on ${machine} will finish signing in on its own.`
      : AUTHORIZE_COPY.done.authorized;
  }
  return machine
    ? `Declined the sign-in from ${machine}. Nothing was authorized.`
    : AUTHORIZE_COPY.done.denied;
}

/** The sentence for an `unavailable` view's reason. */
export function unavailableMessage(reason: UnavailableReason): string {
  return reason === "network"
    ? AUTHORIZE_COPY.unavailable.network
    : AUTHORIZE_COPY.unavailable.error;
}

/**
 * A non-empty code up to 64 characters — the only shape this page checks
 * itself (decision 4: no local normalizer). The backend's own
 * `normalizeUserCode` is the real validation; anything this rejects, or that
 * survives this and is still malformed, comes back from the backend as
 * `device_code_unknown` with the contract's own sentence.
 */
export function hasCode(code: string | null | undefined): code is string {
  if (typeof code !== "string") return false;
  const trimmed = code.trim();
  return trimmed.length > 0 && trimmed.length <= 64;
}

/**
 * The account-level refusal codes {@link nextStepFor} can name a next step
 * for. Not every refusal gets one (`service_account`, `account_revoked`
 * offer none — there is nothing the person can do about either from here),
 * and the two that do compute their `href` from the code-level factories
 * below rather than a fixed string, so the return address survives the trip.
 */
const NEXT_STEP_FACTORIES: Readonly<Record<string, (here: string) => NextStep>> = {
  account_pending: (here) => ({
    href: `/dashboard?next=${encodeURIComponent(here)}`,
    label: "Verify your email",
  }),
  identity_conflict: () => ({ href: "/settings", label: "Go to Settings" }),
};

/**
 * The next-step link for a refusal code, or `undefined` when there is none —
 * either because the code carries no useful next step (`service_account`,
 * `account_revoked`) or because it is not a code this page recognizes at all
 * (`Object.hasOwn` guard: a prototype key like `"constructor"` must not
 * resolve to a function instead of `undefined`, the same guard
 * `login.astro`/`settings.astro`/`orcid/complete.astro` apply to their own
 * server-supplied error-code lookups).
 */
export function nextStepFor(code: string, here: string): NextStep | undefined {
  if (!Object.hasOwn(NEXT_STEP_FACTORIES, code)) return undefined;
  return NEXT_STEP_FACTORIES[code](here);
}

/**
 * The shape both {@link authorizeView} and {@link decisionView} accept:
 * structurally identical to `DeviceApiResult<unknown>` from
 * `./device-auth-api.ts` and to the dev store's `DevResult`
 * (`./device-authorize-dev.ts`), so either one can be passed straight
 * through without an adapter.
 */
type RawResult =
  | { readonly status: number; readonly body: unknown }
  | { readonly status: "network" };

/** A `{ error, message }` refusal body only counts as one when `message` is
 *  a non-empty string. This is what tells the backend's own device-auth
 *  refusal shape (`deviceRefusalResponseSchema`, always carrying `message`)
 *  apart from an unrelated failure body that happens to share the same HTTP
 *  status — `POST /auth/device/confirm`'s `{ error: "Origin not allowed" }`
 *  answers 403 with NO `message`, the same status four real refusal codes
 *  use (`account_pending`, `account_revoked`, `identity_conflict`,
 *  `service_account`). Requiring `message` distinguishes them without this
 *  module mirroring the refusal-code vocabulary (ADR 0005, 0015). */
function refusalFrom(body: unknown): { code?: string; message: string } | null {
  if (!body || typeof body !== "object") return null;
  const rec = body as Record<string, unknown>;
  const message =
    typeof rec.message === "string" && rec.message.length > 0 ? rec.message : undefined;
  if (!message) return null;
  const code = typeof rec.error === "string" ? rec.error : undefined;
  return { code, message };
}

/** Shared by {@link authorizeView} and {@link decisionView}: every status this
 *  page cannot make sense of as a wire-shaped answer becomes `unavailable`.
 *  `label` identifies the caller in the log line — the caller passes a
 *  fixed string of its own rather than this function inferring one, since
 *  it is the one thing a plain status/body pair cannot carry. */
function transportFailureView(result: RawResult, label: string): AuthorizeViewState | null {
  if (result.status === "network") return { kind: "unavailable", reason: "network" };
  if (result.status === 401) return { kind: "signed_out" };
  if (result.status >= 500) {
    console.warn(`[device-authorize] ${label}: upstream answered ${result.status}`);
    return { kind: "unavailable", reason: "server" };
  }
  return null;
}

/** The response body, or `null` for the network sentinel (which carries
 *  none). A plain property access on `result.body` does not type-check once
 *  a caller has only run it through {@link transportFailureView} — a
 *  function call does not narrow the caller's own union the way an inline
 *  check would — so every read past that point goes through here instead. */
function bodyOf(result: RawResult): unknown {
  return result.status === "network" ? null : result.body;
}

/** Every place below that gives up and renders `unavailable` for a response
 *  shape it does not recognize logs the status and body together before
 *  doing so — this is exactly the "Origin not allowed" 403 case ADR 0016
 *  documents (a body that shares a real refusal's HTTP status but carries
 *  none of its fields), and a silent `unavailable` would make that
 *  indistinguishable from a genuine backend hiccup in the logs. */
function malformed(label: string, result: RawResult): AuthorizeViewState {
  console.warn(`[device-authorize] ${label}: unrecognised response shape`, {
    status: result.status,
    body: bodyOf(result),
  });
  return { kind: "unavailable", reason: "malformed" };
}

/**
 * Map a `GET /auth/device/lookup` result onto the page's GET-branch states.
 *
 * A 200 body's `refusal` is nested (`{ code, message } | null`) because the
 * backend answers account-level problems (pending email, revoked account,
 * identity conflict, a service account) alongside the code's own details —
 * the code itself is still perfectly live, only the SIGNED-IN ACCOUNT cannot
 * use it. A non-200 status means the CODE itself is the problem (unknown,
 * expired, used, denied), which `HTTP_STATUS_FOR_REFUSAL` on the backend
 * carries as the real HTTP status rather than nesting it.
 */
export function authorizeView(result: RawResult, here: string): AuthorizeViewState {
  const transport = transportFailureView(result, "authorizeView");
  if (transport) return transport;

  if (result.status === 200) {
    const body = result.body;
    if (!body || typeof body !== "object") return malformed("authorizeView", result);
    const rec = body as Record<string, unknown>;
    const refusalRaw = rec.refusal;
    if (refusalRaw && typeof refusalRaw === "object") {
      const refusal = refusalRaw as Record<string, unknown>;
      const message = typeof refusal.message === "string" ? refusal.message : "";
      if (!message) return malformed("authorizeView/refusal", result);
      const code = typeof refusal.code === "string" ? refusal.code : undefined;
      return {
        kind: "refused",
        message,
        showEnterCodeForm: false,
        nextStep: code ? nextStepFor(code, here) : undefined,
      };
    }
    // refusal === null: a live, confirmable code for the signed-in account.
    const userCode = typeof rec.user_code === "string" ? rec.user_code : "";
    const machineName = typeof rec.machine_name === "string" ? rec.machine_name : "";
    const requestedAt = typeof rec.requested_at === "string" ? rec.requested_at : "";
    const expiresIn = typeof rec.expires_in === "number" ? rec.expires_in : Number.NaN;
    const accountRaw = rec.account;
    if (!userCode || !machineName || !accountRaw || typeof accountRaw !== "object") {
      return malformed("authorizeView/confirm", result);
    }
    const account = accountRaw as Record<string, unknown>;
    return {
      kind: "confirm",
      code: userCode,
      machineName,
      account: {
        username: typeof account.username === "string" ? account.username : null,
        emailMasked: typeof account.email_masked === "string" ? account.email_masked : "",
      },
      requestedAt,
      minutesLeft: Number.isFinite(expiresIn) ? Math.max(0, Math.round(expiresIn / 60)) : 0,
    };
  }

  // Non-200, non-401, non-5xx: a code-level refusal (404 unknown, 410
  // expired, 409 used/denied). `refusalFrom` requires `message`, so an
  // unrecognized or malformed error body still falls through to unavailable.
  const refusal = refusalFrom(bodyOf(result));
  if (!refusal) return malformed("authorizeView/code-refusal", result);
  return {
    kind: "refused",
    message: refusal.message,
    // The one refusal a person can immediately retry from THIS page: typing
    // the code again. Every other refusal (expired/used/denied, or an
    // account-level one from the 200 branch above) needs a fresh code from
    // `nemar auth login`, which the wire sentence itself already says.
    showEnterCodeForm: refusal.code === "device_code_unknown",
    nextStep: refusal.code ? nextStepFor(refusal.code, here) : undefined,
  };
}

/**
 * Map a `POST /auth/device/{confirm,deny}` result onto either a
 * post-redirect-get target (success) or the same refused/unavailable/
 * signed_out states {@link authorizeView} renders (failure) — so a POST that
 * fails renders in place through the identical template a GET would.
 *
 * `code` and `machineName` are NOT read off the response body: `deny`'s 200
 * body is `{ ok: true }` with no machine name, while `confirm`'s carries one
 * — asymmetric for no reason this page needs to care about. Both are known
 * already (the code from the submitted form, the machine name from the
 * hidden field the GET-rendered confirm form carried), so the redirect is
 * built from what the page already has rather than from what each route
 * happens to echo back.
 */
export function decisionView(
  result: RawResult,
  intent: "authorize" | "deny",
  code: string,
  machineName: string,
  authorizePath: string,
): DecisionOutcome {
  const transport = transportFailureView(result, "decisionView");
  if (transport) return transport;

  if (result.status === 200) {
    // `deviceConfirmResponseSchema` / the deny route's body are both
    // `{ ok: true, ... }`; validating `ok === true` (rather than merely
    // "the body is an object") is what tells a real success apart from a
    // 200 this page cannot otherwise make sense of.
    const body = result.body;
    if (!body || typeof body !== "object" || (body as Record<string, unknown>).ok !== true) {
      return malformed("decisionView", result);
    }
    const params = new URLSearchParams({
      code,
      done: intent === "authorize" ? "authorized" : "denied",
    });
    if (machineName) params.set("machine", machineName);
    return { kind: "redirect", location: `${authorizePath}?${params.toString()}` };
  }

  const refusal = refusalFrom(bodyOf(result));
  if (!refusal) return malformed("decisionView/code-refusal", result);
  return {
    kind: "refused",
    message: refusal.message,
    showEnterCodeForm: refusal.code === "device_code_unknown",
    nextStep: refusal.code ? nextStepFor(refusal.code, authorizePath) : undefined,
  };
}

/**
 * Reconstruct the `done` view straight from the redirect's own query string
 * — the GET after a successful decide never looks the code up again (decision
 * 2: the two success outcomes end in post-redirect-get). `done` must be
 * exactly `"authorized"` or `"denied"`; anything else (a hand-edited URL, a
 * stale bookmark from a future value this build does not know) is not a done
 * view at all, so the page falls through to its normal GET handling instead
 * of rendering a state for a value it cannot interpret.
 */
export function doneViewFromQuery(params: URLSearchParams): AuthorizeViewState | null {
  const done = params.get("done");
  if (done !== "authorized" && done !== "denied") return null;
  const machineRaw = params.get("machine") ?? "";
  const machine = machineRaw.length > 64 ? machineRaw.slice(0, 64) : machineRaw;
  return { kind: "done", done, machine: machine.length > 0 ? machine : undefined };
}
