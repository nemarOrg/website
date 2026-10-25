import { describe, expect, it } from "vitest";
import { MailApiError, classifyReplyFailure, replyToTicket } from "../src/lib/mail-admin-api";
import { type ApiBinding, runWithRequestContext } from "../src/lib/request-context";
import { POST } from "../src/pages/api/v1/[...path]";

/**
 * A browser reply, through the real proxy and the real API client, against a binding that answers
 * with the API's real refusal. The page showed "The request failed (502)" for this exact answer,
 * so this pins that the site code keeps the body of a 5xx all the way to the reader.
 */
const REFUSAL = {
  error: "Nothing was sent: the mail provider refused the message.",
  code: "reply_not_sent",
};

describe("the proxy carries a 5xx body to the mail client", () => {
  it("keeps the API's sentence and code on a 502", async () => {
    const binding: ApiBinding = {
      fetch: async () =>
        new Response(JSON.stringify(REFUSAL), {
          status: 502,
          headers: { "content-type": "application/json" },
        }),
    };
    const browserFetch: typeof fetch = async (input, init) => {
      const request = new Request(`https://test.nemar.org${String(input)}`, init);
      const response = await runWithRequestContext(
        { apiBinding: binding, visitorIp: "198.51.100.7" },
        () =>
          POST({
            params: { path: new URL(request.url).pathname.replace("/api/v1/", "") },
            request,
          } as unknown as Parameters<typeof POST>[0]),
      );
      return response as Response;
    };
    const err = await replyToTicket(2, "hello", "0".repeat(32), { fetch: browserFetch }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MailApiError);
    expect((err as MailApiError).status).toBe(502);
    expect((err as MailApiError).code).toBe("reply_not_sent");
    expect((err as MailApiError).sentence).toBe(REFUSAL.error);
    expect(classifyReplyFailure(err)).toBe("key_released");
  });
});
