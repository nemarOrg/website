import { describe, expect, it } from "vitest";
import { renderJsonPreview } from "./render-file-preview-json";

describe("renderJsonPreview", () => {
  it("returns the empty-file message on an empty string", () => {
    expect(renderJsonPreview("")).toContain("This file is empty");
  });

  it("wraps the body in <pre class='preview__json'>", () => {
    const html = renderJsonPreview('{"a": 1}');
    expect(html).toContain(`<pre class="preview__json">`);
    expect(html).toContain("<code>");
  });

  it("syntax-colors string keys with span.json-key", () => {
    const html = renderJsonPreview('{"name": "Yahya"}');
    expect(html).toMatch(/<span class="json-key">[^<]*name[^<]*<\/span>/);
  });

  it("syntax-colors string values with span.json-str", () => {
    const html = renderJsonPreview('{"name": "Yahya"}');
    expect(html).toMatch(/<span class="json-str">[^<]*Yahya[^<]*<\/span>/);
  });

  it("syntax-colors numbers with span.json-num", () => {
    const html = renderJsonPreview('{"age": 42, "pi": 3.14}');
    expect(html).toContain(`<span class="json-num">42</span>`);
    expect(html).toContain(`<span class="json-num">3.14</span>`);
  });

  it("syntax-colors true / false / null with span.json-kw", () => {
    const html = renderJsonPreview('{"on": true, "off": false, "missing": null}');
    expect(html).toContain(`<span class="json-kw">true</span>`);
    expect(html).toContain(`<span class="json-kw">false</span>`);
    expect(html).toContain(`<span class="json-kw">null</span>`);
  });

  it("falls back to verbatim text + parse-error banner on malformed JSON", () => {
    const html = renderJsonPreview('{"name": "Yahya"');
    expect(html).toContain("Invalid JSON");
    expect(html).toContain(`role="alert"`);
    // The verbatim content is still rendered inside the <pre>.
    expect(html).toContain("Yahya");
  });

  it("escapes HTML characters in keys and string values", () => {
    const html = renderJsonPreview('{"<bad>": "<script>"}');
    expect(html).not.toContain("<bad>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;bad&gt;");
    expect(html).toContain("&lt;script&gt;");
  });

  it("handles nested objects and arrays at the BIDS-sidecar depth (one level)", () => {
    const html = renderJsonPreview(
      '{"SamplingFrequency": 500, "EEGReference": "Cz", "PowerLineFrequency": 60}',
    );
    expect(html).toContain("SamplingFrequency");
    expect(html).toContain("EEGReference");
    expect(html).toContain(`<span class="json-num">500</span>`);
    expect(html).toContain(`<span class="json-num">60</span>`);
  });

  it('colorizes string elements inside arrays (Channels = ["Fp1", "Fp2"])', () => {
    const html = renderJsonPreview('{"Channels": ["Fp1", "Fp2"]}');
    expect(html).toContain(`<span class="json-key">&quot;Channels&quot;</span>`);
    expect(html).toContain(`<span class="json-str">&quot;Fp1&quot;</span>`);
    expect(html).toContain(`<span class="json-str">&quot;Fp2&quot;</span>`);
  });

  it("colorizes numeric elements inside arrays (Counts = [1, 2, 3])", () => {
    const html = renderJsonPreview('{"Counts": [1, 2, 3]}');
    expect(html).toContain(`<span class="json-num">1</span>`);
    expect(html).toContain(`<span class="json-num">2</span>`);
    expect(html).toContain(`<span class="json-num">3</span>`);
  });

  it("handles a top-level array (no enclosing object)", () => {
    const html = renderJsonPreview('["a", "b", 42, true, null]');
    expect(html).toContain(`<span class="json-str">&quot;a&quot;</span>`);
    expect(html).toContain(`<span class="json-num">42</span>`);
    expect(html).toContain(`<span class="json-kw">true</span>`);
    expect(html).toContain(`<span class="json-kw">null</span>`);
  });

  it("handles deeply nested mixed structures", () => {
    const html = renderJsonPreview('{"a": {"b": {"c": [1, "two", true]}}}');
    expect(html).toContain(`<span class="json-key">&quot;c&quot;</span>`);
    expect(html).toContain(`<span class="json-num">1</span>`);
    expect(html).toContain(`<span class="json-str">&quot;two&quot;</span>`);
    expect(html).toContain(`<span class="json-kw">true</span>`);
  });

  // Note: scientific-notation input is unreachable in the rendered output
  // because `JSON.parse + JSON.stringify(_, null, 2)` normalizes
  // `1.5e-3` → `"0.0015"` before the tokenizer ever sees it. No test
  // pinning the tokenizer behavior on `1.5e-3` would be meaningful.
});
