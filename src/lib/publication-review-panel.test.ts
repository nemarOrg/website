/**
 * The drawing of the review panel, as data.
 *
 * Every model comes from a captured answer of the real Worker (`test/fixtures/publication-review/`)
 * through the real `panelModel`; the tree is read back for the words it holds, so deleting one
 * sentence, line, label, prompt or button from `panelTree` turns a test red. Three kinds of derived
 * input appear, each marked where it is used: a captured detail with a field replaced (the review's
 * fact notes and a document label that no capture carries, an unknown tone word), a literal failure
 * built by the lib's own `FailureView` shape, and literal text fed to a leaf function.
 */
import { describe, expect, it } from "vitest";
import { fixture } from "../../test/publication-review-fixtures";
import { terminalFlaws } from "../../test/publication-review-web-words";
import {
  ACK_MAX,
  HARD_REASON_LINE,
  NO_START_LINE,
  OUT_OF_STEP,
  type PublicationReviewDetail,
  UI_WORDS,
  panelModel,
} from "./publication-review";
import { PUBLICATION_REVIEW_COPY as COPY } from "./publication-review-copy";
import {
  BUSY_FAILURE,
  DRAW_FAILURE,
  PANEL_WORDS,
  type PanelNode,
  STALE_ROW_FAILURE,
  errorTree,
  failureTree,
  loadingTree,
  panelTitle,
  panelTree,
  rowIsStale,
  staleRowTree,
  titleIdOf,
  toggleLabels,
  toneClass,
} from "./publication-review-panel";
import PANEL_SOURCE from "./publication-review-panel.ts?raw";

const detail = (name: string): PublicationReviewDetail =>
  fixture<PublicationReviewDetail>(name).body;

/** A captured detail with some fields replaced: the openly altered input (see the header). */
const altered = (name: string, patch: Record<string, unknown>): PublicationReviewDetail =>
  ({ ...detail(name), ...patch }) as PublicationReviewDetail;

const OPTS = {
  datasetId: "nm000701",
  panelId: "pubreq-review-nm000701",
  retryLabel: false,
  reloadHref: "https://example.org/admin/publication-requests",
} as const;

function treeOf(
  d: PublicationReviewDetail,
  rowStart: "approve" | "resume" | null = "approve",
  extra: Partial<Parameters<typeof panelTree>[1]> = {},
): PanelNode[] {
  return panelTree(panelModel(d, { rowStart }), { ...OPTS, ...extra });
}

/** Every node of a forest, depth first. */
function all(nodes: readonly PanelNode[]): PanelNode[] {
  return nodes.flatMap((n) => [n, ...all(n.children ?? [])]);
}
/** Every word of a forest, in reading order. */
const words = (nodes: readonly PanelNode[]): string[] =>
  all(nodes).flatMap((n) => (n.text === undefined ? [] : [n.text]));
const withAttr = (nodes: readonly PanelNode[], attr: string): PanelNode[] =>
  all(nodes).filter((n) => n.attrs !== undefined && attr in n.attrs);
const withClass = (nodes: readonly PanelNode[], cls: string): PanelNode[] =>
  all(nodes).filter((n) => n.attrs?.class?.split(" ").includes(cls));
const textsOfClass = (nodes: readonly PanelNode[], cls: string): string[] =>
  withClass(nodes, cls).flatMap((n) => (n.text === undefined ? [] : [n.text]));

describe("the title", () => {
  it("names the dataset, so every row's panel has its own name", () => {
    const [title] = treeOf(detail("detail-pass"));
    expect(title.tag).toBe("h4");
    expect(title.text).toBe(panelTitle("nm000701"));
    expect(title.text).toContain("nm000701");
    expect(title.text).toContain(UI_WORDS.headings.review);
    expect(title.attrs?.id).toBe(titleIdOf(OPTS.panelId));
  });
});

describe("the withheld and read-only lines of the Approve control", () => {
  it("prints the hard-reason line and the screen-gate copy for a blocking screen", () => {
    const controls = withClass(treeOf(detail("detail-hard-reason")), "pubreq-review__controls");
    expect(controls).toHaveLength(1);
    const lines = textsOfClass(controls, "pubreq-review__text");
    expect(lines).toEqual([HARD_REASON_LINE, COPY["screen_gate.blocks"]]);
  });

  it("prints the blocked line for a blocked request", () => {
    const controls = withClass(treeOf(detail("detail-blocked"), null), "pubreq-review__controls");
    expect(textsOfClass(controls, "pubreq-review__text")).toEqual([COPY["approve.blocked"]]);
  });

  it("prints the no-review-row copy where the Worker offers a start, and the page's own line where it does not", () => {
    const startable = withClass(
      treeOf(detail("detail-not-started-startable")),
      "pubreq-review__controls",
    );
    expect(textsOfClass(startable, "pubreq-review__text")).toEqual([COPY["gate.no_review_row"]]);
    const notStartable = withClass(
      treeOf(detail("detail-approving-not-startable")),
      "pubreq-review__controls",
    );
    expect(textsOfClass(notStartable, "pubreq-review__text")).toEqual([NO_START_LINE]);
  });

  it("prints the unavailable control's sentence, and nothing of the review, for a detail the page cannot read", () => {
    const outOfStep = altered("detail-pass", { start_offered: undefined });
    const nodes = treeOf(outOfStep);
    const w = words(nodes);
    expect(w).toContain(OUT_OF_STEP);
    expect(w).not.toContain(detail("detail-pass").description.headline);
    expect(withAttr(nodes, "data-pubreq-panel-approve")).toEqual([]);
  });

  it("prints the unavailable words for no detail at all", () => {
    const nodes = panelTree(panelModel(null, { rowStart: "approve" }), { ...OPTS });
    expect(words(nodes)).toContain(COPY["approve.unavailable"]);
    expect(withAttr(nodes, "data-pubreq-panel-approve")).toEqual([]);
  });

  it("prints the resume notice inside the controls for a run that has started publishing", () => {
    const controls = withClass(
      treeOf(detail("detail-started-publishing")),
      "pubreq-review__controls",
    );
    expect(textsOfClass(controls, "pubreq-review__text")).toEqual([COPY["approve.resume"]]);
  });
});

describe("the headline, the identifier screen and the standing line", () => {
  const d = detail("detail-needs-override");
  const nodes = treeOf(d);

  it("prints the review's headline in its tone", () => {
    const headline = withClass(nodes, toneClass(d.description.tone));
    expect(headline.map((n) => n.text)).toContain(d.description.headline);
  });

  it("prints the screen's headline in its tone and every one of its lines", () => {
    const screen = all(nodes).find(
      (n) => n.tag === "section" && n.children?.some((c) => c.text === UI_WORDS.headings.screen),
    );
    expect(screen, "no screen section").toBeDefined();
    const inside = all([screen as PanelNode]);
    expect(inside.find((n) => n.text === d.identifier_screen.headline)?.attrs?.class).toBe(
      toneClass(d.identifier_screen.tone),
    );
    const items = inside.filter((n) => n.tag === "li").map((n) => n.text);
    expect(items).toEqual(d.identifier_screen.lines);
    expect(items.length).toBeGreaterThan(0);
  });

  it("prints the standing line only for a request the review applies to", () => {
    expect(textsOfClass(nodes, "pubreq-review__text--muted")).toEqual([
      COPY["review.not_assessed"],
    ]);
    const notApplicable = treeOf(detail("detail-not-applicable"));
    expect(textsOfClass(notApplicable, "pubreq-review__text--muted")).toEqual([]);
  });
});

describe("the reasons", () => {
  it("prints each reason's statement, its cure and both tags, hard first", () => {
    const d = detail("detail-blocked");
    const [hard, override] = d.reasons;
    expect(hard.cleared_by).toBe("nothing");
    expect(override.cleared_by).toBe("override");
    const cards = withClass(treeOf(d, null), "pubreq-review__reason").map((card) => words([card]));
    expect(cards).toHaveLength(2);
    const classTag = (r: { class: "fail" | "unknown" }) => UI_WORDS.classTags[r.class];
    expect(cards[0]).toEqual([
      classTag(hard),
      UI_WORDS.clearedTags.nothing,
      hard.statement,
      hard.cure,
    ]);
    expect(cards[1]).toEqual([
      classTag(override),
      UI_WORDS.clearedTags.override,
      override.statement,
      override.cure,
    ]);
  });

  it("prints the withheld words in place of the cards when the Worker is out of step", () => {
    const nodes = treeOf(altered("detail-needs-override", { start_offered: undefined }));
    expect(withClass(nodes, "pubreq-review__reason")).toEqual([]);
    expect(words(nodes)).toContain(OUT_OF_STEP);
    expect(withAttr(nodes, "data-pubreq-panel-approve")).toEqual([]);
  });
});

describe("what the platform's checks found and what the model wrote", () => {
  it("prints each fact note under its heading", () => {
    // Derived: no capture carries a fact note; the review record gets two.
    const base = detail("detail-pass");
    const d = {
      ...base,
      review: { ...base.review, fact_notes: [{ text: "FACT-ONE" }, { text: "FACT-TWO" }] },
    } as PublicationReviewDetail;
    const nodes = treeOf(d);
    const section = all(nodes).find(
      (n) => n.tag === "section" && n.children?.some((c) => c.text === UI_WORDS.headings.checks),
    );
    expect(section).toBeDefined();
    expect(
      all([section as PanelNode])
        .filter((n) => n.tag === "li")
        .map((n) => n.text),
    ).toEqual(["FACT-ONE", "FACT-TWO"]);
  });

  it("prints no heading for fact notes when there are none", () => {
    expect(words(treeOf(detail("detail-pass")))).not.toContain(UI_WORDS.headings.checks);
  });

  it("prints the model's summary and findings under labels that say the model wrote them", () => {
    const d = detail("detail-needs-override");
    const w = words(treeOf(d));
    expect(w).toContain(`${UI_WORDS.headings.summary} (${COPY["review.model_summary_label"]})`);
    expect(w).toContain(`${UI_WORDS.headings.notes} (${COPY["review.model_findings_label"]})`);
    expect(w).toContain(d.review?.summary);
    const finding = d.review?.findings[0];
    expect(w).toContain(finding?.label);
    expect(w).toContain(finding?.document_label);
    expect(w).toContain(finding?.note);
  });

  it("prints no model section for a review the model never wrote", () => {
    const w = words(treeOf(detail("detail-hard-reason")));
    expect(w.join("\n")).not.toContain(COPY["review.model_summary_label"]);
  });
});

describe("the controls the administrator fills in", () => {
  it("offers the confirmation box with its label, and the reason field with its prompt, when both are asked for", () => {
    const nodes = treeOf(detail("detail-needs-ack-and-override"));
    const box = withAttr(nodes, "data-pubreq-override");
    expect(box).toHaveLength(1);
    expect(box[0].tag).toBe("input");
    expect(box[0].attrs?.type).toBe("checkbox");
    const check = withClass(nodes, "pubreq-review__check");
    expect(words(check)).toEqual([COPY["approve.override_control"]]);

    const area = withAttr(nodes, "data-pubreq-reason");
    expect(area).toHaveLength(1);
    expect(area[0].tag).toBe("textarea");
    expect(area[0].attrs?.maxlength).toBe(String(ACK_MAX));
    const label = all(nodes).find((n) => n.tag === "label" && n.attrs?.for === area[0].attrs?.id);
    expect(label?.text).toBe(COPY["screen_gate.acknowledge"]);
    expect(area[0].attrs?.id).toBe(`${OPTS.panelId}-reason`);
  });

  it("offers neither when neither is asked for", () => {
    const nodes = treeOf(detail("detail-pass"));
    expect(withAttr(nodes, "data-pubreq-override")).toEqual([]);
    expect(withAttr(nodes, "data-pubreq-reason")).toEqual([]);
  });

  it("offers only the confirmation box when only an override is needed", () => {
    const nodes = treeOf(detail("detail-needs-override"));
    expect(withAttr(nodes, "data-pubreq-override")).toHaveLength(1);
    expect(withAttr(nodes, "data-pubreq-reason")).toEqual([]);
  });

  it("keeps what the administrator typed, and counts it", () => {
    const typed = "a reason typed before the panel was read again";
    const nodes = treeOf(detail("detail-off-acknowledge"), "approve", { acknowledgment: typed });
    const area = withAttr(nodes, "data-pubreq-reason");
    expect(area[0].text).toBe(typed);
    expect(withAttr(nodes, "data-pubreq-count")[0].text).toBe(`${typed.length} / ${ACK_MAX}`);
  });

  it("starts the reason field empty when nothing was typed", () => {
    const nodes = treeOf(detail("detail-off-acknowledge"));
    expect(withAttr(nodes, "data-pubreq-reason")[0].text).toBe("");
    expect(withAttr(nodes, "data-pubreq-count")[0].text).toBe(`0 / ${ACK_MAX}`);
  });
});

describe("the buttons", () => {
  const buttonWords = (nodes: PanelNode[]) =>
    all(nodes)
      .filter((n) => n.tag === "button")
      .map((n) => n.text);

  it("offers Approve and Refresh for a request that can be approved", () => {
    expect(buttonWords(treeOf(detail("detail-pass")))).toEqual([
      UI_WORDS.buttons.approve,
      UI_WORDS.buttons.refresh,
    ]);
  });

  it("labels the panel's Approve with the row's own word for a retry", () => {
    expect(buttonWords(treeOf(detail("detail-pass"), "approve", { retryLabel: true }))).toEqual([
      UI_WORDS.buttons.retry,
      UI_WORDS.buttons.refresh,
    ]);
  });

  it("labels it Continue approval for a run that has started publishing, retry label or not", () => {
    for (const retryLabel of [false, true]) {
      expect(
        buttonWords(treeOf(detail("detail-started-publishing"), "resume", { retryLabel })),
      ).toEqual([UI_WORDS.buttons.resume, UI_WORDS.buttons.refresh]);
    }
  });

  it("offers Start review exactly when the Worker offers it", () => {
    const startable = treeOf(detail("detail-not-started-startable"));
    expect(buttonWords(startable)).toContain(UI_WORDS.buttons.start);
    expect(withAttr(startable, "data-pubreq-start")).toHaveLength(1);
    expect(buttonWords(treeOf(detail("detail-pass")))).not.toContain(UI_WORDS.buttons.start);
  });

  it("offers no Approve for a withheld control, and always offers Refresh", () => {
    const nodes = treeOf(detail("detail-hard-reason"));
    expect(withAttr(nodes, "data-pubreq-panel-approve")).toEqual([]);
    expect(buttonWords(nodes)).toEqual([UI_WORDS.buttons.refresh]);
  });

  it("marks every button as a plain button, so none submits a form", () => {
    for (const n of all(treeOf(detail("detail-needs-ack-and-override")))) {
      if (n.tag === "button") expect(n.attrs?.type).toBe("button");
    }
  });
});

describe("the error, the notice and the other states", () => {
  const failure = { text: "FAILURE-WORDS", refetch: false, focusAck: false, refreshLink: false };

  it("prints a failure in an alert after the title", () => {
    const nodes = treeOf(detail("detail-pass"), "approve", { error: failure });
    expect(nodes[1].attrs?.role).toBe("alert");
    expect(nodes[1].text).toBe("FAILURE-WORDS");
    expect(withAttr(nodes, "data-pubreq-review-error")).toHaveLength(1);
    expect(all([nodes[1]]).some((n) => n.tag === "a")).toBe(false);
  });

  it("adds the link back to the page when the failure asks for one", () => {
    const node = errorTree({ ...failure, refreshLink: true }, OPTS.reloadHref);
    const link = node.children?.[0];
    expect(link?.tag).toBe("a");
    expect(link?.attrs?.href).toBe(OPTS.reloadHref);
    expect(link?.text).toBe(PANEL_WORDS.reloadLink);
    expect(node.text).toBe("FAILURE-WORDS ");
  });

  it("prints the notice a started review leaves, without a live role of its own", () => {
    const nodes = treeOf(detail("detail-pass"), "approve", { notice: "NOTICE-WORDS" });
    const notice = withClass(nodes, "pubreq-review__notice");
    expect(notice.map((n) => n.text)).toEqual(["NOTICE-WORDS"]);
    // The page announces it through a live region that exists before the words do.
    expect(notice[0].attrs?.role).toBeUndefined();
  });

  it("prints neither when there is neither", () => {
    const nodes = treeOf(detail("detail-pass"));
    expect(withAttr(nodes, "data-pubreq-review-error")).toEqual([]);
    expect(withClass(nodes, "pubreq-review__notice")).toEqual([]);
  });

  it("says it is loading under the same title", () => {
    const nodes = loadingTree("nm000701", OPTS.panelId);
    expect(words(nodes)).toEqual([panelTitle("nm000701"), UI_WORDS.buttons.loading]);
  });

  it("says what failed and offers a way to read again", () => {
    const nodes = failureTree(failure, "nm000701", OPTS.panelId, OPTS.reloadHref);
    expect(words(nodes)).toEqual([
      panelTitle("nm000701"),
      "FAILURE-WORDS",
      UI_WORDS.buttons.refresh,
    ]);
    expect(withAttr(nodes, "data-pubreq-refresh")).toHaveLength(1);
  });

  it("draws a stale row as the alert and the link, with no control to act on", () => {
    const nodes = staleRowTree("nm000701", OPTS.panelId, OPTS.reloadHref);
    expect(words(nodes)).toEqual([
      panelTitle("nm000701"),
      `${PANEL_WORDS.staleRow} `,
      PANEL_WORDS.reloadLink,
    ]);
    expect(nodes[1].attrs?.role).toBe("alert");
    expect(all(nodes).some((n) => n.tag === "button")).toBe(false);
  });

  it("keeps the sentence a failed call left beside what the re-read produced, in every outcome", () => {
    // The unconfirmed approve ("it may have started") asks for a re-read; the re-read's own
    // outcome (a detail that failed, a row that moved on) must not replace that sentence.
    const prior = {
      text: "PRIOR-MAY-HAVE-STARTED",
      refetch: true,
      focusAck: false,
      refreshLink: true,
    };
    const failed = failureTree(failure, "nm000701", OPTS.panelId, OPTS.reloadHref, prior);
    expect(words(failed)).toEqual([
      panelTitle("nm000701"),
      "PRIOR-MAY-HAVE-STARTED ",
      PANEL_WORDS.reloadLink,
      "FAILURE-WORDS",
      UI_WORDS.buttons.refresh,
    ]);
    const drawn = failureTree(DRAW_FAILURE, "nm000701", OPTS.panelId, OPTS.reloadHref, prior);
    expect(words(drawn)).toContain("PRIOR-MAY-HAVE-STARTED ");
    expect(words(drawn)).toContain(DRAW_FAILURE.text);
    const stale = staleRowTree("nm000701", OPTS.panelId, OPTS.reloadHref, prior);
    expect(words(stale)).toContain("PRIOR-MAY-HAVE-STARTED");
    expect(words(stale)).not.toContain("PRIOR-MAY-HAVE-STARTED ");
    expect(words(stale)).toContain(PANEL_WORDS.reloadLink);
    expect(stale[0].tag).toBe("h4");
    // Two alerts, but one way back to the page.
    expect(all(stale).filter((n) => n.tag === "a")).toHaveLength(1);
    expect(all(failed).filter((n) => n.tag === "a")).toHaveLength(1);
  });

  it("prints a failure once when the re-read produced the same sentence", () => {
    const same = { ...failure };
    const nodes = failureTree(same, "nm000701", OPTS.panelId, OPTS.reloadHref, same);
    expect(withAttr(nodes, "data-pubreq-review-error")).toHaveLength(1);
  });

  it("words a fault in the drawing as out of step, never as the network", () => {
    expect(DRAW_FAILURE.text).toBe(OUT_OF_STEP);
    expect(DRAW_FAILURE.text).not.toContain("Could not reach the server");
    expect(DRAW_FAILURE.refetch).toBe(false);
  });

  it("gives the stale row and the busy click their own words, neither naming a terminal", () => {
    expect(STALE_ROW_FAILURE.text).toBe(PANEL_WORDS.staleRow);
    expect(STALE_ROW_FAILURE.refreshLink).toBe(true);
    expect(BUSY_FAILURE.text).toBe(PANEL_WORDS.busy);
    for (const word of Object.values(PANEL_WORDS)) expect(terminalFlaws(word), word).toEqual([]);
    expect(terminalFlaws(panelTitle("nm000701"))).toEqual([]);
    expect(terminalFlaws(toggleLabels(true, "nm000701").ariaLabel)).toEqual([]);
  });
});

describe("tones", () => {
  it("styles the four tones the Worker sends", () => {
    for (const tone of ["ok", "note", "warn", "stop"]) {
      expect(toneClass(tone)).toBe(`pubreq-review-tone--${tone}`);
    }
  });

  it("turns a word it does not know into a note, never a class of its own", () => {
    for (const word of ["urgent", "stop extra", "", "__proto__", "constructor", "toString"]) {
      expect(toneClass(word), word).toBe("pubreq-review-tone--note");
    }
  });

  it("applies that to a headline and a screen headline from a newer Worker", () => {
    // Derived: a captured detail whose two tone words are ones this page has no rule for.
    const base = detail("detail-pass");
    const d = {
      ...base,
      description: { ...base.description, tone: "urgent" },
      identifier_screen: { ...base.identifier_screen, tone: "a b" },
    } as unknown as PublicationReviewDetail;
    const nodes = treeOf(d);
    const classes = withClass(nodes, "pubreq-review-tone--note").map((n) => n.text);
    expect(classes).toEqual([base.description.headline, base.identifier_screen.headline]);
    for (const n of all(nodes)) {
      expect(n.attrs?.class ?? "").not.toMatch(/urgent|\ba b\b/);
    }
  });
});

describe("rowIsStale", () => {
  it("is false when the detail names the row's request", () => {
    expect(rowIsStale(12, 12)).toBe(false);
  });

  it("is true when the detail names another request", () => {
    expect(rowIsStale(13, 12)).toBe(true);
  });

  it("is true when the row names none, since it differs from every integer", () => {
    expect(rowIsStale(13, Number.NaN)).toBe(true);
    expect(rowIsStale(13, undefined)).toBe(true);
  });

  it("is false for a detail that names no integer: the model calls that out of step", () => {
    expect(rowIsStale(undefined, 12)).toBe(false);
    expect(rowIsStale("12", 12)).toBe(false);
    expect(rowIsStale(null, 12)).toBe(false);
  });
});

describe("toggleLabels", () => {
  it("changes the visible word with the state and keeps one accessible name per row", () => {
    expect(toggleLabels(false, "nm000701")).toEqual({
      text: UI_WORDS.buttons.show,
      ariaLabel: "Review for nm000701",
      expanded: "false",
    });
    expect(toggleLabels(true, "nm000701")).toEqual({
      text: UI_WORDS.buttons.hide,
      ariaLabel: "Review for nm000701",
      expanded: "true",
    });
  });

  it("never lets the accessible name flip with the state, and tells rows apart by id", () => {
    expect(toggleLabels(true, "nm000701").ariaLabel).toBe(
      toggleLabels(false, "nm000701").ariaLabel,
    );
    expect(toggleLabels(false, "nm000702").ariaLabel).not.toBe(
      toggleLabels(false, "nm000701").ariaLabel,
    );
  });
});

describe("the tree holds data, never markup", () => {
  it("lets a Worker string carrying markup stay a string in a text field", () => {
    // Derived: the model's summary replaced by markup.
    const base = detail("detail-pass");
    const hostile = '<img src=x onerror="alert(1)"> & <script>';
    const d = {
      ...base,
      review: { ...base.review, summary: hostile },
    } as PublicationReviewDetail;
    const nodes = treeOf(d);
    expect(words(nodes)).toContain(hostile);
    for (const n of all(nodes)) {
      expect(n.tag).toMatch(/^[a-z0-9]+$/);
      expect([
        "h4",
        "h5",
        "p",
        "div",
        "span",
        "section",
        "ul",
        "li",
        "label",
        "input",
        "textarea",
        "button",
        "a",
      ]).toContain(n.tag);
      expect(Object.keys(n).every((k) => ["tag", "text", "attrs", "children"].includes(k))).toBe(
        true,
      );
    }
  });

  it("is plain JSON: it survives a round trip unchanged", () => {
    const nodes = treeOf(detail("detail-needs-ack-and-override"));
    expect(JSON.parse(JSON.stringify(nodes))).toEqual(nodes);
  });

  it("names no DOM global and no markup API", () => {
    const source = PANEL_SOURCE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/(?<![\w-])(document|window|location|navigator)(?![\w-])/);
    expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML|createElement|textContent/);
  });
});
