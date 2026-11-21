/**
 * Source-level guards for the Settings "Email" card (epic nemarOrg/nemar-cli#2260 phase 5), in the
 * style of `test/settings-cli-keys.test.ts`: no Astro rendering harness in this repo, so the page
 * source is read through Vite's `?raw`. The client's load, save and error behavior is tested in
 * `src/lib/mail-prefs-api.test.ts`; this file pins how the card uses it.
 */

import { describe, expect, it } from "vitest";
import { ACCOUNT_COPY } from "../src/lib/account-copy";
import SETTINGS from "../src/pages/settings.astro?raw";

const cardStart = SETTINGS.indexOf('<article class="card" id="email-preferences">');
const cardEnd = SETTINGS.indexOf("</article>", cardStart);
const CARD = SETTINGS.slice(cardStart, cardEnd);

describe("placement", () => {
  it("sits after Appearance and immediately before the Privacy card", () => {
    const appearance = SETTINGS.indexOf("<!-- Appearance block -->");
    const privacy = SETTINGS.indexOf("<!-- Privacy block -->");
    expect(cardStart).toBeGreaterThan(appearance);
    expect(privacy).toBeGreaterThan(cardStart);
    expect(SETTINGS.slice(cardEnd, privacy).trim()).toBe("</article>");
  });
});

describe("the words come from the account copy", () => {
  it("renders labels, descriptions and the recall sentence through the copy helpers", () => {
    expect(CARD).toContain("{mailCategoryLabel(category)}");
    expect(CARD).toContain("{mailCategoryDescription(category)}");
    expect(CARD).toContain("{mailCategoryLabel(RECALL_CATEGORY)}: always on");
    expect(CARD).toContain("{mailRecallWhy()}");
  });

  it("spells no category label or description as a literal", () => {
    for (const [key, value] of Object.entries(ACCOUNT_COPY)) {
      if (!key.startsWith("mail.")) continue;
      expect(CARD, key).not.toContain(value);
    }
  });
});

describe("the switches", () => {
  it("one per switchable category, disabled until the load answers", () => {
    expect(CARD).toContain("{COMMUNITY_MAIL_CATEGORIES.map((category) => (");
    expect(CARD).toMatch(
      /type="checkbox"\s+role="switch"\s+disabled\s+data-mail-pref=\{category\}/,
    );
  });

  it("a locked recall row that is checked, disabled and saved by nothing", () => {
    expect(CARD).toContain("data-mail-pref-locked={RECALL_CATEGORY}");
    const locked = CARD.slice(CARD.indexOf("data-mail-pref-locked"));
    expect(locked).toMatch(/type="checkbox"\s+role="switch"\s+checked\s+disabled/);
    expect(locked).not.toContain("data-mail-pref=");
  });
});

describe("load and save", () => {
  const script = SETTINGS.slice(SETTINGS.indexOf("// ---- Email preferences"));

  it("drives the card through the tested controller and client, never a hand-built fetch", () => {
    expect(script).toContain("const mailCard = createMailPrefsCard({");
    expect(script).toContain("load: () => getMailPreferences(),");
    expect(script).toContain("save: (category, on) => putMailPreference(category, on),");
    expect(script).toContain(
      'input.addEventListener("change", () => void mailCard.change(input));',
    );
    expect(script).not.toMatch(/fetch\(\s*["'`]\/api\/v1\/users/);
  });

  it("offers Try again after a failed load, wired to the same load", () => {
    expect(CARD).toMatch(
      /<button type="button" class="btn btn--ghost" data-mail-prefs-retry hidden>/,
    );
    expect(script).toContain('mailRetry?.addEventListener("click", () => void mailCard.load());');
  });
});
