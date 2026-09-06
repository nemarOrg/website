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
  it("carries a label for each state the block reasons map to", () => {
    expect(PUBLISH_STATE_BADGE).toContain('validation_failed: "Validation failed"');
    // Distinct from "Validation failed" on purpose: the message under this
    // badge says to wait, and the two must not disagree.
    expect(PUBLISH_STATE_BADGE).toContain('validation_pending: "Validation pending"');
    expect(PUBLISH_STATE_BADGE).toContain('name_required: "Name required"');
    expect(PUBLISH_STATE_BADGE).toContain('blocked: "Blocked"');
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
    expect(MY_DATASET_CARD).toContain("<code>{blockReason}</code>");
  });

  it("is gated on the blocked STATUS, not on there being a reason to quote", () => {
    // `block_reason` is a nullable free-TEXT column (nemar-cli migration
    // 0015), so a blocked row can carry no reason at all — and gating the
    // panel on it left exactly those rows showing the "Blocked" badge with
    // nothing under it, which is the failure this change exists to fix.
    // `blockBadgeState(null)` already answers "blocked"; the panel agrees.
    expect(MY_DATASET_CARD).toContain('const isBlocked = publishStatus?.status === "blocked";');
    expect(MY_DATASET_CARD).toMatch(/\{isBlocked && \(\s*<div class="my-dataset-card__block"/);
    // The reason must not be what opens the panel.
    expect(MY_DATASET_CARD).not.toMatch(
      /\{blockReason && \(\s*<div class="my-dataset-card__block"/,
    );
  });

  it("renders nothing at all when the request is not blocked", () => {
    // A draft or an awaiting-review card must not sprout an empty amber box,
    // so the panel has exactly one guard and it is the status one asserted
    // above. `isBlocked` is false for every other branch of the union.
    const panelGuards = MY_DATASET_CARD.match(/<div class="my-dataset-card__block"/g) ?? [];
    expect(panelGuards).toHaveLength(1);
  });

  it("still says something when neither a message nor a reason arrived", () => {
    // Three branches, in decreasing order of what the wire told us: the
    // backend's sentence, the bare code an admin can be quoted, and — when
    // there is neither — a sentence that quotes nothing. An owner looking at
    // a badge with no text has no way to know it is not their mistake.
    expect(MY_DATASET_CARD).toContain(
      "Publication is blocked. Contact an admin if this is unexpected.",
    );
    // Ordered by index rather than by a regex window: the branches are what
    // matters, and a character budget between them is a number this test
    // would have to keep re-guessing every time a comment moves.
    const messageBranch = MY_DATASET_CARD.indexOf("blockMessage ? (");
    const reasonBranch = MY_DATASET_CARD.indexOf(") : blockReason ? (");
    const bareBranch = MY_DATASET_CARD.indexOf(
      "Publication is blocked. Contact an admin if this is unexpected.",
    );
    expect(messageBranch).toBeGreaterThan(-1);
    expect(reasonBranch).toBeGreaterThan(messageBranch);
    expect(bareBranch).toBeGreaterThan(reasonBranch);
  });

  it("offers the Settings link only for an account-shaped block", () => {
    expect(MY_DATASET_CARD).toContain("blockIsAccountFixable");
    expect(MY_DATASET_CARD).toMatch(/\{blockFixInSettings && \(\s*<a/);
  });

  it("links the Name ROW, the one anchor that always renders", () => {
    // website#306 made `#account-name` canonical for exactly this reason: the
    // given/family INPUTS render only for an account with no verified ORCID
    // iD, and `owner_name_missing` reaches the other kind too — a verified iD
    // whose record publishes no name. Linking an input id sent that person,
    // the one this panel is written for, to an anchor not on the page.
    expect(MY_DATASET_CARD).toContain('href="/settings#account-name"');
    expect(MY_DATASET_CARD).not.toContain("#account-given-name");
    expect(MY_DATASET_CARD).not.toContain("#account-family-name");
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
