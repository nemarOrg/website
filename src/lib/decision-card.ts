/**
 * The administrator's decision card on the approval page (nemarOrg/nemar-cli#2456; nemar-cli
 * ADR 0142, decision 4, and its amendments of 2026-11-27).
 *
 * NOTHING IS DECIDED HERE. The Worker builds the card (`backend/src/services/decision-card.ts` in
 * nemar-cli) and attaches it to `GET /admin/publish/:id/review` as `decision_card`: the license cue
 * and its reason, the name rule's cue, each question's strongest finding, the suggested next action.
 * This module reads that JSON defensively and turns it into the panel's data tree, in the order and
 * with the labels of the terminal's renderer (`src/lib/decision-card-display.ts` in nemar-cli):
 * the next action, the license panel, the name panel, the dataset's own words side by side, the
 * authors, the questions, the identifier screen and the automatic denial.
 *
 * Three rules:
 *
 *  1. **A card this page cannot read costs only the card.** A missing card (an older review, or an
 *     older Worker), a version other than 1, or a card without its parts yields no card, and the
 *     panel is drawn as it was before the card existed.
 *  2. **Every string is text, never markup.** Words reach the DOM only through a node's `text`
 *     field (`textContent`); control and format characters are removed as well, as the terminal's
 *     `plain()` does, so a right-to-left override in a depositor's field cannot reorder the line.
 *     `next_action.command` is a terminal's text and is never read.
 *  3. **The page never shows "approve" when it does not offer Approve.** The Worker's card never
 *     says approve while a gate withholds approval; if this page's own control disagrees (it is
 *     stricter, ADR 0027), the suggestion is replaced by a page-owned sentence, never shown.
 *
 * Pure: no DOM, no network, no node module, so the page's browser script can import it.
 */
import type { PanelNode } from "./publication-review-panel";

// ---------------------------------------------------------------------------------------------
// The card, as this page reads it (transcribed from nemar-cli `shared/contract/decision-card.ts`)
// ---------------------------------------------------------------------------------------------

/** The cue of the license and name panels. */
export type Cue = "green" | "amber" | "red";

export interface CardLineageView {
  readonly outcome: string;
  readonly credited: boolean;
  readonly resolvedAt: string | null;
  readonly declaredLabel: string;
  readonly declared: readonly string[];
  readonly droppedDois: number;
  readonly skippedRelations: number;
  readonly permissionCovers: boolean;
}

export interface CardQuestionView {
  readonly question: string;
  readonly label: string;
  readonly answer: string;
  readonly strongest: { readonly severity: string; readonly label: string } | null;
}

/** What the page draws: every string already made plain. */
export interface DecisionCardView {
  readonly action: string;
  readonly sentence: string;
  readonly license: {
    readonly cue: Cue;
    readonly reason: string;
    readonly others: readonly string[];
    readonly field: string | null;
    readonly fieldLabel: string | null;
    readonly file: {
      readonly state: string;
      readonly spdx: string | null;
      readonly expression: string | null;
      readonly additions: boolean;
    } | null;
    readonly matcher: string | null;
    readonly lineage: CardLineageView | null;
    readonly freshLineage: CardLineageView | null;
    readonly permissionRecorded: boolean;
  };
  readonly name: {
    readonly cue: Cue;
    readonly line: string;
    readonly titlesLabel: string;
    readonly titles: readonly string[];
  } | null;
  readonly metadata: {
    readonly label: string;
    readonly asReviewed: boolean;
    readonly note: string | null;
    readonly enrichment: readonly (readonly [string, string])[] | null;
    readonly description: readonly (readonly [string, string])[] | null;
    readonly version: string | null;
    readonly anonymous: boolean;
  };
  readonly authors: {
    readonly count: number;
    readonly placeholders: number;
    readonly flagged: readonly string[];
  } | null;
  readonly questions: readonly CardQuestionView[];
  readonly screen: {
    readonly headline: string;
    readonly tone: string;
    readonly headLine: string | null;
  };
  readonly autoDeny: string | null;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRecord = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Control (Cc) and format (Cf) characters, the bidirectional overrides among them, and the line and
 * paragraph separators (Zl, Zp): the set nemar-cli's `terminal-text.ts` removes.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A string made plain, or "" for anything that is not a string. */
export function plain(x: unknown): string {
  return typeof x === "string" ? x.replace(UNSAFE, "").trim() : "";
}

const plainOrNull = (x: unknown): string | null => {
  const s = plain(x);
  return s === "" ? null : s;
};

const plainList = (x: unknown): string[] =>
  Array.isArray(x) ? x.map((v) => plain(v)).filter((v) => v !== "") : [];

const count = (x: unknown): number =>
  typeof x === "number" && Number.isInteger(x) && x > 0 ? x : 0;

/** A cue word this page does not know is amber: never green by default. */
const cueOf = (x: unknown): Cue => (x === "green" || x === "red" ? x : "amber");

/** The label on registry text, as the contract names it; used when a card omits it. */
export const REGISTRY_TEXT_LABEL = "as the source's registry declares it";

function lineageOf(x: unknown): CardLineageView | null {
  if (!isRecord(x)) return null;
  const outcome = plain(x.outcome);
  if (outcome === "") return null;
  const d = isRecord(x.declared_licenses) ? x.declared_licenses : null;
  return {
    outcome,
    credited: x.credited === true,
    resolvedAt: plainOrNull(x.resolved_at),
    declaredLabel: plainOrNull(d?.label) ?? REGISTRY_TEXT_LABEL,
    declared: plainList(d?.licenses),
    droppedDois: count(x.dropped_doi_candidates),
    skippedRelations: count(x.skipped_stale_relations),
    permissionCovers: x.permission_covers === true,
  };
}

/** Label and value pairs, dropping the empty ones, as the terminal's `field()` does. */
function pairs(entries: readonly (readonly [string, string])[]): (readonly [string, string])[] {
  return entries.filter(([, v]) => v !== "");
}

const joined = (x: unknown): string => plainList(x).join("; ");

/**
 * The card a review detail carries, read for drawing, or null when there is none or it is not a
 * card this page reads (rule 1 in the header).
 */
export function readDecisionCard(card: unknown): DecisionCardView | null {
  if (!isRecord(card) || card.v !== 1) return null;
  const { metadata: m, license: lic, authors: a, next_action: next } = card;
  const screen = card.identifier_screen;
  if (
    !isRecord(m) ||
    !isRecord(lic) ||
    !isRecord(a) ||
    !Array.isArray(card.questions) ||
    !isRecord(screen) ||
    !isRecord(next)
  ) {
    return null;
  }
  const sentence = plain(next.sentence);
  const reason = plain(lic.reason);
  if (sentence === "" || reason === "") return null;

  const file = isRecord(lic.license_file) ? lic.license_file : null;
  const field = isRecord(lic.field) ? lic.field : null;
  const n = isRecord(card.upstream_name) ? card.upstream_name : null;
  const titles = n && isRecord(n.titles) ? n.titles : null;
  const e = isRecord(m.enrichment) ? m.enrichment : null;
  const d = isRecord(m.dataset_description) ? m.dataset_description : null;

  const description =
    e === null
      ? ""
      : plain(e.description) === ""
        ? ""
        : `${plain(e.description)}${e.description_cut === true ? " (cut)" : ""}`;

  const names = Array.isArray(a.names) ? a.names : [];
  const placeholders = typeof a.placeholders === "number" ? count(a.placeholders) : 0;

  return {
    action: plain(next.action),
    sentence,
    license: {
      cue: cueOf(lic.cue),
      reason,
      others: plainList(lic.reasons).slice(1),
      field: field ? plainOrNull(field.text) : null,
      fieldLabel: field ? plainOrNull(field.label) : null,
      file:
        file && plain(file.state) !== ""
          ? {
              state: plain(file.state),
              spdx: plainOrNull(file.spdx),
              expression: plainOrNull(file.expression),
              additions: file.additions === true,
            }
          : null,
      matcher: plainOrNull(lic.matcher),
      lineage: lineageOf(lic.lineage),
      freshLineage: lineageOf(lic.fresh_lineage),
      permissionRecorded: lic.permission_recorded === true,
    },
    name:
      n === null
        ? null
        : {
            cue: cueOf(n.cue),
            line: plain(n.line),
            titlesLabel: plainOrNull(titles?.label) ?? REGISTRY_TEXT_LABEL,
            titles: plainList(titles?.titles),
          },
    metadata: {
      label: plain(m.label),
      asReviewed: m.as_reviewed === true,
      note: plainOrNull(m.note),
      enrichment:
        e === null
          ? null
          : pairs([
              ["Title", plain(e.title)],
              ["Description", description],
              ["License", plain(e.license)],
              ["Creators", joined(e.creators)],
              ["Keywords", joined(e.keywords)],
              ["Funding", joined(e.funding)],
            ]),
      description:
        d === null
          ? null
          : pairs([
              ["Name", plain(d.name)],
              ["License", plain(d.license)],
              ["Authors", joined(d.authors)],
            ]),
      version: plainOrNull(m.version),
      anonymous: m.anonymous === true,
    },
    authors:
      typeof a.count === "number" && Number.isInteger(a.count)
        ? {
            count: a.count,
            placeholders,
            flagged: names
              .filter((x) => isRecord(x) && x.placeholder === true)
              .map((x) => plain((x as Rec).name))
              .filter((x) => x !== ""),
          }
        : null,
    questions: card.questions.filter(isRecord).map((q) => {
      const s = isRecord(q.strongest) ? q.strongest : null;
      return {
        question: plain(q.question),
        label: plain(q.label),
        answer: plain(q.answer),
        strongest: s ? { severity: plain(s.severity), label: plain(s.label) } : null,
      };
    }),
    screen: {
      headline: plain(screen.headline),
      tone: plain(screen.tone),
      headLine: plainOrNull(screen.head_line),
    },
    autoDeny: isRecord(card.auto_deny) ? plainOrNull(card.auto_deny.line) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

/**
 * The words the card's drawing owns: the terminal renderer's labels, and the one sentence that
 * replaces a suggestion this page would contradict. None names a terminal.
 */
export const CARD_WORDS = {
  heading: "Decision card",
  next: "Next",
  license: "License",
  field: "Field",
  licenseFile: "LICENSE",
  matcher: "Matcher",
  name: "Name",
  ownWords: "The dataset's own words",
  asReviewed: "as reviewed",
  enrichment: ".nemar/metadata.json",
  description: "dataset_description.json",
  noEnrichment: "(none on record)",
  noDescription: "(not read)",
  none: "(none)",
  version: "Version",
  anonymous: "Anonymous release: creators and Authors are withheld.",
  authors: "Authors",
  questions: "Questions",
  screen: "Identifier screen",
  autoDeny: "Automatic denial",
  also: "Also",
  note: "Note",
  permission: "A license permission is on record.",
  additions: "with text beyond the license",
  credited: "source credited",
  covered: "covered by the recorded permission",
  /** Rule 3 in the header. */
  approveWithheld:
    "No next action is shown: the card suggests approving, but this page does not offer Approve for this request. Read the reasons below.",
} as const;

/** The cue's word, which the page shows beside its color so the cue is never color alone. */
export const CUE_WORDS: Readonly<Record<Cue, string>> = {
  green: "Green",
  amber: "Amber",
  red: "Red",
};

const C = "pubreq-review-card";

function node(tag: string, className?: string, text?: string, children?: PanelNode[]): PanelNode {
  return {
    tag,
    ...(text === undefined ? {} : { text }),
    ...(className ? { attrs: { class: className } } : {}),
    ...(children ? { children } : {}),
  };
}

const p = (text: string, className = `${C}__text`): PanelNode => node("p", className, text);

/** A cue badge: the word and the color together. */
const cueBadge = (cue: Cue): PanelNode =>
  node("span", `${C}__cue ${C}__cue--${cue}`, CUE_WORDS[cue]);

/** A labeled row of a definition list. */
const row = (label: string, value: string): PanelNode =>
  node("div", `${C}__row`, undefined, [node("dt", undefined, label), node("dd", undefined, value)]);

const dl = (rows: PanelNode[]): PanelNode => node("dl", `${C}__fields`, undefined, rows);

function lineageNodes(which: string, l: CardLineageView | null): PanelNode[] {
  if (l === null) return [];
  const when = l.resolvedAt ? `, resolved ${l.resolvedAt}` : "";
  const tail = `${l.credited ? `, ${CARD_WORDS.credited}` : ""}${
    l.permissionCovers ? `, ${CARD_WORDS.covered}` : ""
  }`;
  const out = [row(`Lineage (${which}${when})`, `${l.outcome}${tail}`)];
  if (l.declared.length > 0) out.push(row(`Declared (${l.declaredLabel})`, l.declared.join("; ")));
  if (l.droppedDois > 0) {
    out.push(
      row(
        CARD_WORDS.note,
        `${l.droppedDois} README DOI${l.droppedDois === 1 ? "" : "s"} dropped as cut short`,
      ),
    );
  }
  if (l.skippedRelations > 0) {
    out.push(row(CARD_WORDS.note, `${l.skippedRelations} stale publication relation(s) skipped`));
  }
  return out;
}

function section(heading: string, className: string, children: PanelNode[]): PanelNode {
  return node("section", `${C}__part ${className}`, undefined, [
    node("h5", `${C}__heading`, heading),
    ...children,
  ]);
}

/**
 * The card as the panel's first section. `approveOffered` is whether this page offers Approve for
 * the request; it decides only whether an "approve" suggestion may be shown (rule 3).
 */
export function cardTree(card: DecisionCardView, approveOffered: boolean): PanelNode {
  const parts: PanelNode[] = [];

  // The next action.
  const contradicted = card.action === "approve" && !approveOffered;
  parts.push(
    node("div", `${C}__next`, undefined, [
      node("span", `${C}__label`, CARD_WORDS.next),
      p(contradicted ? CARD_WORDS.approveWithheld : card.sentence, `${C}__text ${C}__next-text`),
    ]),
  );

  // The license panel.
  const lic = card.license;
  const licRows: PanelNode[] = [
    row(
      lic.fieldLabel ? `${CARD_WORDS.field} (${lic.fieldLabel})` : CARD_WORDS.field,
      lic.field ?? CARD_WORDS.none,
    ),
  ];
  if (lic.file) {
    const f = lic.file;
    licRows.push(
      row(
        CARD_WORDS.licenseFile,
        `${f.state}${f.spdx ? ` ${f.spdx}` : ""}${f.expression ? ` (${f.expression})` : ""}${
          f.additions ? `, ${CARD_WORDS.additions}` : ""
        }`,
      ),
    );
  }
  if (lic.matcher) licRows.push(row(CARD_WORDS.matcher, lic.matcher));
  licRows.push(...lineageNodes("review", lic.lineage), ...lineageNodes("now", lic.freshLineage));
  const licTail: PanelNode[] = [];
  if (lic.permissionRecorded) licTail.push(p(CARD_WORDS.permission));
  if (lic.others.length > 0) {
    licTail.push(
      node(
        "ul",
        `${C}__also`,
        undefined,
        lic.others.map((r) => node("li", undefined, `${CARD_WORDS.also}: ${r}`)),
      ),
    );
  }
  parts.push(
    section(CARD_WORDS.license, `${C}__license ${C}--${lic.cue}`, [
      node("p", `${C}__cue-line`, undefined, [
        cueBadge(lic.cue),
        node("span", undefined, lic.reason),
      ]),
      dl(licRows),
      ...licTail,
    ]),
  );

  // The name rule's panel; a card from a Worker before the rule has none.
  if (card.name) {
    const n = card.name;
    parts.push(
      section(CARD_WORDS.name, `${C}--${n.cue}`, [
        node("p", `${C}__cue-line`, undefined, [cueBadge(n.cue), node("span", undefined, n.line)]),
        ...(n.titles.length > 0
          ? [dl([row(`Upstream title (${n.titlesLabel})`, n.titles.join("; "))])]
          : []),
      ]),
    );
  }

  // The dataset's own words, side by side.
  const m = card.metadata;
  const side = (
    title: string,
    entries: readonly (readonly [string, string])[] | null,
    empty: string,
  ) =>
    node("div", `${C}__side`, undefined, [
      node("h6", `${C}__file`, title),
      entries === null || entries.length === 0
        ? p(empty, `${C}__text ${C}__text--muted`)
        : dl(entries.map(([k, v]) => row(k, v))),
    ]);
  const ownHeading = `${CARD_WORDS.ownWords}${m.label ? ` (${m.label})` : ""}${
    m.asReviewed ? `, ${CARD_WORDS.asReviewed}` : ""
  }`;
  parts.push(
    section(ownHeading, `${C}__words`, [
      ...(m.note ? [p(m.note, "pubreq-review-tone--warn")] : []),
      node("div", `${C}__sides`, undefined, [
        side(CARD_WORDS.enrichment, m.enrichment, CARD_WORDS.noEnrichment),
        side(CARD_WORDS.description, m.description, CARD_WORDS.noDescription),
      ]),
      ...(m.version ? [dl([row(CARD_WORDS.version, m.version)])] : []),
      ...(m.anonymous ? [p(CARD_WORDS.anonymous)] : []),
    ]),
  );

  // Authors.
  if (card.authors) {
    const a = card.authors;
    const ph =
      a.placeholders > 0 ? `, ${a.placeholders} placeholder${a.placeholders === 1 ? "" : "s"}` : "";
    const flagged = a.flagged.length > 0 ? ` (flagged: ${a.flagged.join("; ")})` : "";
    parts.push(
      node("div", `${C}__authors${a.placeholders > 0 ? ` ${C}--red` : ""}`, undefined, [
        node("span", `${C}__label`, CARD_WORDS.authors),
        p(`${a.count}${ph}${flagged}`),
      ]),
    );
  }

  // Per question.
  if (card.questions.length > 0) {
    parts.push(
      section(CARD_WORDS.questions, `${C}__questions`, [
        node(
          "ul",
          `${C}__qlist`,
          undefined,
          card.questions.map((q) =>
            node("li", `${C}__q`, undefined, [
              node("span", `${C}__q-name`, q.label || q.question),
              node("span", `${C}__answer ${C}__answer--${answerClass(q.answer)}`, q.answer),
              ...(q.strongest
                ? [
                    node("span", `${C}__q-finding`, undefined, [
                      node("span", "pubreq-review__tag", q.strongest.severity),
                      node("span", undefined, q.strongest.label),
                    ]),
                  ]
                : []),
            ]),
          ),
        ),
      ]),
    );
  }

  // The identifier screen, and the automatic denial.
  const screenChildren: PanelNode[] = [p(card.screen.headline)];
  if (card.screen.headLine)
    screenChildren.push(p(card.screen.headLine, "pubreq-review-tone--warn"));
  parts.push(
    node("div", `${C}__screen`, undefined, [
      node("span", `${C}__label`, CARD_WORDS.screen),
      ...screenChildren,
    ]),
  );
  if (card.autoDeny) {
    parts.push(
      node("div", `${C}__autodeny`, undefined, [
        node("span", `${C}__label`, CARD_WORDS.autoDeny),
        p(card.autoDeny),
      ]),
    );
  }

  return node("section", C, undefined, [node("h5", `${C}__title`, CARD_WORDS.heading), ...parts]);
}

/** An answer word becomes a class name, so it is checked; an unknown word is `unknown`. */
function answerClass(answer: string): "pass" | "fail" | "unknown" {
  return answer === "pass" || answer === "fail" ? answer : "unknown";
}
