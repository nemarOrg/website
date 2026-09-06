/**
 * The block-reason vocabulary and its badge mapping (website#304).
 *
 * The values under test are the ones a current nemar-cli backend writes
 * (`publicationBlockReasonSchema` in `shared/contract/publication.ts`); the
 * point of the module is that an unrecognised one degrades rather than being
 * narrowed away, so the not-in-the-union cases carry as much weight here as
 * the ones in it.
 */

import { describe, expect, it } from "vitest";
import {
  PUBLICATION_BLOCK_REASONS,
  type PublicationBlockReason,
  blockBadgeState,
  blockIsAccountFixable,
} from "./publication-block";

describe("blockBadgeState", () => {
  it("keeps 'Validation failed' for every reason about the DATASET", () => {
    expect(blockBadgeState("bids_validation_failed")).toBe("validation_failed");
    expect(blockBadgeState("bids_validation_pending")).toBe("validation_failed");
    expect(blockBadgeState("bids_validation_in_progress")).toBe("validation_failed");
    expect(blockBadgeState("prescreen_failed")).toBe("validation_failed");
    expect(blockBadgeState("min_requirements_failed")).toBe("validation_failed");
  });

  it("gives owner_name_missing its own label", () => {
    // The whole point of the issue: this one is an account property. Labelling
    // it "Validation failed" sent owners to read CI logs that were green.
    expect(blockBadgeState("owner_name_missing")).toBe("name_required");
  });

  it("degrades an unknown reason to 'blocked' rather than guessing", () => {
    // `publication_requests.block_reason` is free TEXT (nemar-cli migration
    // 0015), so legacy and future values both reach here. Answering
    // "validation_failed" would assert a cause nothing established.
    expect(blockBadgeState("validation failed")).toBe("blocked");
    expect(blockBadgeState("some_reason_added_next_quarter")).toBe("blocked");
  });

  it("treats a missing reason as blocked, not as an error", () => {
    // A blocked row can predate the column, and an older status payload can
    // omit it. Either way the request IS blocked.
    expect(blockBadgeState(null)).toBe("blocked");
    expect(blockBadgeState(undefined)).toBe("blocked");
    expect(blockBadgeState("")).toBe("blocked");
  });

  it("does not resolve prototype keys to a state", () => {
    // A plain-object lookup on an attacker- or legacy-supplied string would
    // find `constructor`/`toString` on the prototype and return a function.
    expect(blockBadgeState("constructor")).toBe("blocked");
    expect(blockBadgeState("toString")).toBe("blocked");
    expect(blockBadgeState("__proto__")).toBe("blocked");
  });

  it("covers every reason in the copied vocabulary", () => {
    // The table is transcribed from another repo, so this is what catches a
    // reason added upstream and pasted into the list without a mapping.
    for (const reason of PUBLICATION_BLOCK_REASONS) {
      expect(blockBadgeState(reason), reason).not.toBe("blocked");
    }
    expect(PUBLICATION_BLOCK_REASONS).toHaveLength(6);
  });
});

describe("blockIsAccountFixable", () => {
  it("is true only where the fix is in the owner's account", () => {
    expect(blockIsAccountFixable("owner_name_missing")).toBe(true);
    for (const reason of PUBLICATION_BLOCK_REASONS.filter(
      (r): r is PublicationBlockReason => r !== "owner_name_missing",
    )) {
      expect(blockIsAccountFixable(reason), reason).toBe(false);
    }
  });

  it("is false for an unknown reason", () => {
    // An unrecognised block might well be account-shaped, but offering a
    // Settings link on a guess would send the owner to change something that
    // is not the problem.
    expect(blockIsAccountFixable("something_new")).toBe(false);
    expect(blockIsAccountFixable(null)).toBe(false);
  });
});
