import { describe, expect, it } from "vitest";
import { embedCallPoint, embedDataPoint } from "./embed-analytics";

const EMBED_URL = "https://nemar.org/dataset/on007753/embed";

/** A real `Request`, as the middleware sees it. */
function embedRequest(headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(EMBED_URL, { method, headers });
}

describe("embedDataPoint: the exact point", () => {
  it("is index, blobs and one double, and nothing else", () => {
    const point = embedDataPoint(
      embedRequest({
        Referer: "https://example.org/",
        "Sec-Fetch-Dest": "iframe",
      }),
      "on007753",
    );
    expect(point).toStrictEqual({
      indexes: ["on007753"],
      blobs: ["on007753", "example.org", "iframe"],
      doubles: [1],
    });
    expect(Object.keys(point ?? {}).sort()).toEqual(["blobs", "doubles", "indexes"]);
  });

  it("records nothing else from the request, however much it carries", () => {
    const request = new Request(`${EMBED_URL}?view=sub-05_task-rest&theme=dark&v=1.0.1`, {
      headers: {
        Referer: "https://partner.example/study/42?participant=7#anchor",
        "Sec-Fetch-Dest": "iframe",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) Probe/1.0",
        "CF-Connecting-IP": "203.0.113.9",
        "CF-IPCountry": "DE",
        "Accept-Language": "de-DE,de;q=0.9",
        Cookie: "nemar_session=abc123; analytics=reject",
        Authorization: "Bearer should-never-appear",
      },
    });
    const serialized = JSON.stringify(embedDataPoint(request, "on007753"));
    for (const secret of [
      "sub-05",
      "task-rest",
      "theme",
      "dark",
      "1.0.1",
      "study",
      "participant",
      "anchor",
      "Probe",
      "Mozilla",
      "203.0.113.9",
      "DE",
      "de-DE",
      "nemar_session",
      "abc123",
      "should-never-appear",
    ]) {
      expect(serialized, secret).not.toContain(secret);
    }
    expect(serialized).toBe(
      '{"indexes":["on007753"],"blobs":["on007753","partner.example","iframe"],"doubles":[1]}',
    );
  });

  it("uses the dataset id it is given for the index and the first blob", () => {
    const point = embedDataPoint(embedRequest(), "ds004123");
    expect(point?.indexes).toEqual(["ds004123"]);
    expect(point?.blobs[0]).toBe("ds004123");
  });
});

describe("embedDataPoint: what is never counted", () => {
  it("skips a non-GET request, HEAD included", () => {
    for (const method of ["HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const headers: Record<string, string> = { "Sec-Fetch-Dest": "iframe" };
      // A body-less method, so the Request constructor accepts it as built.
      expect(embedDataPoint(embedRequest(headers, method), "on007753"), method).toBeNull();
    }
  });

  it("skips a prefetch announced by Sec-Purpose", () => {
    expect(embedDataPoint(embedRequest({ "Sec-Purpose": "prefetch" }), "on007753")).toBeNull();
  });

  it("skips Sec-Purpose values that carry the prefetch token among others", () => {
    for (const value of ["prefetch;prerender", "prefetch;anonymous-client-ip", "PREFETCH"]) {
      expect(embedDataPoint(embedRequest({ "Sec-Purpose": value }), "on007753"), value).toBeNull();
    }
  });

  it("skips a prefetch announced by Purpose", () => {
    expect(embedDataPoint(embedRequest({ Purpose: "prefetch" }), "on007753")).toBeNull();
    expect(embedDataPoint(embedRequest({ Purpose: "Prefetch" }), "on007753")).toBeNull();
  });

  it("does not mistake another Sec-Purpose or Purpose value for a prefetch", () => {
    expect(embedDataPoint(embedRequest({ "Sec-Purpose": "prerender" }), "on007753")).not.toBeNull();
    expect(embedDataPoint(embedRequest({ Purpose: "preview" }), "on007753")).not.toBeNull();
  });

  it("skips an empty dataset id", () => {
    expect(embedDataPoint(embedRequest(), "")).toBeNull();
  });
});

describe("embedDataPoint: the embedding site", () => {
  const host = (referer: string | null) =>
    embedDataPoint(embedRequest(referer === null ? {} : { Referer: referer }), "on007753")
      ?.blobs[1];

  it("is empty when there is no Referer", () => {
    expect(host(null)).toBe("");
  });

  it("is empty when the Referer is empty", () => {
    expect(host("")).toBe("");
  });

  it("is empty for a Referer that is not a URL", () => {
    for (const bad of ["not a url", "///", "://x", "null", "example.org", "%%%"]) {
      expect(host(bad), bad).toBe("");
    }
  });

  it("is empty for about:blank and other URLs without a host", () => {
    for (const noHost of ["about:blank", "data:text/html,hi", "file:///home/me/page.html"]) {
      expect(host(noHost), noHost).toBe("");
    }
  });

  it("is the hostname of an origin-only Referer", () => {
    expect(host("https://example.org/")).toBe("example.org");
    expect(host("https://example.org")).toBe("example.org");
  });

  it("drops the path, query and fragment", () => {
    expect(host("https://example.org/studies/42/view?participant=7#top")).toBe("example.org");
  });

  it("drops the port", () => {
    expect(host("http://localhost:8080/page")).toBe("localhost");
    expect(host("https://example.org:8443/")).toBe("example.org");
  });

  it("drops userinfo", () => {
    expect(host("https://user:secret@example.org/")).toBe("example.org");
    expect(host("https://user:secret@example.org/")).not.toContain("secret");
  });

  it("keeps localhost, and a loopback address, as hosts", () => {
    expect(host("http://localhost/")).toBe("localhost");
    expect(host("http://127.0.0.1:8080/")).toBe("127.0.0.1");
  });

  it("is the bracketed address for an IPv6 literal, with the port dropped", () => {
    expect(host("http://[::1]:8080/page")).toBe("[::1]");
    expect(host("https://[2001:db8::7]/")).toBe("[2001:db8::7]");
  });

  it("lowercases the hostname", () => {
    expect(host("https://EXAMPLE.Org/Path")).toBe("example.org");
    expect(host("HTTPS://Docs.NEMAR.org/")).toBe("docs.nemar.org");
  });

  it("keeps a subdomain, so two sites on one domain stay distinct", () => {
    expect(host("https://ebrains.example.eu/")).toBe("ebrains.example.eu");
    expect(host("https://www.example.eu/")).toBe("www.example.eu");
  });

  it("records NEMAR's own sites like any other", () => {
    expect(host("https://docs.nemar.org/web/viewer-links/")).toBe("docs.nemar.org");
  });
});

describe("embedDataPoint: the kind of request", () => {
  const kind = (dest: string | null) =>
    embedDataPoint(embedRequest(dest === null ? {} : { "Sec-Fetch-Dest": dest }), "on007753")
      ?.blobs[2];

  it("is iframe for a real embed", () => {
    expect(kind("iframe")).toBe("iframe");
  });

  it("is document when the URL was opened directly", () => {
    expect(kind("document")).toBe("document");
  });

  it("is none when the header is absent", () => {
    expect(kind(null)).toBe("none");
  });

  it("is none when the header is present but empty", () => {
    expect(kind("")).toBe("none");
    expect(kind("  ")).toBe("none");
  });

  it("is other for any other destination", () => {
    for (const dest of ["frame", "embed", "object", "script", "image", "empty", "worker"]) {
      expect(kind(dest), dest).toBe("other");
    }
  });

  it("reads the token case-insensitively", () => {
    expect(kind("IFRAME")).toBe("iframe");
    expect(kind("Document")).toBe("document");
  });
});

describe("embedDataPoint: the combinations a deployed build sees", () => {
  it("a framed load from a local page, as a browser sends it", () => {
    expect(
      embedDataPoint(
        embedRequest({ Referer: "http://localhost:8080/", "Sec-Fetch-Dest": "iframe" }),
        "on007753",
      )?.blobs,
    ).toEqual(["on007753", "localhost", "iframe"]);
  });

  it("a framed load whose referrer was stripped by the embedder's policy", () => {
    expect(embedDataPoint(embedRequest({ "Sec-Fetch-Dest": "iframe" }), "on007753")?.blobs).toEqual(
      ["on007753", "", "iframe"],
    );
  });

  it("a direct open, which browsers send without a Referer", () => {
    expect(
      embedDataPoint(embedRequest({ "Sec-Fetch-Dest": "document" }), "on007753")?.blobs,
    ).toEqual(["on007753", "", "document"]);
  });

  it("curl, which sends neither header", () => {
    expect(embedDataPoint(embedRequest(), "on007753")?.blobs).toEqual(["on007753", "", "none"]);
  });
});

describe("embedCallPoint: does this response count, and with what id", () => {
  const framed = { Referer: "https://example.org/", "Sec-Fetch-Dest": "iframe" };
  const call = (
    path: string,
    status = 200,
    headers: Record<string, string> = framed,
    method = "GET",
  ) => embedCallPoint(new Request(`https://nemar.org${path}`, { method, headers }), status);

  it("builds the exact point for a 200 on the embed route", () => {
    expect(call("/dataset/on007753/embed?view=sub-05&theme=dark")).toStrictEqual({
      indexes: ["on007753"],
      blobs: ["on007753", "example.org", "iframe"],
      doubles: [1],
    });
  });

  it("counts the trailing-slash spelling", () => {
    expect(call("/dataset/on007753/embed/")?.indexes).toEqual(["on007753"]);
  });

  it("puts the percent-decoded id in both indexes[0] and blobs[0]", () => {
    const point = call("/dataset/on%30%30%37%37%35%33/embed");
    expect(point?.indexes[0]).toBe("on007753");
    expect(point?.blobs[0]).toBe("on007753");
    expect(JSON.stringify(point)).not.toContain("%");
  });

  it("decodes a multi-byte escape the way the page would", () => {
    expect(call("/dataset/caf%C3%A9/embed")?.indexes[0]).toBe("caf\u00e9");
  });

  it("is null for every status that is not exactly 200", () => {
    for (const status of [201, 204, 206, 301, 302, 304, 400, 404, 500, 503]) {
      expect(call("/dataset/on007753/embed", status), String(status)).toBeNull();
    }
  });

  it("is null for a malformed percent escape", () => {
    for (const bad of ["%E0%A4%A", "%", "%zz", "on0077%"]) {
      expect(call(`/dataset/${bad}/embed`), bad).toBeNull();
    }
  });

  it("is null for every path that is not the embed route", () => {
    for (const path of [
      "/",
      "/dataset/on007753",
      "/dataset/on007753/collaborators",
      "/dataset/on007753/embed/extra",
      "/dataset/on007753/%65mbed",
      "/dataset/embed",
      "/dataset//embed",
      "/discover",
    ]) {
      expect(call(path), path).toBeNull();
    }
  });

  it("keeps embedDataPoint's own refusals: HEAD, a prefetch", () => {
    expect(call("/dataset/on007753/embed", 200, framed, "HEAD")).toBeNull();
    expect(
      call("/dataset/on007753/embed", 200, { ...framed, "Sec-Purpose": "prefetch" }),
    ).toBeNull();
    expect(call("/dataset/on007753/embed", 200, { ...framed, Purpose: "prefetch" })).toBeNull();
  });
});
