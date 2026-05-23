import type { APIRoute } from "astro";
import { apiBase } from "../../../../lib/api-base";
import { isValidEmail } from "../../../../lib/auth";

/**
 * Same-origin proxy for the password-less code request. In production this
 * forwards verbatim to `${apiBase}/auth/code/request`. In `astro dev` the
 * mock short-circuits: any valid email gets an "ok" response, the demo
 * code `123456` is printed to the terminal so the developer can paste it
 * into the verify form.
 */
export const POST: APIRoute = async ({ request }) => {
  const accept = request.headers.get("Accept") ?? "";
  if (import.meta.env.DEV) {
    let body: { email?: unknown };
    try {
      body = (await request.json()) as { email?: unknown };
    } catch {
      return json({ ok: false, error: "invalid_json" }, 400, accept);
    }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!isValidEmail(email)) {
      return json({ ok: false, error: "invalid_email" }, 400, accept);
    }
    // eslint-disable-next-line no-console
    console.log(`[dev-auth] code request for ${email} — use code 123456 on /login/verify`);
    return json({ ok: true }, 200, accept);
  }

  // Production proxy: forward to the real backend. Forward Origin too —
  // backend route guards on it, and a server-side fetch from the Worker
  // doesn't carry one by default.
  const body = await request.text();
  const browserOrigin = request.headers.get("Origin");
  if (!browserOrigin) {
    console.warn("[auth/code/request proxy] no Origin header; falling back to app.nemar.org");
  }
  const origin = browserOrigin ?? "https://app.nemar.org";
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/auth/code/request`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: origin,
      },
      body,
    });
  } catch (err) {
    console.warn("[auth/code/request proxy] backend fetch failed", err);
    return json({ ok: false, error: "internal_error" }, 502, accept);
  }
  const respBody = await res.text();
  return new Response(respBody, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("Content-Type") ?? "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};

function json(payload: unknown, status: number, _accept: string): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
