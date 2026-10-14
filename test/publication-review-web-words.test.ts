import { describe, expect, it } from "vitest";
import { terminalFlaws } from "./publication-review-web-words";

describe("terminalFlaws tier 1 (what only a terminal can act on)", () => {
  it("flags a nemar command", () => {
    expect(terminalFlaws("Run nemar admin publish start nm000123 now.", 1)).toContain(
      "a nemar command",
    );
    expect(terminalFlaws("nemar admin pr-reviews", 1)).toContain("a nemar command");
  });

  it("flags a flag", () => {
    expect(terminalFlaws("Approve anyway (--force).", 1)).toContain("a flag");
  });

  it("flags a placeholder", () => {
    expect(terminalFlaws("Open <dataset> first.", 1)).toContain("a placeholder");
  });

  it("flags a backtick", () => {
    expect(terminalFlaws("Open `main` first.", 1)).toContain("a backtick");
  });

  it("passes the platform name NEMAR and plain prose", () => {
    expect(terminalFlaws("NEMAR has a release of it", 1)).toEqual([]);
    expect(terminalFlaws("Nothing here names a terminal.", 1)).toEqual([]);
  });

  it("does not apply the tier 2 words", () => {
    expect(terminalFlaws("from a terminal, the command, the CLI", 1)).toEqual([]);
  });
});

describe("terminalFlaws tier 2 (words that point at a terminal)", () => {
  it("is the default tier and flags terminal, command and CLI", () => {
    expect(terminalFlaws("from a terminal")).toContain("the word terminal");
    expect(terminalFlaws("Run the command")).toContain("the word command");
    expect(terminalFlaws("Use the CLI")).toContain("the word CLI");
  });

  it("applies tier 1 as well", () => {
    expect(terminalFlaws("nemar admin docs (--force)", 2)).toEqual(
      expect.arrayContaining(["a nemar command", "a flag"]),
    );
  });

  it("passes NEMAR and words that merely contain a flagged one", () => {
    expect(terminalFlaws("NEMAR has a release of it")).toEqual([]);
    expect(terminalFlaws("A commander and a client climbed.")).toEqual([]);
  });
});
