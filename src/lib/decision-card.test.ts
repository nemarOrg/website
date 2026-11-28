/**
 * The decision card on the approval page (nemarOrg/nemar-cli#2456).
 *
 * Every card comes from `test/fixtures/decision-card/cards.json`, built by nemar-cli's real
 * `buildDecisionCard` at v0.10.57 (its `_provenance` says how), and is attached to a captured Worker
 * detail (`detail-pass`, `detail-hard-reason`) through the real `panelModel` and `panelTree`. Two
 * kinds of derived input appear, each marked where it is used: a card with a field replaced
 * (hostile text, an unknown cue or version) and a detail with `decision_card` replaced.
 */
import { describe, expect, it } from "vitest";
import CARDS from "../../test/fixtures/decision-card/cards.json";
import { fixture } from "../../test/publication-review-fixtures";
import { terminalFlaws } from "../../test/publication-review-web-words";
import { CARD_WORDS, CUE_WORDS, cardTree, plain, readDecisionCard } from "./decision-card";
import { type PublicationReviewDetail, panelModel } from "./publication-review";
import { type PanelNode, panelTree } from "./publication-review-panel";

type CardName = keyof typeof CARDS.cards;
const card = (name: CardName): Record<string, unknown> =>
  structuredClone(CARDS.cards[name]) as Record<string, unknown>;

const detail = (name: string): PublicationReviewDetail =>
  fixture<PublicationReviewDetail>(name).body;
/** A captured detail with its `decision_card` replaced: the openly altered input. */
const withCard = (name: string, c: unknown): PublicationReviewDetail =>
  ({ ...detail(name), decision_card: c }) as PublicationReviewDetail;

const OPTS = {
  datasetId: "nm000712",
  panelId: "pubreq-review-nm000712",
  retryLabel: false,
  reloadHref: "https://example.org/admin/publication-requests",
} as const;

const tree = (d: PublicationReviewDetail): PanelNode[] =>
  panelTree(panelModel(d, { rowStart: "approve" }), OPTS);

function all(nodes: readonly PanelNode[]): PanelNode[] {
  return nodes.flatMap((n) => [n, ...all(n.children ?? [])]);
}
const words = (nodes: readonly PanelNode[]): string[] =>
  all(nodes).flatMap((n) => (n.text === undefined ? [] : [n.text]));
const cardNode = (nodes: readonly PanelNode[]): PanelNode | undefined =>
  all(nodes).find((n) => n.attrs?.class === "pubreq-review-card");
const byClass = (nodes: readonly PanelNode[], cls: string): PanelNode[] =>
  all(nodes).filter((n) => n.attrs?.class?.split(" ").includes(cls));

describe("reading the card", () => {
  it("reads each captured card", () => {
    for (const name of Object.keys(CARDS.cards) as CardName[]) {
      expect(readDecisionCard(card(name)), name).not.toBeNull();
    }
  });

  it("reads no card for a missing one, another version, or one without its parts", () => {
    expect(readDecisionCard(undefined)).toBeNull();
    expect(readDecisionCard(null)).toBeNull();
    expect(readDecisionCard({ ...card("green_approve"), v: 2 })).toBeNull();
    for (const part of ["metadata", "license", "authors", "identifier_screen", "next_action"]) {
      const c = card("green_approve");
      delete c[part];
      expect(readDecisionCard(c), part).toBeNull();
    }
    expect(readDecisionCard({ ...card("green_approve"), questions: "x" })).toBeNull();
  });

  it("never reads an unknown cue as green", () => {
    const c = card("green_approve");
    (c.license as Record<string, unknown>).cue = "chartreuse";
    expect(readDecisionCard(c)?.license.cue).toBe("amber");
  });

  it("removes control and format characters, a right-to-left override among them", () => {
    expect(plain(`a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x1b)}[31mc`)).toBe(
      "ab[31mc",
    );
    expect(plain(42)).toBe("");
  });
});

describe("the card in the panel", () => {
  it("is drawn first, before the review's headline, for a detail that carries one", () => {
    const nodes = tree(withCard("detail-pass", card("green_approve")));
    const first = nodes.findIndex((n) => n.attrs?.class === "pubreq-review-card");
    const headline = nodes.findIndex((n) => n.attrs?.class?.startsWith("pubreq-review-tone--"));
    expect(first).toBe(1);
    expect(headline).toBeGreaterThan(first);
  });

  it("a detail with no card, or an unreadable one, draws the panel as before", () => {
    const before = tree(detail("detail-pass"));
    expect(cardNode(before)).toBeUndefined();
    expect(tree(withCard("detail-pass", null))).toEqual(before);
    expect(tree(withCard("detail-pass", { v: 9 }))).toEqual(before);
  });

  it("prints the golden card's words in the terminal's order and labels", () => {
    const c = cardNode(tree(withCard("detail-pass", card("red_license_review_again"))));
    expect(c).toBeDefined();
    expect(words([c as PanelNode])).toEqual([
      "Decision card",
      "Next",
      "Review the request again: the upstream data's license resolves now, and the review read it unresolved.",
      "License",
      "Red",
      "The LICENSE file names another license than the License field.",
      "Field (written by the depositor)",
      "CC-BY-4.0",
      "LICENSE",
      "matches_other CC-BY-NC-4.0, with text beyond the license",
      "Matcher",
      "scancode-32.5.0+spdx-3.27",
      "Lineage (review, resolved 2026-11-20 09:00:00)",
      "unresolved",
      "Lineage (now, resolved 2026-11-27T13:00:00.000Z)",
      "compatible",
      "Declared (as the source's registry declares it)",
      "10.5281/zenodo.123456: Creative Commons Attribution 4.0 International",
      "Also: The upstream data's license could not be read.",
      "Name",
      "Green",
      "The Name is the upstream dataset's title.",
      "Upstream title (as the source's registry declares it)",
      "Resting EEG",
      "The dataset's own words (written by the depositor), as reviewed",
      ".nemar/metadata.json",
      "Title",
      "Resting EEG in sixty adults",
      "Description",
      "Eyes-open and eyes-closed resting EEG.",
      "License",
      "CC-BY-4.0",
      "Creators",
      "Ada Lovelace",
      "Keywords",
      "EEG; resting state",
      "Funding",
      "NIH (R01-1)",
      "dataset_description.json",
      "Name",
      "Resting EEG",
      "License",
      "CC-BY-4.0",
      "Authors",
      "Ada Lovelace; TBD",
      "Version",
      "1.0.0",
      "Authors",
      "2, 1 placeholder (flagged: TBD)",
      "Questions",
      "the README is complete and agrees with the dataset",
      "pass",
      "note",
      "other",
      "the submission standards and the ethics and provenance statements are met",
      "pass",
      "the authors and the license are real and consistent",
      "unknown",
      "fact",
      "The LICENSE file names another license than the License field.",
      "the name describes the dataset",
      "pass",
      "Identifier screen",
      "Identifier screen: clear",
      "Automatic denial",
      "Automated review disagreed: the confirming run did not confirm the first run's fail, so a person decides.",
    ]);
  });

  it("carries each cue as a word and a class, never color alone", () => {
    const nodes = tree(withCard("detail-pass", card("name_differs")));
    const badges = byClass(nodes, "pubreq-review-card__cue");
    expect(badges.map((b) => [b.text, b.attrs?.class])).toEqual([
      [CUE_WORDS.green, "pubreq-review-card__cue pubreq-review-card__cue--green"],
      [CUE_WORDS.red, "pubreq-review-card__cue pubreq-review-card__cue--red"],
    ]);
    expect(words(nodes)).toContain(
      "Ask the depositor to change the Name: it should be the upstream dataset's title, as its registry gives it, and a version and an author-year naming the dataset's authors may follow it.",
    );
  });

  it("says when the fields are not the reviewed ones", () => {
    const w = words(tree(withCard("detail-pass", card("not_as_reviewed"))));
    expect(w).toContain("The dataset's own words (written by the depositor)");
    expect(w).toContain(
      "Not as reviewed: no review has read these fields yet, so these are the fields NEMAR holds now.",
    );
  });

  it("never prints the terminal's command, and the page's own words name no terminal", () => {
    for (const name of Object.keys(CARDS.cards) as CardName[]) {
      const w = words([cardNode(tree(withCard("detail-pass", card(name)))) as PanelNode]);
      for (const text of w) expect(terminalFlaws(text, 1), `${name}: ${text}`).toEqual([]);
    }
    for (const text of [...Object.values(CARD_WORDS), ...Object.values(CUE_WORDS)]) {
      expect(terminalFlaws(text), text).toEqual([]);
    }
  });

  it("shows approve only when this page offers Approve", () => {
    const approveSentence = "Approve the request: nothing on record withholds its approval.";
    const offered = words(tree(withCard("detail-pass", card("green_approve"))));
    expect(offered).toContain(approveSentence);

    // A captured detail whose hard reason withholds Approve, with the approve card attached.
    const held = panelModel(withCard("detail-hard-reason", card("green_approve")), {
      rowStart: "approve",
    });
    expect(held.approve.kind).not.toBe("offered");
    const w = words(panelTree(held, OPTS));
    expect(w).not.toContain(approveSentence);
    expect(w).toContain(CARD_WORDS.approveWithheld);
  });

  it("an out-of-step detail draws no card", () => {
    const d = { ...withCard("detail-pass", card("green_approve")), gate: "maybe" };
    expect(cardNode(tree(d as unknown as PublicationReviewDetail))).toBeUndefined();
  });
});

describe("depositor text is text", () => {
  it("hostile fields reach the tree only as text, plain", () => {
    // A captured card with the depositor's fields replaced by hostile text.
    const c = card("green_approve");
    const rlo = String.fromCharCode(0x202e);
    const m = c.metadata as Record<string, Record<string, unknown>>;
    m.enrichment.title = `<img src=x onerror=alert(1)>${rlo}`;
    m.dataset_description.name = '<script>alert("x")</script>';
    const nodes = [
      cardTree(readDecisionCard(c) as NonNullable<ReturnType<typeof readDecisionCard>>, true),
    ];
    const w = words(nodes);
    expect(w).toContain("<img src=x onerror=alert(1)>");
    expect(w).toContain('<script>alert("x")</script>');
    expect(w.join("")).not.toContain(rlo);
    // No node is a script or an image: the strings are text, never tags.
    expect(all(nodes).map((n) => n.tag)).not.toContain("script");
    expect(all(nodes).map((n) => n.tag)).not.toContain("img");
    // No attribute carries depositor text.
    for (const n of all(nodes)) {
      for (const v of Object.values(n.attrs ?? {})) expect(v).not.toContain("alert");
    }
  });
});

describe("every string field is made plain", () => {
  const BAD = [0x202e, 0x200b, 0x1b, 0x07, 0x2028, 0x2029].map((c) => String.fromCharCode(c));

  /** The path of every string in a card, at any depth. */
  function stringPaths(x: unknown, at: (string | number)[] = []): (string | number)[][] {
    if (typeof x === "string") return [at];
    if (Array.isArray(x)) return x.flatMap((v, i) => stringPaths(v, [...at, i]));
    if (x !== null && typeof x === "object") {
      return Object.entries(x).flatMap(([k, v]) => stringPaths(v, [...at, k]));
    }
    return [];
  }
  function setAt(root: Record<string, unknown>, path: (string | number)[], value: string) {
    let cur = root as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) cur = cur[key] as Record<string | number, unknown>;
    const last = path[path.length - 1];
    cur[last] = value;
  }
  /** Every string the drawing holds: its words and its attribute values. */
  const drawn = (nodes: readonly PanelNode[]): string[] =>
    all(nodes).flatMap((n) => [
      ...(n.text === undefined ? [] : [n.text]),
      ...Object.values(n.attrs ?? {}),
    ]);

  it("finds the fields to walk (the loop below is not vacuous)", () => {
    expect(stringPaths(card("red_license_review_again")).length).toBeGreaterThan(40);
  });

  for (const name of Object.keys(CARDS.cards) as CardName[]) {
    it(`no control, format or separator character survives in ${name}`, () => {
      for (const path of stringPaths(card(name))) {
        for (const bad of BAD) {
          const c = card(name);
          const original = path.reduce<unknown>(
            (o, k) => (o as Record<string | number, unknown>)[k],
            c,
          ) as string;
          // A captured card with one string field replaced: the openly altered input.
          setAt(c, path, `${original}${bad}x`);
          const view = readDecisionCard(c);
          if (view === null) continue;
          for (const text of drawn([cardTree(view, true)])) {
            expect(
              text.includes(bad),
              `${path.join(".")} U+${bad.charCodeAt(0).toString(16)}`,
            ).toBe(false);
          }
        }
      }
    });
  }

  it("an answer word this page does not know is drawn with the unknown class", () => {
    // A captured card with one answer replaced: the openly altered input.
    const c = card("green_approve");
    (c.questions as Record<string, unknown>[])[0].answer = "maybe so";
    const answers = byClass(
      [cardTree(readDecisionCard(c) as NonNullable<ReturnType<typeof readDecisionCard>>, true)],
      "pubreq-review-card__answer",
    );
    expect(answers[0].attrs?.class).toBe(
      "pubreq-review-card__answer pubreq-review-card__answer--unknown",
    );
  });

  it("each part of the card is under a heading, one level below the card's title", () => {
    const c = cardNode(
      tree(withCard("detail-pass", card("red_license_review_again"))),
    ) as PanelNode;
    expect(c.children?.[0]).toMatchObject({ tag: "h5", text: CARD_WORDS.heading });
    const headings = all([c])
      .filter((n) => n.tag === "h6")
      .map((n) => n.text);
    expect(headings).toEqual([
      CARD_WORDS.next,
      CARD_WORDS.license,
      CARD_WORDS.name,
      "The dataset's own words (written by the depositor), as reviewed",
      CARD_WORDS.authors,
      CARD_WORDS.questions,
      CARD_WORDS.screen,
      CARD_WORDS.autoDeny,
    ]);
  });
});
