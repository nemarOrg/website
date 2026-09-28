import { describe, expect, it } from "vitest";
import {
  BADGE_TONE_ICONS,
  badgeIcon,
  badgeLabel,
  badgeTone,
  noticeLevelBadge,
} from "./admin-badges";
import { NOTICE_LEVELS } from "./notices-api";
import { iconPaths } from "./status-icons";

// The shapes UserStatusBadge.astro and ImportStatusBadge.astro pass in.
const USER_LABELS = { pending: "Email not verified", verified: "Base access" };
const USER_TONES = { pending: "warning", verified: "neutral" } as const;

describe("noticeLevelBadge", () => {
  it("draws production's legacy info level as a tip instead of failing the page", () => {
    // api.nemar.org still serves `info` until nemar-cli#1025 reaches main.
    const badge = noticeLevelBadge("info");
    expect(badge.level).toBe("tip");
    expect(badge.icon).toBe("info");
    expect(iconPaths(badge.icon).length).toBeGreaterThan(0);
  });

  it("falls back to the quietest level for a level no build knows", () => {
    expect(noticeLevelBadge("wat")).toEqual({ level: "tip", icon: "info" });
    expect(noticeLevelBadge("")).toEqual({ level: "tip", icon: "info" });
  });

  it("gives every current level its own drawable icon", () => {
    for (const level of NOTICE_LEVELS) {
      const badge = noticeLevelBadge(level);
      expect(badge.level).toBe(level);
      expect(iconPaths(badge.icon).length).toBeGreaterThan(0);
    }
    expect(noticeLevelBadge("critical").icon).toBe("error");
  });
});

describe("user and import status badges", () => {
  it("labels and tones a known status from the component's own maps", () => {
    expect(badgeLabel("pending", USER_LABELS)).toBe("Email not verified");
    expect(badgeTone("pending", USER_TONES)).toBe("warning");
    expect(badgeIcon(badgeTone("pending", USER_TONES))).toBe("warn");
  });

  it("renders an unknown status as a neutral pill with the raw value", () => {
    // A lifecycle state the API shipped before this build knew it.
    expect(badgeLabel("suspended", USER_LABELS)).toBe("suspended");
    expect(badgeTone("suspended", USER_TONES)).toBe("neutral");
    expect(badgeIcon(badgeTone("suspended", USER_TONES))).toBe("neutral");
  });

  it("says unknown for an empty status and ignores inherited keys", () => {
    expect(badgeLabel("", USER_LABELS)).toBe("Unknown");
    expect(badgeLabel("toString", USER_LABELS)).toBe("toString");
    expect(badgeTone("constructor", USER_TONES)).toBe("neutral");
  });

  it("has a drawable icon for every tone, and a neutral one for anything else", () => {
    for (const icon of Object.values(BADGE_TONE_ICONS)) {
      expect(iconPaths(icon).length).toBeGreaterThan(0);
    }
    expect(badgeIcon("info")).toBe("progress");
    expect(badgeIcon("mystery")).toBe("neutral");
  });
});

describe("iconPaths", () => {
  it("draws nothing for a name it does not know rather than throwing", () => {
    expect(iconPaths("ok").length).toBeGreaterThan(0);
    expect(iconPaths("nope")).toEqual([]);
    expect(iconPaths("toString")).toEqual([]);
  });
});
