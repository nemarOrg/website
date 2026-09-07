/**
 * The `astro dev` device-authorization + keys stand-in (epic #1272 phase 2).
 * Every function returns the same `{ status, body }` shape the real API
 * client does, so these tests exercise the store directly rather than the
 * view-model mapping — that half is `device-authorize.test.ts`'s job.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_LIVE_API_KEYS_DEV,
  createApiKeyDev,
  decideDeviceCodeDev,
  listApiKeysDev,
  lookupDeviceCodeDev,
  resetDeviceAuthorizeDevStore,
  revokeApiKeyDev,
} from "./device-authorize-dev";

const ACTIVE = { status: "active" as const };
const PENDING = { status: "pending" as const };
const DISABLED = { status: "disabled" as const };

beforeEach(() => {
  resetDeviceAuthorizeDevStore();
});

describe("lookupDeviceCodeDev", () => {
  it("returns a live confirm-shaped body for the seeded pending code", () => {
    const result = lookupDeviceCodeDev("BCDF-GHJK", ACTIVE);
    expect(result.status).toBe(200);
    const body = result.body as { machine_name: string; refusal: unknown };
    expect(body.machine_name).toBe("dev-laptop");
    expect(body.refusal).toBeNull();
  });

  it("accepts a code typed without the hyphen or in lowercase", () => {
    expect(lookupDeviceCodeDev("bcdfghjk", ACTIVE).status).toBe(200);
    expect(lookupDeviceCodeDev("bcdf ghjk", ACTIVE).status).toBe(200);
  });

  it("404s an unseeded code as device_code_unknown", () => {
    const result = lookupDeviceCodeDev("ZZZZ-9999", ACTIVE);
    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toBe("device_code_unknown");
  });

  it("carries the seeded expired/used/denied fixtures at the right status", () => {
    expect(lookupDeviceCodeDev("DFGH-JKLM", ACTIVE).status).toBe(410); // expired
    expect(lookupDeviceCodeDev("FGHJ-KLMN", ACTIVE).status).toBe(409); // used
    expect(lookupDeviceCodeDev("GHJK-LMNP", ACTIVE).status).toBe(409); // denied
    expect((lookupDeviceCodeDev("FGHJ-KLMN", ACTIVE).body as { error: string }).error).toBe(
      "device_code_used",
    );
    expect((lookupDeviceCodeDev("GHJK-LMNP", ACTIVE).body as { error: string }).error).toBe(
      "device_code_denied",
    );
  });

  it("a pending persona gets a nested account_pending refusal on a live code", () => {
    const result = lookupDeviceCodeDev("BCDF-GHJK", PENDING);
    expect(result.status).toBe(200);
    const body = result.body as { refusal: { code: string; message: string } | null };
    expect(body.refusal?.code).toBe("account_pending");
    expect(body.refusal?.message).toMatch(/verify your email/i);
  });

  it("a disabled persona gets a nested account_revoked refusal on a live code", () => {
    const result = lookupDeviceCodeDev("BCDF-GHJK", DISABLED);
    expect(result.status).toBe(200);
    const body = result.body as { refusal: { code: string; message: string } | null };
    expect(body.refusal?.code).toBe("account_revoked");
    expect(body.refusal?.message).toMatch(/revoked/i);
  });
});

describe("decideDeviceCodeDev", () => {
  it("authorize consumes the code and echoes the machine name", () => {
    const result = decideDeviceCodeDev("authorize", "BCDF-GHJK", ACTIVE);
    expect(result).toEqual({ status: 200, body: { ok: true, machine_name: "dev-laptop" } });
    // Consumed: a second decide on the same code now refuses as used.
    expect(decideDeviceCodeDev("authorize", "BCDF-GHJK", ACTIVE).status).toBe(409);
  });

  it("deny marks the code denied with no machine name in the body", () => {
    const result = decideDeviceCodeDev("deny", "BCDF-GHJK", ACTIVE);
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(lookupDeviceCodeDev("BCDF-GHJK", ACTIVE).status).toBe(409);
  });

  it("refuses an unknown code", () => {
    expect(decideDeviceCodeDev("authorize", "ZZZZ-9999", ACTIVE).status).toBe(404);
  });

  it("a pending persona is refused account_pending on authorize only", () => {
    const authorized = decideDeviceCodeDev("authorize", "BCDF-GHJK", PENDING);
    expect(authorized.status).toBe(403);
    expect((authorized.body as { error: string }).error).toBe("account_pending");
    // The code is still live — the gate refused the ACCOUNT, not the code.
    expect(lookupDeviceCodeDev("BCDF-GHJK", ACTIVE).status).toBe(200);
  });

  it("a pending persona can still deny — matching the backend's ungated deny route", () => {
    const denied = decideDeviceCodeDev("deny", "BCDF-GHJK", PENDING);
    expect(denied).toEqual({ status: 200, body: { ok: true } });
    expect(lookupDeviceCodeDev("BCDF-GHJK", ACTIVE).status).toBe(409); // now denied
  });

  it("a disabled persona is refused account_revoked on authorize only", () => {
    const authorized = decideDeviceCodeDev("authorize", "BCDF-GHJK", DISABLED);
    expect(authorized.status).toBe(403);
    expect((authorized.body as { error: string }).error).toBe("account_revoked");
    expect(lookupDeviceCodeDev("BCDF-GHJK", ACTIVE).status).toBe(200);
  });

  it("a disabled persona can still deny", () => {
    const denied = decideDeviceCodeDev("deny", "BCDF-GHJK", DISABLED);
    expect(denied).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("listApiKeysDev / createApiKeyDev / revokeApiKeyDev", () => {
  it("seeds exactly two keys, and creating one adds a third", () => {
    expect(listApiKeysDev().keys).toHaveLength(2);
    const created = createApiKeyDev("build-box");
    expect(created.status).toBe(200);
    const body = created.body as { api_key: string; key: { name: string | null } };
    expect(typeof body.api_key).toBe("string");
    expect(body.key.name).toBe("build-box");
    expect(listApiKeysDev().keys).toHaveLength(3);
  });

  it("refuses a blank name", () => {
    expect(createApiKeyDev("   ").status).toBe(400);
  });

  it("enforces the live-key cap, and the refusal names it rather than a hardcoded 25", () => {
    for (let i = 0; i < 30; i++) {
      createApiKeyDev(`machine-${i}`);
    }
    const keys = listApiKeysDev().keys;
    expect(keys.length).toBeLessThanOrEqual(MAX_LIVE_API_KEYS_DEV);
    expect(keys.length).toBe(MAX_LIVE_API_KEYS_DEV);
    const overflow = createApiKeyDev("one-too-many");
    expect(overflow.status).toBe(409);
    const body = overflow.body as { error: string; message: string };
    expect(body.error).toBe("too_many_keys");
    expect(body.message).toContain(String(MAX_LIVE_API_KEYS_DEV));
  });

  it("revokes a seeded key", () => {
    const result = revokeApiKeyDev("1");
    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(listApiKeysDev().keys.map((k) => k.id)).not.toContain(1);
  });

  it("404s revoking an unknown id", () => {
    const result = revokeApiKeyDev("999");
    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toBe("key_not_found");
  });

  it("404s a non-numeric id rather than throwing", () => {
    expect(revokeApiKeyDev("current").status).toBe(404);
    expect(revokeApiKeyDev("abc").status).toBe(404);
  });
});
