/**
 * Source-level guards for the owner-facing block panel (website#304).
 *
 * Same rationale as `test/signin-notice.test.ts`: the .astro components have
 * no rendering harness in this repo, and what regressed is a decision
 * expressed in markup — the owner card never rendered `block_reason` or the
 * backend's message at all, so the person who could fix the block got a red
 * badge and nothing else. The mapping itself is covered by
 * `src/lib/publication-block.test.ts`; these pin that the card actually
 * consumes it.
 */

import { describe, expect, it } from "vitest";
import MY_DATASET_CARD from "../src/components/MyDatasetCard.astro?raw";
import PUBLISH_STATE_BADGE from "../src/components/PublishStateBadge.astro?raw";
import { PUBLICATION_BLOCK_REASONS, blockBadgeState } from "../src/lib/publication-block";

describe("PublishStateBadge labels every block state", () => {
  it("carries the two labels the block reasons map to", () => {
    expect(PUBLISH_STATE_BADGE).toContain('name_required: "Name required"');
    expect(PUBLISH_STATE_BADGE).toContain('blocked: "Blocked"');
    expect(PUBLISH_STATE_BADGE).toContain('validation_failed: "Validation failed"');
  });

  it("styles each of them, so a new state cannot land unstyled", () => {
    // A missing rule renders as the neutral base pill, which reads as
    // "Draft" — the one state a blocked dataset must not look like.
    for (const state of new Set(PUBLICATION_BLOCK_REASONS.map(blockBadgeState))) {
      expect(PUBLISH_STATE_BADGE, state).toContain(`.publish-state-badge--${state} {`);
    }
    expect(PUBLISH_STATE_BADGE).toContain(".publish-state-badge--blocked {");
  });
});

describe("the owner's card explains a block", () => {
  it("renders the backend's message rather than re-deriving copy", () => {
    // The message is the only place the fix is spelled out, and for
    // owner_name_missing it names one of two routes depending on whether the
    // account has a verified ORCID link — which this card cannot see.
    expect(MY_DATASET_CARD).toContain("publishStatus.message");
    expect(MY_DATASET_CARD).toContain("my-dataset-card__block-text");
  });

  it("falls back to the raw reason when an older backend sent no message", () => {
    // A bare code an admin can be quoted beats an explanation nobody wrote.
    expect(MY_DATASET_CARD).toMatch(/blockMessage \?[\s\S]{0,400}<code>\{blockReason\}<\/code>/);
  });

  it("renders nothing at all when the request is not blocked", () => {
    // The panel is gated on the reason, not on the presence of a status: a
    // draft or an awaiting-review card must not sprout an empty amber box.
    expect(MY_DATASET_CARD).toMatch(/\{blockReason && \(\s*<div class="my-dataset-card__block"/);
    expect(MY_DATASET_CARD).toContain(
      'const blockReason = publishStatus?.status === "blocked" ? publishStatus.block_reason : null;',
    );
  });

  it("offers the Settings link only for an account-shaped block", () => {
    expect(MY_DATASET_CARD).toContain("blockIsAccountFixable");
    expect(MY_DATASET_CARD).toMatch(/\{blockFixInSettings && \(\s*<a/);
  });

  it("links the CI run only when the backend supplied one", () => {
    // `ci_url` is withheld for a dataset with no repo, and for a reason that
    // has nothing to do with the repository there is no run to look at.
    expect(MY_DATASET_CARD).toMatch(/\{blockCiUrl && \(\s*<a/);
  });

  it("shows the message as inert text, never as markup", () => {
    expect(MY_DATASET_CARD).not.toMatch(/set:html[\s\S]{0,80}blockMessage/);
  });
});
