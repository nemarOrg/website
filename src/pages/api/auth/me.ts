import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth";

export const GET: APIRoute = async ({ locals }) => {
  // Return only the identity-bearing fields; exp and remember are
  // session-internal and never leave the server.
  const session = getSession(locals);
  return new Response(JSON.stringify({ user: session?.user ?? null }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
