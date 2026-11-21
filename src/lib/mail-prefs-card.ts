/**
 * The Settings "Email" card's behavior (epic nemarOrg/nemar-cli#2260 phase 5), apart from the DOM so
 * every rule is unit-tested: `settings.astro` hands it the switch inputs and two callbacks.
 *
 * RULES.
 * - The switches stay disabled until a load answers; a failed load says why and offers "Try again".
 * - A change is saved at once. While its PUT is in flight that switch is disabled and is IN FLIGHT:
 *   no answer for another switch (a PUT's full set, a re-fetch) may overwrite or re-enable it.
 * - A refused save (a 4xx with the backend's sentence) puts the switch back.
 * - A save whose outcome is unknown (the network, a 5xx) does not guess: the card re-reads the
 *   account and shows that. If the re-read fails too, the switches are disabled again and the card
 *   offers "Try again", so no switch shows a state nobody confirmed.
 *
 * Browser-safe; imports only the client and the category list.
 */

import {
  type CommunityMailCategory,
  type CommunityMailPreferences,
  isCommunityMailCategory,
} from "./mail-categories";
import { type MailPreferencesResult, mailPreferencesErrorText } from "./mail-prefs-api";

/** What the card needs of a switch: an `<input type="checkbox">` satisfies it. */
export interface MailPrefSwitch {
  checked: boolean;
  disabled: boolean;
  readonly dataset: { mailPref?: string };
}

export interface MailPrefsCardDeps {
  readonly switches: readonly MailPrefSwitch[];
  readonly load: () => Promise<MailPreferencesResult>;
  readonly save: (category: CommunityMailCategory, on: boolean) => Promise<MailPreferencesResult>;
  /** Show a sentence, or clear it with null. */
  readonly message: (text: string | null, tone?: "error" | "success") => void;
  /** Show or hide the "Try again" control. */
  readonly retryVisible: (visible: boolean) => void;
}

/** True when a failed save may or may not have been applied. */
export function saveOutcomeUnknown(result: Extract<MailPreferencesResult, { ok: false }>): boolean {
  return result.status === "network" || result.status >= 500;
}

export interface MailPrefsCard {
  /** Load the account's preferences (also what "Try again" calls). */
  load(): Promise<void>;
  /** Save the switch the person just changed. */
  change(input: MailPrefSwitch): Promise<void>;
  /** The categories whose save is in flight. For the tests. */
  readonly inFlight: ReadonlySet<string>;
}

export function createMailPrefsCard(deps: MailPrefsCardDeps): MailPrefsCard {
  const inFlight = new Set<string>();
  // Bumped every time an answer is shown. A read captures it when it starts and is discarded if it
  // moved meanwhile: a newer answer (a PUT's full set) is already on screen.
  let generation = 0;
  let loading: Promise<void> | null = null;

  const render = (prefs: CommunityMailPreferences): void => {
    generation++;
    for (const input of deps.switches) {
      const category = input.dataset.mailPref;
      if (!isCommunityMailCategory(category) || inFlight.has(category)) continue;
      input.checked = prefs[category];
      input.disabled = false;
    }
  };

  const lockSettled = (): void => {
    for (const input of deps.switches) {
      const category = input.dataset.mailPref;
      if (!isCommunityMailCategory(category) || inFlight.has(category)) continue;
      input.disabled = true;
    }
  };

  /**
   * Read the account and show it, or lock the settled switches and offer "Try again". `"stale"`
   * when a newer answer was shown while the read was out; such a read changes nothing.
   */
  const refresh = async (): Promise<MailPreferencesResult | "stale"> => {
    const startedAt = generation;
    const result = await deps.load();
    if (generation !== startedAt) return "stale";
    if (result.ok) {
      render(result.prefs);
      deps.retryVisible(false);
    } else {
      lockSettled();
      deps.retryVisible(true);
    }
    return result;
  };

  return {
    inFlight,

    load(): Promise<void> {
      // One read at a time: a double-clicked "Try again" sends one request.
      if (loading) return loading;
      loading = (async () => {
        try {
          deps.retryVisible(false);
          const result = await refresh();
          if (result === "stale") return;
          if (result.ok) deps.message(null);
          else deps.message(mailPreferencesErrorText(result), "error");
        } finally {
          loading = null;
        }
      })();
      return loading;
    },

    async change(input: MailPrefSwitch): Promise<void> {
      const category = input.dataset.mailPref;
      if (!isCommunityMailCategory(category) || inFlight.has(category)) return;
      const wanted = input.checked;
      inFlight.add(category);
      input.disabled = true;
      deps.message(null);
      let result: MailPreferencesResult;
      try {
        result = await deps.save(category, wanted);
      } finally {
        inFlight.delete(category);
      }
      if (result.ok) {
        render(result.prefs);
        deps.message("Saved.", "success");
        return;
      }
      const failure = mailPreferencesErrorText(result);
      if (!saveOutcomeUnknown(result)) {
        input.checked = !wanted;
        input.disabled = false;
        deps.message(failure, "error");
        return;
      }
      // The save may or may not have landed: show what the account says now.
      const reread = await refresh();
      if (reread === "stale") return;
      if (!reread.ok) {
        // Nothing confirmed the change: show the value it had before, locked until "Try again".
        input.checked = !wanted;
      }
      deps.message(
        reread.ok ? `${failure} Your preferences below are as NEMAR has them now.` : failure,
        "error",
      );
    },
  };
}
