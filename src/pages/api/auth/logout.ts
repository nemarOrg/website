import type { APIRoute } from "astro";
import { clearSessionCookie } from "../../../lib/auth";

// MOCK: stays after Phase 5 backend swap; the endpoint shape matches the
// upstream contract documented in nemar-cli#569.
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
