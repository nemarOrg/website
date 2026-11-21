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

  it("loads and saves through the client module, never a hand-built fetch", () => {
    expect(script).toContain("void getMailPreferences().then(");
    expect(script).toContain("await putMailPreference(category, wanted)");
    expect(script).not.toMatch(/fetch\(\s*["'`]\/api\/v1\/users/);
  });

  it("puts a switch back and shows the error text when a save is refused", () => {
    expect(script).toMatch(
      /input\.checked = !wanted;\s*input\.disabled = false;\s*setMsg\(mailMsg, mailPreferencesErrorText\(result\), "error"\);/,
    );
  });
});
