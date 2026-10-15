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

/**
 * The tokens, read from disk: Vitest blanks every stylesheet it imports, `?raw` included, and
 * `astro check` has no node types, so `node:fs` is reached without a static import (the same escape
 * hatch as `test/publication-review-page.test.ts`).
 */
async function readTokens(): Promise<string> {
  const specifier = "node:fs";
  const fs: { readFileSync(path: string, encoding: string): string } = await import(
    /* @vite-ignore */ specifier
  );
  return fs.readFileSync(
    decodeURIComponent(new URL("../src/styles/tokens.css", import.meta.url).pathname),
    "utf8",
  );
}
const TOKENS = await readTokens();

describe("PublishStateBadge labels every block state", () => {
  it("carries a label for each state the block reasons map to", () => {
    expect(PUBLISH_STATE_BADGE).toContain('validation_failed: "Validation failed"');
    // Distinct from "Validation failed" on purpose: the message under this
    // badge says to wait, and the two must not disagree.
    expect(PUBLISH_STATE_BADGE).toContain('validation_pending: "Validation pending"');
    expect(PUBLISH_STATE_BADGE).toContain('name_required: "Name required"');
    expect(PUBLISH_STATE_BADGE).toContain('identifiers_found: "Identifiers found"');
    expect(PUBLISH_STATE_BADGE).toContain('blocked: "Blocked"');
  });

  it("styles identifiers_found in the danger family, not the amber one", () => {
    // The dataset itself holds the identifier and CI is not pending, so this
    // is neither the amber "wait" nor the amber "fix your account" tone.
    const rule = PUBLISH_STATE_BADGE.match(
      /\.publish-state-badge--identifiers_found \{([^}]*)\}/,
    )?.[1];
    expect(rule).toBeDefined();
    expect(rule).toContain("var(--color-danger)");
    expect(rule).not.toContain("var(--color-warning)");
  });

  it("lifts its text in both dark theme branches, because --color-danger has no dark value", () => {
    // `--color-danger` (#b91c1c) is the same in every theme: about 2.5:1 on the dark card, well
    // under the 4.5:1 that 12 px text needs. The admin error text token has a lifted dark value
    // (about 8.6:1 on the same card), so the dark rules use it. Both branches are required: the
    // media query for the operating system's default and the attribute for an explicit choice.
    expect(TOKENS).toMatch(/--admin-error-text:\s*#b91c1c/);
    const values = [...TOKENS.matchAll(/--admin-error-text:\s*(#[0-9a-f]{6})/g)].map((m) => m[1]);
    expect(values, "one light value and one per dark branch").toHaveLength(3);
    const [light, ...dark] = values;
    expect(light).toBe("#b91c1c");
    for (const value of dark) {
      expect(value, "a dark branch that repeats the light value lifts nothing").not.toBe(light);
    }
    expect(dark[0], "the two dark branches say one colour").toBe(dark[1]);
    const media = PUBLISH_STATE_BADGE.match(
      /@media \(prefers-color-scheme: dark\) \{\s*:global\(:root:not\(\[data-theme="light"\]\)\) \.publish-state-badge--identifiers_found \{([^}]*)\}/,
    )?.[1];
    const attribute = PUBLISH_STATE_BADGE.match(
      /:global\(:root\[data-theme="dark"\]\) \.publish-state-badge--identifiers_found \{([^}]*)\}/,
    )?.[1];
    for (const rule of [media, attribute]) {
      expect(rule).toBeDefined();
      expect(rule).toMatch(/color:\s*var\(--admin-error-text\)/);
    }
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
