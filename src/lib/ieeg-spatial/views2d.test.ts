import { describe, expect, it } from "vitest";
import { nodeFs, repoPath } from "../../../test/node";
import { contactRadius } from "./brain-gl";
import { PRESETS, createCamera, project, setPreset } from "./camera";
import { type GeometryInput, type RecordingGeometry, resolveRecordingGeometry } from "./geometry";
import {
  FIXED_DOT_PX,
  FRAME_INSET_PX,
  LETTER_INSET_PX,
  LETTER_PX,
  MIN_DOT_PX,
  type TemplateOutlines,
  VIEWS_SENTENCE,
  VIEW_DEFS,
  VIEW_NAMES,
  type Views2dContact,
  layoutViews,
  parseViewOutlines,
  viewEnds,
  viewsMarkup,
} from "./views2d";

/**
 * Real files only: the template outlines are the vendored `views.json`, and the contacts of the
 * unlocated-channel tests are the real electrodes file of nm000485 (two contacts have `n/a`
 * positions), read by the module's own resolver through a reader over the committed fixture.
 * Known-answer inputs are said where they are used.
 */
const fs = await nodeFs();
const FIXTURES = "test/fixtures/ieeg-geometry";

function treeReader(
  datasetId: string,
  version: string,
): Pick<GeometryInput, "listDir" | "readText"> {
  const at = (rel: string) => repoPath(`${FIXTURES}/${datasetId}/${version}/${rel}`);
  return {
    listDir: async (path) => {
      const file = at(path === "" ? "__listing.json" : `${path}/__listing.json`);
      return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
    },
    readText: async (path) => (fs.existsSync(at(path)) ? fs.readFileSync(at(path), "utf8") : null),
  };
}

const NM485 = "sub-P001/ieeg/sub-P001_task-wordsnonfont_run-1_ieeg.vhdr";
const nm485: RecordingGeometry = await resolveRecordingGeometry({
  datasetId: "nm000485",
  version: "v1.0.2",
  recording: NM485,
  ...treeReader("nm000485", "v1.0.2"),
});

const OUTLINES: TemplateOutlines = parseViewOutlines(
  JSON.parse(
    fs.readFileSync(
      repoPath("public/vendor/brain-templates/mni152nlin2009casym@1/views.json"),
      "utf8",
    ),
  ),
);

const THEME = { foreground: "#0f172a", muted: "#475569", border: "#e2e8f0" };
const REGION = { x: 0, y: 0, width: 900, height: 300 };

function contact(
  index: number,
  position: readonly [number, number, number] | null,
  extra: Partial<Views2dContact> = {},
): Views2dContact {
  return {
    index,
    position,
    size: null,
    fill: "#f5b82e",
    opacity: 1,
    selected: false,
    title: `contact ${index}`,
    ...extra,
  };
}

function layout(
  contacts: Views2dContact[],
  extra: Partial<Parameters<typeof layoutViews>[0]> = {},
) {
  return layoutViews({
    contacts,
    millimeters: true,
    template: null,
    arrangement: "row",
    region: REGION,
    ...extra,
  });
}

describe("orientation", () => {
  // A point one unit along each world axis, seen by the camera of the matching 3D preset, lands on
  // the side of the screen the 2D view puts it on: the two renderers cannot disagree.
  it("each view puts every axis on the side the 3D preset does", () => {
    const axes = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as const;
    for (const name of VIEW_NAMES) {
      const cam = createCamera();
      setPreset(cam, name);
      expect(PRESETS[name]).toBeDefined();
      const def = VIEW_DEFS[name];
      const origin = project(cam, [0, 0, 0], 800, 800);
      for (const axis of [0, 1, 2] as const) {
        const [px, py] = project(cam, axes[axis], 800, 800);
        const dx = px - origin[0];
        const dy = py - origin[1];
        // Screen right in a 3D camera is +x of canvas pixels; the 2D view's horizontal is the same.
        const expectedH = axis === def.h ? def.hSign : 0;
        const expectedV = axis === def.v ? -1 : 0; // canvas y runs down, so "up" is negative
        expect(Math.sign(Math.round(dx * 1000) / 1000), `${name} axis ${axis} horizontal`).toBe(
          expectedH,
        );
        expect(Math.sign(Math.round(dy * 1000) / 1000), `${name} axis ${axis} vertical`).toBe(
          expectedV,
        );
      }
    }
  });

  it("draws nearer contacts over farther ones, by the axis the eye looks along", () => {
    // Known answer: three contacts that overlap in the left view (same y and z), at x = -5, 0, 5.
    // The left view's eye is on the -x side, so x = -5 is the nearest and must be drawn last.
    const cs = [contact(0, [-5, 0, 0]), contact(1, [0, 0, 0]), contact(2, [5, 0, 0])];
    const left = layout(cs).cells.find((c) => c.name === "left");
    expect(left?.dots.map((d) => d.index)).toEqual([2, 1, 0]);
    // The top view's eye is above (+z): the contact with the larger z is drawn last.
    const tops = [contact(0, [0, 0, -5]), contact(1, [0, 0, 5])];
    expect(
      layout(tops)
        .cells.find((c) => c.name === "top")
        ?.dots.map((d) => d.index),
    ).toEqual([0, 1]);
    // The front view's eye is on the +y side: the larger y is drawn last.
    const fronts = [contact(0, [0, 5, 0]), contact(1, [0, -5, 0])];
    expect(
      layout(fronts)
        .cells.find((c) => c.name === "front")
        ?.dots.map((d) => d.index),
    ).toEqual([1, 0]);
  });

  it("always draws a selected contact last", () => {
    const cs = [contact(0, [5, 0, 0], { selected: true }), contact(1, [-5, 0, 0])];
    for (const cell of layout(cs).cells) expect(cell.dots[cell.dots.length - 1].index).toBe(0);
  });
});

describe("orientation letters", () => {
  const POSITIVE = ["R", "A", "S"] as const; // the positive end of x, y, z
  const NEGATIVE = ["L", "P", "I"] as const;

  it("sit on the side of the screen where the 3D camera puts each axis's end", () => {
    const axes = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ] as const;
    for (const name of VIEW_NAMES) {
      const cam = createCamera();
      setPreset(cam, name);
      const o = project(cam, [0, 0, 0], 800, 800);
      const ends = viewEnds(name);
      for (const axis of [0, 1, 2] as const) {
        const [px, py] = project(cam, axes[axis], 800, 800);
        const dx = Math.round((px - o[0]) * 1000) / 1000;
        const dy = Math.round((py - o[1]) * 1000) / 1000;
        if (dx !== 0) {
          expect(dx > 0 ? ends.right : ends.left, `${name} +${axis}`).toBe(POSITIVE[axis]);
          expect(dx > 0 ? ends.left : ends.right, `${name} -${axis}`).toBe(NEGATIVE[axis]);
        }
        if (dy !== 0) {
          expect(dy < 0 ? ends.top : ends.bottom, `${name} +${axis}`).toBe(POSITIVE[axis]);
          expect(dy < 0 ? ends.bottom : ends.top, `${name} -${axis}`).toBe(NEGATIVE[axis]);
        }
      }
    }
  });

  it("are the known letters for RAS: A and P with S and I on the left view, and so on", () => {
    expect(viewEnds("left")).toEqual({ left: "A", right: "P", top: "S", bottom: "I" });
    expect(viewEnds("top")).toEqual({ left: "L", right: "R", top: "A", bottom: "P" });
    expect(viewEnds("front")).toEqual({ left: "R", right: "L", top: "S", bottom: "I" });
  });

  it("never touch a neighboring view's letters, and sit inside their own view's frame", () => {
    // A letter's footprint: the glyph is about 0.6 em wide and 1 em tall, set on its baseline.
    const box = (l: { text: string; x: number; y: number; anchor: string }) => {
      const w = 0.6 * LETTER_PX * l.text.length;
      const left = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
      return { left, right: left + w, top: l.y - LETTER_PX, bottom: l.y };
    };
    const GAP = 8; // pixels that must stay free between two letters of different views
    for (const arrangement of ["row", "grid"] as const) {
      const region =
        arrangement === "row"
          ? { x: 0, y: 0, width: 900, height: 300 }
          : { x: 0, y: 0, width: 340, height: 330 };
      const cells = layout([contact(0, [1, 2, 3])], { arrangement, region }).cells;
      for (const cell of cells) {
        for (const l of cell.letters) {
          const b = box(l);
          // Inside the view's own frame, clear of its edge.
          expect(b.left, `${cell.name} ${l.text}`).toBeGreaterThan(cell.frame.x + 2);
          expect(b.right, `${cell.name} ${l.text}`).toBeLessThan(
            cell.frame.x + cell.frame.width - 2,
          );
          expect(b.top, `${cell.name} ${l.text}`).toBeGreaterThan(cell.frame.y + 2);
          expect(b.bottom, `${cell.name} ${l.text}`).toBeLessThan(cell.frame.y + cell.frame.height);
        }
      }
      for (const a of cells) {
        for (const b of cells) {
          if (a === b) continue;
          for (const la of a.letters) {
            for (const lb of b.letters) {
              const [p, q] = [box(la), box(lb)];
              const gapX = Math.max(q.left - p.right, p.left - q.right);
              const gapY = Math.max(q.top - p.bottom, p.top - q.bottom);
              expect(
                Math.max(gapX, gapY),
                `${a.name} ${la.text} / ${b.name} ${lb.text}`,
              ).toBeGreaterThanOrEqual(GAP);
            }
          }
        }
      }
    }
    expect(LETTER_INSET_PX).toBeGreaterThan(FRAME_INSET_PX);
  });

  it("have a frame round each view that never touches its neighbor's", () => {
    const cells = layout([contact(0, [1, 2, 3])]).cells;
    for (let i = 1; i < cells.length; i++) {
      expect(
        cells[i].frame.x - (cells[i - 1].frame.x + cells[i - 1].frame.width),
      ).toBeGreaterThanOrEqual(2 * FRAME_INSET_PX);
    }
    expect(
      viewsMarkup(layout([contact(0, [1, 2, 3])]), THEME, "sans-serif").match(/data-view-frame/g),
    ).toHaveLength(3);
  });

  it("are placed at the four sides of each view and written into the markup", () => {
    const views = layout([contact(0, [1, 2, 3])]);
    for (const cell of views.cells) {
      const [left, right, top, bottom] = cell.letters;
      expect(left.x).toBeLessThan(cell.box.x + cell.box.width / 2);
      expect(right.x).toBeGreaterThan(cell.box.x + cell.box.width / 2);
      expect(top.y).toBeLessThan(bottom.y);
      expect(cell.letters.map((l) => l.text)).toEqual([
        viewEnds(cell.name).left,
        viewEnds(cell.name).right,
        viewEnds(cell.name).top,
        viewEnds(cell.name).bottom,
      ]);
    }
    const markup = viewsMarkup(views, THEME, "sans-serif");
    expect(markup.match(/data-orientation="/g)).toHaveLength(12);
  });
});

describe("layout", () => {
  it("uses one scale for all three views", () => {
    // Known answer: contacts 20 mm apart along each axis. Pixel distances must match in every view.
    const cs = [contact(0, [0, 0, 0]), contact(1, [20, 20, 20])];
    const views = layout(cs);
    const spans = views.cells.map((cell) => {
      const [a, b] = [...cell.dots].sort((p, q) => p.index - q.index);
      return Math.hypot(b.cx - a.cx, b.cy - a.cy);
    });
    // The left view's diagonal is 20 mm by 20 mm, as are the top view's and the front view's.
    expect(spans[0]).toBeCloseTo(spans[1], 1);
    expect(spans[1]).toBeCloseTo(spans[2], 1);
    // And it is a real scale: 20 mm by 20 mm spans more than a dot.
    expect(spans[0]).toBeGreaterThan(20);
  });

  it("keeps every dot inside its own cell", () => {
    const cs = nm485.spaces[1].contacts.map((c, i) => contact(i, c.position));
    const views = layout(cs);
    for (const cell of views.cells) {
      for (const d of cell.dots) {
        expect(d.cx - d.r).toBeGreaterThanOrEqual(cell.box.x);
        expect(d.cx + d.r).toBeLessThanOrEqual(cell.box.x + cell.box.width);
        expect(d.cy - d.r).toBeGreaterThanOrEqual(cell.box.y);
        expect(d.cy + d.r).toBeLessThanOrEqual(cell.box.y + cell.box.height);
      }
    }
  });

  it("lays the three views in a row, or two by two for a narrow panel", () => {
    const cs = [contact(0, [1, 2, 3])];
    const row = layout(cs).cells.map((c) => [c.box.x, c.box.y]);
    expect(new Set(row.map((p) => p[1])).size).toBe(1);
    const grid = layout(cs, {
      arrangement: "grid",
      region: { x: 0, y: 0, width: 340, height: 330 },
    });
    expect(new Set(grid.cells.map((c) => c.box.y)).size).toBe(2);
    expect(new Set(grid.cells.map((c) => c.box.x)).size).toBe(2);
  });

  it("copes with no contact, one contact and contacts on one point", () => {
    expect(layout([]).drawn).toBe(0);
    const one = layout([contact(0, [3, 3, 3])]);
    for (const cell of one.cells) {
      expect(cell.dots).toHaveLength(1);
      expect(Number.isFinite(cell.dots[0].cx)).toBe(true);
      expect(Number.isFinite(cell.dots[0].cy)).toBe(true);
    }
    const same = layout([contact(0, [0, 0, 0]), contact(1, [0, 0, 0])]);
    expect(same.cells[0].dots.every((d) => Number.isFinite(d.cx) && Number.isFinite(d.r))).toBe(
      true,
    );
  });
});

describe("dot size", () => {
  it("follows the 3D view's radius rule, in millimeters, when the units are millimeters", () => {
    // Known answer: size 28.27 mm2 is a 3 mm radius (the rule's upper clamp); 'n/a' is 1.5 mm.
    const cs = [contact(0, [0, 0, 0], { size: 40 }), contact(1, [60, 0, 0], { size: null })];
    const views = layout(cs);
    const top = views.cells[1];
    const [a, b] = [...top.dots].sort((p, q) => p.index - q.index);
    const scale = Math.abs(b.cx - a.cx) / 60;
    expect(a.r).toBeCloseTo(Math.max(MIN_DOT_PX, contactRadius(40) * scale), 1);
    expect(b.r).toBeCloseTo(Math.max(MIN_DOT_PX, contactRadius(null) * scale), 1);
    expect(contactRadius(40)).toBe(3);
  });

  it("is one fixed size when the units carry no scale claim", () => {
    const cs = [contact(0, [0, 0, 0], { size: 40 }), contact(1, [60, 0, 0], { size: 2 })];
    for (const cell of layout(cs, { millimeters: false }).cells) {
      for (const d of cell.dots) expect(d.r).toBe(FIXED_DOT_PX);
    }
  });
});

describe("contacts without a position are never drawn", () => {
  const all = nm485.spaces[1].contacts;
  const located = all.filter((c) => c.position !== null);

  it("the real electrodes file has contacts with no position", () => {
    expect(nm485.spaces[1].space).toBe("Talairach");
    expect(all.length - located.length).toBeGreaterThan(0);
  });

  it("gives every located contact one circle with a title in each view, and no other", () => {
    const cs = all.map((c, i) => contact(i, c.position, { title: `${c.name}; channel ${c.name}` }));
    const views = layout(cs);
    expect(views.drawn).toBe(located.length);
    for (const cell of views.cells) expect(cell.dots).toHaveLength(located.length);
    const markup = viewsMarkup(views, THEME, "sans-serif");
    expect(markup.match(/<circle /g)).toHaveLength(3 * located.length);
    // Every circle holds its own title, in the file's contact order.
    const circles = markup.match(/<circle [^>]*>.*?<\/circle>/g) ?? [];
    expect(circles).toHaveLength(3 * located.length);
    for (const c of circles) expect(c).toMatch(/<title>[^<]+<\/title><\/circle>$/);
    for (const c of all.filter((x) => x.position === null)) {
      expect(markup).not.toContain(`<title>${c.name};`);
    }
    expect(markup).not.toContain("NaN");
  });

  it("refuses a position that is not three finite numbers", () => {
    const bad = [
      contact(0, [Number.NaN, 0, 0]),
      contact(1, [0, Number.POSITIVE_INFINITY, 0]),
      contact(2, [1, 2, 3]),
    ];
    expect(layout(bad).drawn).toBe(1);
  });
});

describe("template outlines", () => {
  it("are read from the vendored views.json, three closed views", () => {
    for (const name of VIEW_NAMES) {
      expect(OUTLINES[name].polylines.length).toBeGreaterThan(0);
      expect(OUTLINES[name].axes).toEqual(
        name === "left" ? ["y", "z"] : name === "top" ? ["x", "y"] : ["x", "z"],
      );
    }
  });

  it("refuse a file that is not that format, or lacks a view, or holds a bad number", () => {
    expect(() => parseViewOutlines(null)).toThrow(/brain-template-views/);
    expect(() => parseViewOutlines({ format: "other", views: {} })).toThrow();
    const missing = { format: "brain-template-views v1", views: { left: OUTLINES.left } };
    expect(() => parseViewOutlines(missing)).toThrow(/top view is missing/);
    const bad = {
      format: "brain-template-views v1",
      views: Object.fromEntries(
        VIEW_NAMES.map((n) => [
          n,
          {
            axes: OUTLINES[n].axes,
            polylines: [
              [
                [0, 0],
                [1, Number.NaN],
                [2, 2],
              ],
            ],
          },
        ]),
      ),
    };
    expect(() => parseViewOutlines(bad)).toThrow(/not two numbers/);
  });

  it("are drawn only when the caller passes them, and not otherwise", () => {
    const cs = [contact(0, [10, 20, 30])];
    const none = layout(cs, { template: null });
    for (const cell of none.cells) expect(cell.outlinePath).toBeNull();
    expect(viewsMarkup(none, THEME, "sans-serif")).not.toContain("data-template-outline");

    const some = layout(cs, { template: OUTLINES });
    for (const cell of some.cells) {
      expect(cell.outlinePath).toMatch(/^M[\d.\-]+ [\d.\-]+ L/);
      // One closed subpath per polyline, filled even-odd.
      expect(cell.outlinePath?.match(/ Z/g)).toHaveLength(OUTLINES[cell.name].polylines.length);
    }
    const markup = viewsMarkup(some, THEME, "sans-serif");
    expect(markup.match(/data-template-outline/g)).toHaveLength(3);
    expect(markup).toContain('fill-rule="evenodd"');
  });

  it("share the contacts' transform, so a contact on an outline point lands on it", () => {
    // Known answer: a contact placed exactly on the first outline point of each view, in the
    // view's own axes (left: y z, top: x y, front: x z), draws at the path's first point.
    const [fy, fz] = OUTLINES.left.polylines[0][0];
    const [tx, ty] = OUTLINES.top.polylines[0][0];
    const [rx, rz] = OUTLINES.front.polylines[0][0];
    const first = (d: string | null) => {
      const m = /^M([\d.\-]+) ([\d.\-]+)/.exec(d ?? "");
      return [Number(m?.[1]), Number(m?.[2])];
    };
    const left = layout([contact(0, [0, fy, fz])], { template: OUTLINES }).cells[0];
    const top = layout([contact(0, [tx, ty, 0])], { template: OUTLINES }).cells[1];
    const front = layout([contact(0, [rx, 0, rz])], { template: OUTLINES }).cells[2];
    for (const cell of [left, top, front]) {
      const [x, y] = first(cell.outlinePath);
      expect(cell.dots[0].cx).toBeCloseTo(x, 1);
      expect(cell.dots[0].cy).toBeCloseTo(y, 1);
    }
  });
});

describe("markup", () => {
  it("says how the axes are read, once, in one place", () => {
    expect(VIEWS_SENTENCE).toContain("right, anterior and superior");
  });

  it("removes the control characters XML cannot hold from titles and view text", () => {
    const cs = [contact(0, [1, 2, 3], { title: "A\u0001B\u000BC\u0009D\u000AE" })];
    const markup = viewsMarkup(layout(cs), THEME, "sans-serif");
    // Tab and newline are legal XML and stay; U+0001 and U+000B go.
    expect(markup).toContain("<title>ABC\tD\nE</title>");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
    expect(markup).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
  });

  it("escapes what the dataset wrote into a title", () => {
    const cs = [contact(0, [1, 2, 3], { title: 'A<B> & "C"' })];
    const markup = viewsMarkup(layout(cs), THEME, "sans-serif");
    expect(markup).toContain("<title>A&lt;B&gt; &amp; &quot;C&quot;</title>");
    expect(markup).not.toContain("A<B>");
  });

  it("marks the selected contact with a ring and a larger circle", () => {
    const views = layout([contact(0, [1, 2, 3], { selected: true })]);
    const markup = viewsMarkup(views, THEME, "sans-serif");
    expect(markup).toContain('stroke-width="2"');
    const r = views.cells[0].dots[0].r;
    expect(markup).toContain(`r="${Math.round((r + 1) * 100) / 100}"`);
  });
});
