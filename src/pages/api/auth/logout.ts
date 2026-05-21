import type { APIRoute } from "astro";
import { clearSessionCookie } from "../../../lib/auth";

// Logout stays after Phase 5 backend swap: the endpoint contract matches the
// upstream `nemar-cli#569` shape, so the only thing that changes is which
// service the cookie was minted by.
//
// CSRF: this is a logout-only mutation (no privilege escalation), and the
// session cookie is SameSite=Lax which blocks cross-site form POSTs in modern
// browsers. The user-visible worst case from a forged POST is forced sign-out.
export const POST: APIRoute = async ({ cookies, request }) => {
  clearSessionCookie(cookies);

  // Allow either an HTML form submission (redirects home) or an XHR call
  // (returns JSON). The form path lets the sign-out button live inside a
  // tiny <form method="POST"> without client-side JS.
  const accept = request.headers.get("Accept") ?? "";
  if (accept.includes("text/html")) {
    return new Response(null, {
      status: 303,
      headers: { Location: "/", "Cache-Control": "no-store" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
