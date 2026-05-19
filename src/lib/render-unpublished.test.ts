import { describe, expect, it } from "vitest";
import { renderUnpublishedReadme } from "./render-readme";
import { renderUnpublishedTree } from "./render-tree";

describe("renderUnpublishedReadme", () => {
  it("returns the unpublished heading", () => {
    expect(renderUnpublishedReadme()).toContain("<h2>Not yet published</h2>");
  });

  it("uses the readme__empty wrapper class", () => {
    expect(renderUnpublishedReadme()).toContain('class="readme__empty"');
  });

  it("explains the unpublished state to the user", () => {
    expect(renderUnpublishedReadme()).toContain("no published version is available");
  });
});

describe("renderUnpublishedTree", () => {
  it("returns the unpublished heading", () => {
    expect(renderUnpublishedTree()).toContain("<h2>Not yet published</h2>");
  });

  it("uses the detail__no-manifest wrapper class", () => {
    // Same class as renderNoManifest so CSS rules apply to both states.
    expect(renderUnpublishedTree()).toContain('class="detail__no-manifest"');
  });

  it('uses role="note" not role="alert"', () => {
    // renderNoManifest uses role="alert" for the "published but manifest is
    // missing" failure case; the unpublished case is informational, not an
    // error, so it must use role="note". Pinning here so a future edit
    // doesn't silently swap them.
    expect(renderUnpublishedTree()).toContain('role="note"');
    expect(renderUnpublishedTree()).not.toContain('role="alert"');
  });

  it("explains that the tree will appear after a release", () => {
    expect(renderUnpublishedTree()).toContain("once a version is released");
  });
});
