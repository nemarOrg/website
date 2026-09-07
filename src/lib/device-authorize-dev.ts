/**
 * `astro dev` stand-in for the device-authorization + named-key backend
 * (epic #1272 phase 2, nemarOrg/website#316). `astro dev` has no backend to
 * talk to, so the `/cli/authorize` page and the Settings CLI-keys card
 * (`api/auth/keys.ts`, `api/auth/keys/[id].ts`) carry an
 * `import.meta.env.DEV` branch over this in-memory store instead of calling
 * `./device-auth-api.ts`.
 *
 * Every function returns the exact `{ status, body }` shape
 * `./device-authorize.ts`'s `authorizeView`/`decisionView` already know how
 * to read, transcribed from the real backend's response bodies
 * (`backend/src/routes/auth-device.ts`, `services/device-auth.ts`) — so the
 * SAME view-model functions run against dev or production, and this file is
 * the only place that knows the difference exists.
 *
 * State is a module-level mutable store, reset between test runs via
 * {@link resetDeviceAuthorizeDevStore}. This is fine for what it is: an
 * `astro dev` process is one person poking at one page, not a multi-tenant
 * server, and the real backend's own D1 rows are exactly this shape.
 */

const USER_CODE_PATTERN = /^[A-Z0-9]{8}$/;

function normalizeDevCode(raw: string): string | null {
  const stripped = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!USER_CODE_PATTERN.test(stripped)) return null;
  return `${stripped.slice(0, 4)}-${stripped.slice(4)}`;
}

type DeviceCodeStatus = "pending" | "denied" | "expired" | "consumed";

interface DevDeviceCode {
  readonly userCode: string;
  readonly machineName: string;
  readonly requestedAt: string;
  readonly expiresIn: number;
  status: DeviceCodeStatus;
}

/** Sentences transcribed verbatim from nemar-cli's
 *  `shared/contract/device-auth.ts` (`DEVICE_AUTH_MESSAGES`), so a dev-mode
 *  render is indistinguishable from a real backend refusal. Not imported —
 *  this repo has no dependency on nemar-cli (ADR 0005) — kept in sync by
 *  hand, the same convention `identity-errors.ts` documents for its own
 *  mirrored sentences. */
const DEV_MESSAGES = {
  device_code_unknown:
    "That code was not found. Check the code shown in your terminal, or run `nemar auth login` again for a new one.",
  device_code_expired: "The code expired. Run `nemar auth login` again for a new one.",
  device_code_used: "That code has already been used. Run `nemar auth login` again for a new one.",
  device_code_denied:
    "This sign-in was declined in the browser. Run `nemar auth login` again if that was a mistake.",
  account_pending:
    "Verify your email address first. Check your inbox for the NEMAR verification code, then authorize again.",
  key_not_found:
    "That key was not found on this account, or it is already revoked. Run `nemar auth keys` to see the active ones.",
  too_many_keys:
    "This account already has 25 active keys. Revoke one in Settings on nemar.org or with `nemar auth keys`, then try again.",
} as const;

const HTTP_STATUS_FOR_CODE_REFUSAL: Readonly<
  Record<"device_code_expired" | "device_code_used" | "device_code_denied", number>
> = { device_code_expired: 410, device_code_used: 409, device_code_denied: 409 };

function seedDeviceCodes(): Map<string, DevDeviceCode> {
  const now = new Date().toISOString();
  return new Map([
    [
      "BCDF-GHJK",
      {
        userCode: "BCDF-GHJK",
        machineName: "dev-laptop",
        requestedAt: now,
        expiresIn: 480,
        status: "pending",
      },
    ],
    [
      "DFGH-JKLM",
      {
        userCode: "DFGH-JKLM",
        machineName: "dev-desktop",
        requestedAt: now,
        expiresIn: 0,
        status: "expired",
      },
    ],
    [
      "FGHJ-KLMN",
      {
        userCode: "FGHJ-KLMN",
        machineName: "dev-ci",
        requestedAt: now,
        expiresIn: 480,
        status: "consumed",
      },
    ],
    [
      "GHJK-LMNP",
      {
        userCode: "GHJK-LMNP",
        machineName: "dev-headless",
        requestedAt: now,
        expiresIn: 480,
        status: "denied",
      },
    ],
  ]);
}

export interface DevApiKeySummary {
  readonly id: number;
  readonly name: string | null;
  readonly prefix: string;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly current: boolean;
}

/** Mirrors the backend's live-key cap (`MAX_LIVE_API_KEYS`,
 *  `shared/contract/device-auth.ts`) so the dev store's `too_many_keys`
 *  refusal is reachable without minting 25 real rows against a live API. */
export const MAX_LIVE_API_KEYS_DEV = 25;

function seedApiKeys(): DevApiKeySummary[] {
  return [
    {
      id: 1,
      name: "dev-laptop",
      prefix: "nmr_dv1a",
      created_at: "2026-08-01T00:00:00.000Z",
      last_used_at: "2026-09-01T09:00:00.000Z",
      current: false,
    },
    {
      id: 2,
      name: "ci-runner",
      prefix: "nmr_dv2b",
      created_at: "2026-08-15T00:00:00.000Z",
      last_used_at: null,
      current: false,
    },
  ];
}

let deviceCodes = seedDeviceCodes();
let apiKeys = seedApiKeys();
let nextKeyId = 3;

/** Resets both stores to their seeded fixtures. Test-only — `astro dev`
 *  itself never calls this, since a real dev session wants its mutations
 *  (confirm/deny, key create/revoke) to persist across requests. */
export function resetDeviceAuthorizeDevStore(): void {
  deviceCodes = seedDeviceCodes();
  apiKeys = seedApiKeys();
  nextKeyId = 3;
}

export interface DevResult {
  readonly status: number;
  readonly body: unknown;
}

function refusal(code: keyof typeof DEV_MESSAGES, status: number): DevResult {
  return { status, body: { error: code, message: DEV_MESSAGES[code] } };
}

/** `GET /auth/device/lookup` stand-in. `user` is the dev session's own
 *  persona: a `"pending"` status yields the SAME `account_pending` nested
 *  refusal a real unverified account gets from the backend (decision 5),
 *  reachable via `@nemar.pending` regardless of which live code is looked up. */
export function lookupDeviceCodeDev(
  code: string,
  user: { readonly status: "active" | "pending" | "disabled" },
): DevResult {
  const normalized = normalizeDevCode(code);
  if (!normalized) return refusal("device_code_unknown", 404);
  const row = deviceCodes.get(normalized);
  if (!row) return refusal("device_code_unknown", 404);
  if (row.status === "expired")
    return refusal("device_code_expired", HTTP_STATUS_FOR_CODE_REFUSAL.device_code_expired);
  if (row.status === "consumed")
    return refusal("device_code_used", HTTP_STATUS_FOR_CODE_REFUSAL.device_code_used);
  if (row.status === "denied")
    return refusal("device_code_denied", HTTP_STATUS_FOR_CODE_REFUSAL.device_code_denied);

  // Live pending. Account-level refusal nests inside a 200, exactly like the
  // real lookup route.
  const accountRefusal =
    user.status === "pending"
      ? { code: "account_pending", message: DEV_MESSAGES.account_pending }
      : null;

  return {
    status: 200,
    body: {
      user_code: row.userCode,
      machine_name: row.machineName,
      requested_at: row.requestedAt,
      expires_in: row.expiresIn,
      account: { username: null, email_masked: "d***@nemar.dev" },
      refusal: accountRefusal,
    },
  };
}

/** `POST /auth/device/{confirm,deny}` stand-in. */
export function decideDeviceCodeDev(
  intent: "authorize" | "deny",
  code: string,
  user: { readonly status: "active" | "pending" | "disabled" },
): DevResult {
  const normalized = normalizeDevCode(code);
  if (!normalized) return refusal("device_code_unknown", 404);
  const row = deviceCodes.get(normalized);
  if (!row) return refusal("device_code_unknown", 404);
  if (row.status === "expired")
    return refusal("device_code_expired", HTTP_STATUS_FOR_CODE_REFUSAL.device_code_expired);
  if (row.status === "consumed")
    return refusal("device_code_used", HTTP_STATUS_FOR_CODE_REFUSAL.device_code_used);
  if (row.status === "denied")
    return refusal("device_code_denied", HTTP_STATUS_FOR_CODE_REFUSAL.device_code_denied);
  if (user.status === "pending") return refusal("device_code_used", 403);

  if (intent === "authorize") {
    row.status = "consumed";
    return { status: 200, body: { ok: true, machine_name: row.machineName } };
  }
  row.status = "denied";
  return { status: 200, body: { ok: true } };
}

/** `GET /auth/keys` stand-in. */
export function listApiKeysDev(): { keys: DevApiKeySummary[] } {
  return { keys: [...apiKeys] };
}

/** `POST /auth/keys` stand-in. Mints a key named by the caller, refusing at
 *  the same 25-key cap the backend enforces. */
export function createApiKeyDev(name: string): DevResult {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { status: 400, body: { error: "invalid_name", message: "Name your key." } };
  }
  if (apiKeys.length >= MAX_LIVE_API_KEYS_DEV) {
    return refusal("too_many_keys", 409);
  }
  const id = nextKeyId++;
  const key: DevApiKeySummary = {
    id,
    name: trimmed.slice(0, 200),
    prefix: `nmr_dv${id}x`,
    created_at: new Date().toISOString(),
    last_used_at: null,
    current: false,
  };
  apiKeys = [...apiKeys, key];
  return {
    status: 200,
    body: { api_key: `nmr_dev_${id}_${"x".repeat(24)}`, key },
  };
}

/** `DELETE /auth/keys/:id` stand-in. */
export function revokeApiKeyDev(id: string): DevResult {
  if (!/^\d+$/.test(id)) return refusal("key_not_found", 404);
  const numericId = Number(id);
  const before = apiKeys.length;
  apiKeys = apiKeys.filter((k) => k.id !== numericId);
  if (apiKeys.length === before) return refusal("key_not_found", 404);
  return { status: 200, body: { ok: true } };
}
