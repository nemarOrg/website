# UI Rules for Data Displays

Binding rules for any interface that shows measured data:
quality summaries, the signal viewer, charts, dashboards and admin drill-downs.
They exist so a new data view comes out right the first time.
Each rule carries a short **why**; a pull request that breaks one says why in its description.

This file extends, and never overrides, [`design-language.md`](design-language.md),
which owns the shape families (pills, chips, underline tabs), the tokens and the theming pattern.
Drawing is governed by Architecture Decision Record (ADR) 0007 (hand-rolled charts, accepted)
and ADR 0035 (proposed: quality views drawn in the browser from view data);
where this file and an ADR disagree, the ADR wins.

---

## Design reasoning: how to think through a new data UI

Work through these steps in order, before writing markup.
Most bad data screens skip the first two.

1. **Start from the question the visitor asks.**
   Write it as one sentence ("Is this dataset clean enough to reuse?", "Which channels in this file are bad?").
   Every element on the screen must help answer it; an element that answers no question goes.
2. **Choose the level.**
   Is the answer about the archive, a dataset, a recording, a channel or a component?
   The level decides the surface (rule 2), and one surface holds one level.
3. **Inventory the elements and their states.**
   List every element the view can show, then every state each can be in:
   measured, partial, not applicable, not supported, not processed, failed, withheld, stale
   (glyphs and words in the state table under rule 9).
   Design the empty and partial screens at the same time as the full one, from the same layout (rule 9).
4. **Pick the form from the data, not from taste.**
   Proportion of a bounded whole: a ring or donut.
   Distribution: a small histogram with a median mark.
   Items you can act on: a dot strip, one dot per item, that clicks through.
   Exact values: a table, always available behind the chart.
   Comparison across items: aligned bars on one shared scale.
5. **Place it in the existing surface.**
   Find the panel, toolbar group or status line it extends (rule 1); add to it in its own grammar.
6. **Balance, then subtract.**
   Lay out for the overall width and within each section (rule 7),
   then remove every border, chip, color and sentence that the data do not need (rule 6).
   Move explanations into (i) tips.
7. **Check it at 1280 px and at 390 px, in both themes**, with a keyboard (rule 12).

---

## Rules

### 1. Augment the existing surface; never build a parallel one

- Extend the existing viewer and pages in their own visual language.
  A new viewer control is a new toolbar group with the same uppercase label (`.eegv__group-label`) and the same `eegv__btn` buttons, placed among the existing groups.
- Never build a second viewer, a second recording picker or parallel chrome (its own title row, its own navigation, its own toolbar).
- A switch that changes what one renderer draws is a toggle inside that renderer (rule 11), not a new screen or tab.

**Why:** two viewers drift apart, double the code paths, and make the visitor learn two grammars for one recording.
The viewer's subject, task and previous and next navigation already is the picker.

### 2. One level per surface

- Dataset-level summaries live on the dataset page (its Data quality tab).
- File-level information is embedded **minimally** in the file viewer:
  a badge on a channel row, a clause on the status line, one expandable section.
- Never put dataset content inside the viewer, and never put per-file detail on the dataset page beyond a link into the viewer
  (for example, a dot strip whose dot opens that recording).

**Why:** mixing levels makes a number ambiguous ("91 %" of what: this file or the median of 412?)
and turns each surface into a long scroll of everything.

### 3. Human names, declared once

- Show canonical, concise display names: "Good channels", "Clean data", "Brain components".
  Never show a schema identifier (`percentGoodChannels`, `nemar-quality:...`) or a pipeline name ("nemar-ica 1.0.0") in body text, titles or labels.
- Each name carries an (i) whose hover **and** focus tip gives the definition, the unit, the direction ("higher is better")
  and "In exported results: `percentGoodChannels`".
- Pipeline names and versions go in one "How this was computed" footer at the end of each result:
  pipeline and plugin versions, dataset version, image.
- Display names, definitions, units and directions are declared once, in one module every surface reads
  (copied from the backend contract that owns them when one exists, with a drift test, as `account-copy.ts` is).
  A call site never spells a name.

**Why:** schema words are for programs; a visitor reads "Good channels" in one pass.
The exported variable name in the tip keeps the bridge to the downloaded data,
and the footer keeps the page reproducible without putting tooling in every sentence.
Names spelled at call sites drift within a release.

Do: `Good channels (i)` with the tip "Share of the electroencephalography (EEG) channels the automatic channel check kept. % · higher is better · In exported results: percentGoodChannels".
Don't: `percentGoodChannels %`, or a tile titled "Kept by nemar-floor, and brain share".

### 4. Human units and honest numbers

- Use units people read: % and dB, seconds, µV, Hz.
  Never print a bare "count", "fraction" or "nat" as a unit:
  a count needs no unit word or takes its noun ("62 components"), a fraction is shown as %,
  and an unfamiliar unit is explained in the (i).
- A value and its unit stay together on one line (rule 5), in one consistent form across a surface.
- No needless decimals: a headline value is rounded to the metric's display precision ("91 %", "6.7 dB").
  Hover readouts, data tables and downloads keep the stored text exactly (ADR 0035 decision 4).
- Use tabular numerals (`font-variant-numeric: tabular-nums`) wherever numbers line up or update in place.

**Why:** "0.0213 fraction" makes the visitor do arithmetic the page should have done;
"91.3" against "97.2" suggests a precision the measurement does not have.
Tabular figures keep columns aligned and stop live readouts from jittering.

### 5. Typography is part of the job

- Titles, labels and tick labels stay on one line, or wrap in a deliberately balanced way:
  `text-wrap: balance` on titles and headings, `white-space: nowrap` (or a non-breaking space) between a value and its unit.
- No widowed units ("100" on one line, "%" on the next), and no title broken mid-phrase.
- Sibling labels break consistently: if one ring's label takes two lines, every sibling's label block has the same height,
  so the charts above them stay aligned.
- Prefer a shorter canonical name to a wrapped long one.

**Why:** a ragged label reads as a bug, and unequal label blocks push sibling charts out of line,
which breaks the comparison the small multiples exist for.

### 6. Subtlety on every front

- This rule covers data tiles and charts.
  Elsewhere, the StatusBadge family and the status tags of `design-language.md` stay as they are for account, publish and import status.
- Fewer borders, chips and badges.
  Tiles sit on a faint ground without outlines; a state inside a tile is a glyph and a word, not a boxed chip.
  Chips stay for taxonomy, as `design-language.md` defines them.
- Quiet colors, checkably:
  the accent color goes only on the single emphasized datum of each tile;
  every other mark and label uses the foreground, muted and subtle tokens;
  state colors (success, warning, danger) go only on a state glyph or a status mark, never on a tile's ground or border.
- Explanatory text moves into (i) tips; the page keeps the data and a one-line caption at most.
- One emphasis per tile: one large number or one chart leads, everything else is secondary.
- Consistent spacing from the `--space-*` tokens; data first, chrome last.

**Why:** every border and color competes with the data for attention.
When everything is emphasized nothing is, and the visitor cannot find the answer to the question of step 1.

### 7. Density and balance

- Balance the layout across the overall width and within each section.
  Do not leave an empty grid column: move a compact card beside the others instead of below them.
- Keep the first row short, so people reach the second row faster:
  it is one row of tiles, at most about 300 px tall at 1280 px,
  with legends, breakdown lists and prose moved below it or behind a disclosure.
- Put breakdowns behind a disclosure: "11 failed" opens the per-code list on hover, focus or click.
  All data stays reachable, by keyboard and touch too, and in the data table.

**Why:** a lopsided page reads as unfinished and wastes the width the eye scans first.
A tall first row hides the rest of the page below the fold.
Breakdowns on demand keep the overview scannable without losing anything.

### 8. Charts state what they show

- Every encoding is identifiable at a glance, through an inline key placed with the chart,
  for example "median" and "observed range" under a column of arc rings.
- Label directly where possible (a value next to its mark) rather than through a distant legend.
- Every chart has a caption, an `aria-label` built from stored values, and a data table (ADR 0035 decision 7).
- Forms that work here and are preferred:
  - a compact donut or arc rings for a bounded proportion (0 to 100 %), the thick arc for the median and a thin arc for the observed range;
  - small histograms with a median mark, as small multiples in one block;
  - a dot strip where one dot is one item, which clicks through to that item;
  - live activity rings around component maps.
- A ring is for bounded percentages only; an unbounded metric never gets a ring.

**Why:** a chart whose encodings need a paragraph to decode fails the glance it was drawn for.
These forms were reviewed on NEMAR's quality views and read quickly at small sizes.

### 9. Honest empty, partial and unsupported states

- When data are absent, show the **same layout** with grayed placeholder plots and **one** small banner
  ("Not processed yet", "Coming soon").
  The plots keep their size and position; a placeholder ring is dashed, a placeholder histogram is a flat track.
- Never hide an element because its data are absent, never zero-fill (no "0 %", no "0 of 0", no fake bars),
  and never repeat the state text in every cell.
  Mark an individual element only when its state differs from the banner's.
- "Not supported" looks different from "not processed":
  not processed is a dashed outline with ○ (a checker exists and has not run);
  not supported is a dotted outline on a hatched ground with ⊘ (no checker exists for this modality, and nothing is pending).
- Gray is never the only cue: every state has a glyph and a word, readable without hover.
- Use this state table.
  It mirrors the proposed shared quality-state vocabulary;
  once that vocabulary lands in the backend contract and is copied here with a drift test, the contract's words win.

  | State | Glyph and word | Look | Meaning |
  |---|---|---|---|
  | measured | the value itself | normal text and marks | the checker ran on this version |
  | partial | the value with "n of N" | normal, coverage beside it | measured on fewer than all applicable items |
  | not applicable | – "not applicable" | muted text, no outline | does not apply to this modality or design |
  | not supported | ⊘ "not supported for this modality yet" | dotted outline on a hatched ground | no checker exists; nothing is pending |
  | not processed | ○ "not processed yet" | dashed outline | a checker exists and has not run |
  | not computable | ◇ "not computable" with its fix | warning-tinted outline | the checker ran; a prerequisite was missing |
  | failed | ! "failed" with its public code | danger-tinted outline | the checker ran and failed |
  | unknown | ? "could not be determined" | italic, muted | the checker could not decide |
  | withheld | ▣ "withheld" with the rule's name | filled muted chip | a value exists; a rule keeps it off this page |
  | stale (qualifier) | ↻ "computed on 1.1.0, current is 1.2.0" | warning-tinted italic | from an older dataset or checker version |

- Coverage, "412 of 430 recordings", sits beside every aggregate.

**Why:** a hidden element and a zero both lie, one by omission and one by assertion.
The same layout in gray tells the visitor what will be there and why it is not yet.
Repeated state text is noise that drowns the one message.
Coverage stops a dataset where half the recordings failed from showing clean-looking summaries.

### 10. Size visualizations to their container

- A visualization fills the panel it lives in (a scalp map fills its panel; a chart takes its column's width)
  and redraws on resize.
- Fix the aspect ratio where the data need one (a head is round), and fill along the free dimension.

**Why:** a small figure floating in a large empty panel looks broken and wastes the space the panel claims.

### 11. Interaction patterns to reuse

These were reviewed as intuitive; reuse them rather than inventing new ones.

- **Select and add.**
  Click to select, click again to clear, Shift-click to add or remove, Escape to clear all.
  A linked view (the scalp map) projects the current selection live.
- **Static by default, live on the cursor.**
  The default view is static (component weights); moving the cursor over the traces turns it live (the projection at the cursor),
  and leaving the traces returns it to the static view.
- **Toggle the source, not the screen.**
  A toggle switches what one renderer draws (Signal or Activations) and keeps the visitor's place, scale and selection.
  It is a radio group, and an unavailable option stays visible with `aria-disabled="true"` and its state word.

**Why:** these keep the visitor in one place with one mental model;
a new screen per mode loses the time window, the selection and the visitor's attention.

### 12. Accessibility and theming

- Light and dark themes through CSS (Cascading Style Sheets) tokens only, with the two-branch pattern of `design-language.md`.
- The (i) is a focusable control; its tip opens on hover and focus, stays while hovered, and closes with Escape
  (Web Content Accessibility Guidelines (WCAG) 1.4.13).
- Selectable lists (component maps, recording dots) support the keyboard:
  a listbox with roving `tabindex`, arrow keys to move, Enter to select, Shift+Enter to add.
- Disabled controls use `aria-disabled="true"`, stay focusable, and show their reason as visible text.
- Live values are not announced to screen readers; the selected value is available in a text readout.
- No horizontal page scroll at phone width (390 px).
  A wide element (the trace area, a long table) scrolls inside itself.
- Hit targets follow `design-language.md`; a dense toolbar never goes below the WCAG 2.5.8 minimum of 24 px.
- Check every change at 1280 px and at 390 px, in both themes.

**Why:** a tip that only hover reveals is invisible to keyboard and touch users;
a page that scrolls sideways on a phone is broken for most first visits.

### 13. Draw from data; store no figure images

- NEMAR stores no figure image (nemar-cli ADR 0137, website ADR 0035): the browser draws every view from its data.
- Quality views are drawn in the browser from their view data (ADR 0035 decision 1, proposed).
- Server-drawn hand-built Scalable Vector Graphics (SVG) is limited to the static dashboard charts of ADR 0007
  (for example, the compute usage chart).
- Canvas (or WebGL) is for dense or live data, as in the signal viewer.
- No chart library anywhere.

**Why:** a drawing from data follows the theme, can be read aloud, can be checked against its numbers,
and redraws when the data change; a stored image can do none of these.

---

## Best practices from data-visualization guidance

Short, and consistent with the rules above.

- **Data-ink ratio.**
  Remove gridlines, frames, shadows and tick marks the reading does not need; keep the marks that carry data.
- **Preattentive encoding.**
  Use position and length for what must be compared; reserve color for the one thing that must pop out.
  One accent per view.
- **Position before angle and area.**
  Aligned bars on a common scale are read most accurately; use a ring or donut only for one bounded part of a whole or a few parts.
- **Consistent scales across small multiples.**
  Sibling charts that invite comparison share their axis range and units; when they cannot, say so in the caption.
- **Bars start at zero; distributions show spread.**
  Show the median with the range or the histogram, never a lone mean.
- **Color-blind-safe palettes.**
  Categorical colors from a tested set (the viewer's Okabe-Ito channel colors, the tag color bible);
  sequential maps for magnitudes, diverging maps for signed values around zero.
  Never a rainbow map (jet, turbo) as the default; the turbo toggle of ADR 0035 decision 7 is the one opt-in exception.
  Never let hue alone carry meaning: add a glyph, a label or a pattern.
- **Contrast.**
  Text at least 4.5:1, graphical marks and focus rings at least 3:1 against their ground (WCAG 1.4.3 and 1.4.11), in both themes.
- **Meaningful order.**
  Sort by value or by a natural order (time, channel montage), never by accident of the data.
- **Tabular numerals** for every column of numbers and every live readout.
- **Motion restraint.**
  Animate only to show a change of state, briefly; honor `prefers-reduced-motion` by updating without transitions.
- **No dual axes, no 3D, no decorative gradients** on data marks.

---

## Pre-merge checklist

Run through this before opening the pull request for any data display.

- [ ] The question the view answers is written in the pull request, and every element serves it.
- [ ] The view sits on the surface of its level, and nothing from another level is mixed in.
- [ ] It extends an existing surface in that surface's grammar; no parallel viewer, picker or toolbar.
- [ ] No schema identifier or pipeline name appears in body text, titles or labels.
- [ ] Every metric name has a focusable (i) with definition, unit, direction and exported variable name.
- [ ] Names, units and definitions come from the one declared module; none is spelled at a call site.
- [ ] Pipeline versions appear once, in the "How this was computed" footer.
- [ ] Units are human; no bare "count", "fraction" or "nat"; no needless decimals; tabular numerals.
- [ ] No title, label or tick wraps badly; no widowed unit; sibling label blocks have equal height.
- [ ] Borders, chips and badges were cut to the minimum; one emphasis per tile, and the accent color only on that datum.
- [ ] The layout is balanced across the width and within sections; no empty grid column; the first row is one row of tiles, at most about 300 px tall at 1280 px.
- [ ] Breakdowns are behind a disclosure reachable by hover, focus and touch, and in the data table.
- [ ] Every chart has an inline key for its encodings, a caption, an `aria-label` from stored values and a data table.
- [ ] Rings and donuts show bounded percentages only; no unbounded metric is drawn as a ring.
- [ ] No rainbow map by default; the ADR 0035 turbo toggle is opt-in.
- [ ] The empty state keeps the same layout, grayed, with one banner; no hidden element, no zero fill, no repeated state text.
- [ ] Every state uses its glyph, word and look from the state table; not supported looks different from not processed.
- [ ] Coverage (n of N) sits beside every aggregate.
- [ ] Each visualization fills its container and redraws on resize.
- [ ] Selectable lists work with the keyboard; disabled controls are `aria-disabled` with a visible reason.
- [ ] A linked view has a static default and turns live only on cursor move, returning to the default when the cursor leaves.
- [ ] A source toggle is a radio group inside one renderer, keeps place, scale and selection, and shows an unavailable option with `aria-disabled` and its state word.
- [ ] The (i) tip opens on hover and focus, stays while hovered, and closes with Escape (WCAG 1.4.13).
- [ ] Hit targets follow `design-language.md` and are never below 24 px.
- [ ] Live values are not announced to screen readers; a text readout carries the selected value.
- [ ] Contrast is at least 4.5:1 for text and 3:1 for graphical marks and focus rings, in both themes.
- [ ] No stored figure image; hand-built SVG or canvas; no chart library.
- [ ] Only tokens from `src/styles/tokens.css`; both theme branches present.
- [ ] Checked at 1280 px and 390 px, in light and dark, with no horizontal page scroll at 390 px.
- [ ] `prefers-reduced-motion` respected for any animation.
