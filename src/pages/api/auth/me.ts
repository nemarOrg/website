import type { APIRoute } from "astro";
import { getSession } from "../../../lib/auth";

export const GET: APIRoute = async ({ locals }) => {
  const session = getSession(locals);
  const user = session
    ? {
        id: session.id,
        email: session.email,
        role: session.role,
        status: session.status,
      }
    : null;
  return new Response(JSON.stringify({ user }), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
};
