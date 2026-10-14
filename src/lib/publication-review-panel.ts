/**
 * The drawing of the administrator approval page's review panel, as plain data (website#459).
 *
 * `lib/publication-review.ts` decides what the panel says (`PanelModel`); this module turns that
 * model into the tree of nodes the page script mounts. A node is a tag, attributes, children and,
 * for the words it holds, ONE `text` field: there is no HTML string anywhere, so the script can
 * only reach the DOM with `createElement`, `setAttribute` and `textContent`, and a Worker string
 * can never be read as markup. Because the tree is data, a test can say exactly which words the
 * administrator sees, and deleting one fails it.
 *
 * Pure: no DOM, no network, no node module, so a browser script can import it
 * (`test/client-bundle-guard.test.ts`). The few words this module owns have no counterpart in the
 * mirrored copy table and name no terminal (`PANEL_WORDS`).
 */
import {
  ACK_MAX,
  type ApproveControl,
  type FailureView,
  type PanelModel,
  type Tone,
  UI_WORDS,
} from "./publication-review";

/** One node of the drawn panel. Words reach the DOM only through `text`. */
export interface PanelNode {
  readonly tag: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, string>>;
  readonly children?: readonly PanelNode[];
}

/** Words the panel owns that the lib's `UI_WORDS` and the mirrored copy table do not carry. */
export const PANEL_WORDS = {
  /** Shown when the panel's request is not the one its row was drawn for. */
  staleRow:
    "This list is out of date: the request on this row is no longer the current one, so Approve is not offered.",
  /** Shown when a click arrives while another call is still running. */
  busy: "Another action is still running. Wait for it to finish, then try again.",
  /** The refresh note's replacement while a review panel is open. */
  refreshPaused: "Automatic refresh is paused while a review is open.",
  /** The link at the end of a failure that asks for a reload. */
  reloadLink: "Refresh to see the current state.",
} as const;

/** What a click that is refused for a call already in flight says (no redraw, no re-read). */
export const BUSY_FAILURE: FailureView = {
  text: PANEL_WORDS.busy,
  refetch: false,
  focusAck: false,
  refreshLink: false,
};

/** The failure shown when the panel's request is not the row's. */
export const STALE_ROW_FAILURE: FailureView = {
  text: PANEL_WORDS.staleRow,
  refetch: false,
  focusAck: false,
  refreshLink: true,
};

/**
 * Whether a detail names a different request from the row it is shown under. A detail that names
 * no integer is not "stale": `panelModel` already calls it out of step. A row with no readable id
 * differs from every integer, so it is stale.
 */
export function rowIsStale(detailRequestId: unknown, rowRequestId: unknown): boolean {
  return Number.isInteger(detailRequestId) && detailRequestId !== rowRequestId;
}

/** The toggle's visible word and its accessible name (the dataset id tells the rows apart). */
export function toggleLabels(
  open: boolean,
  datasetId: string,
): { readonly text: string; readonly ariaLabel: string } {
  const text = open ? UI_WORDS.buttons.hide : UI_WORDS.buttons.show;
  return { text, ariaLabel: `${text} for ${datasetId}` };
}

/** The panel's heading: the same on every row, so the dataset id makes it a name. */
export const panelTitle = (datasetId: string): string =>
  `${UI_WORDS.headings.review}: ${datasetId}`;

/** The id of the heading the panel is labelled by. */
export const titleIdOf = (panelId: string): string => `${panelId}-title`;

const TONE_CLASS: Readonly<Record<Tone, string>> = {
  ok: "pubreq-review-tone--ok",
  note: "pubreq-review-tone--note",
  warn: "pubreq-review-tone--warn",
  stop: "pubreq-review-tone--stop",
};

/** The class of a tone; a word this page does not know is a note, never a class of its own. */
export function toneClass(tone: string): string {
  return Object.hasOwn(TONE_CLASS, tone) ? TONE_CLASS[tone as Tone] : TONE_CLASS.note;
}

const TEXT = "pubreq-review__text";
const BUTTON = "pubreq-review__btn";

function node(
  tag: string,
  className?: string,
  text?: string,
  rest: { attrs?: Record<string, string>; children?: PanelNode[] } = {},
): PanelNode {
  const attrs = { ...(className ? { class: className } : {}), ...rest.attrs };
  return {
    tag,
    ...(text === undefined ? {} : { text }),
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(rest.children ? { children: rest.children } : {}),
  };
}

const button = (primary: boolean, text: string, marker: string): PanelNode =>
  node("button", primary ? `${BUTTON} ${BUTTON}--primary` : BUTTON, text, {
    attrs: { type: "button", [marker]: "" },
  });

function section(heading: string | null, ...children: PanelNode[]): PanelNode {
  return node("section", "pubreq-review__section", undefined, {
    children: [...(heading ? [node("h5", "pubreq-review__heading", heading)] : []), ...children],
  });
}

const list = (items: readonly string[]): PanelNode =>
  node("ul", "pubreq-review__list", undefined, {
    children: items.map((item) => node("li", undefined, item)),
  });

/** A failure's alert, with the reload link when the failure asks for one. */
export function errorTree(failure: FailureView, reloadHref: string): PanelNode {
  return node(
    "p",
    "pubreq-review__error",
    failure.refreshLink ? `${failure.text} ` : failure.text,
    {
      attrs: { role: "alert", "data-pubreq-review-error": "" },
      children: failure.refreshLink
        ? [node("a", undefined, PANEL_WORDS.reloadLink, { attrs: { href: reloadHref } })]
        : [],
    },
  );
}

/** The heading every state of the panel starts with. */
export function titleTree(datasetId: string, panelId: string): PanelNode {
  return node("h4", "pubreq-review__title", panelTitle(datasetId), {
    attrs: { id: titleIdOf(panelId) },
  });
}

/** The panel while its detail is being read. */
export function loadingTree(datasetId: string, panelId: string): PanelNode[] {
  return [titleTree(datasetId, panelId), node("p", TEXT, UI_WORDS.buttons.loading)];
}

/** The panel after a failure that left nothing to draw: the alert and a way to read again. */
export function failureTree(
  failure: FailureView,
  datasetId: string,
  panelId: string,
  reloadHref: string,
): PanelNode[] {
  return [
    titleTree(datasetId, panelId),
    errorTree(failure, reloadHref),
    button(false, UI_WORDS.buttons.refresh, "data-pubreq-refresh"),
  ];
}

/** The panel for a request that is not the row's: the alert and a link back, and no controls. */
export function staleRowTree(datasetId: string, panelId: string, reloadHref: string): PanelNode[] {
  return [titleTree(datasetId, panelId), errorTree(STALE_ROW_FAILURE, reloadHref)];
}

/** What the panel needs besides the model. */
export interface PanelTreeOptions {
  readonly datasetId: string;
  readonly panelId: string;
  /** The row's own button said "Retry approval", so the panel's says it too. */
  readonly retryLabel: boolean;
  readonly reloadHref: string;
  readonly error?: FailureView | null;
  readonly notice?: string | null;
  /** What the administrator had typed in the reason field, kept across a re-read. */
  readonly acknowledgment?: string;
}

function approveLabel(control: Extract<ApproveControl, { kind: "offered" }>, retry: boolean) {
  if (control.mode === "resume") return UI_WORDS.buttons.resume;
  return retry ? UI_WORDS.buttons.retry : UI_WORDS.buttons.approve;
}

function controlsTree(model: PanelModel, opts: PanelTreeOptions): PanelNode {
  const approve = model.approve;
  const children: PanelNode[] = [];

  if (approve.kind === "unavailable") {
    children.push(node("p", TEXT, approve.text));
  } else if (approve.kind !== "offered") {
    for (const line of approve.lines) children.push(node("p", TEXT, line));
  }

  const actions: PanelNode[] = [];
  if (approve.kind === "offered") {
    if (approve.notice) children.push(node("p", TEXT, approve.notice));
    if (model.overrideLabel) {
      children.push(
        node("label", "pubreq-review__check", undefined, {
          children: [
            node("input", undefined, undefined, {
              attrs: { type: "checkbox", "data-pubreq-override": "" },
            }),
            node("span", undefined, model.overrideLabel),
          ],
        }),
      );
    }
    if (model.ackPrompt) {
      const typed = opts.acknowledgment ?? "";
      const areaId = `${opts.panelId}-reason`;
      children.push(
        node("div", "pubreq-review__field", undefined, {
          children: [
            node("label", undefined, model.ackPrompt, { attrs: { for: areaId } }),
            node("textarea", undefined, typed, {
              attrs: {
                id: areaId,
                rows: "4",
                maxlength: String(ACK_MAX),
                "data-pubreq-reason": "",
              },
            }),
            node("span", "pubreq-review__count", `${typed.length} / ${ACK_MAX}`, {
              attrs: { "data-pubreq-count": "" },
            }),
          ],
        }),
      );
    }
    actions.push(button(true, approveLabel(approve, opts.retryLabel), "data-pubreq-panel-approve"));
  }
  if (model.start.offered) {
    actions.push(button(false, UI_WORDS.buttons.start, "data-pubreq-start"));
  }
  actions.push(button(false, UI_WORDS.buttons.refresh, "data-pubreq-refresh"));
  children.push(node("div", "pubreq-review__actions", undefined, { children: actions }));
  return node("div", "pubreq-review__controls", undefined, { children });
}

/** Every word of the panel for a model, in reading order. */
export function panelTree(model: PanelModel, opts: PanelTreeOptions): PanelNode[] {
  const nodes: PanelNode[] = [titleTree(opts.datasetId, opts.panelId)];
  if (opts.error) nodes.push(errorTree(opts.error, opts.reloadHref));
  if (opts.notice) nodes.push(node("p", "pubreq-review__notice", opts.notice));
  if (model.headline) nodes.push(node("p", toneClass(model.headline.tone), model.headline.text));
  if (model.screen) {
    nodes.push(
      section(
        UI_WORDS.headings.screen,
        node("p", toneClass(model.screen.tone), model.screen.headline),
        list(model.screen.lines),
      ),
    );
  }
  if (model.reasonsWithheld) {
    nodes.push(section(UI_WORDS.headings.reasons, node("p", TEXT, model.reasonsWithheld)));
  } else if (model.reasons.length > 0) {
    nodes.push(
      section(
        UI_WORDS.headings.reasons,
        ...model.reasons.map((reason) =>
          node("div", "pubreq-review__reason", undefined, {
            children: [
              node("div", "pubreq-review__reason-tags", undefined, {
                children: [
                  node("span", "pubreq-review__tag", reason.classLabel),
                  node("span", "pubreq-review__tag", reason.clearedLabel),
                ],
              }),
              node("p", TEXT, reason.statement),
              node("p", "pubreq-review__cure", reason.cure),
            ],
          }),
        ),
      ),
    );
  }
  if (model.factNotes.length > 0) {
    nodes.push(section(UI_WORDS.headings.checks, list(model.factNotes)));
  }
  if (model.model) {
    const written: PanelNode[] = [];
    if (model.model.summary !== null) {
      written.push(section(model.model.summaryLabel, node("p", TEXT, model.model.summary)));
    }
    if (model.model.findings.length > 0) {
      written.push(
        section(
          model.model.findingsLabel,
          ...model.model.findings.map((finding) =>
            node("div", "pubreq-review__finding", undefined, {
              children: [
                node("span", "pubreq-review__finding-label", finding.label),
                ...(finding.documentLabel
                  ? [node("span", "pubreq-review__finding-document", finding.documentLabel)]
                  : []),
                node("p", TEXT, finding.note),
              ],
            }),
          ),
        ),
      );
    }
    nodes.push(node("div", "pubreq-review__model", undefined, { children: written }));
  }
  if (model.standing) nodes.push(node("p", `${TEXT} ${TEXT}--muted`, model.standing));
  nodes.push(controlsTree(model, opts));
  return nodes;
}
