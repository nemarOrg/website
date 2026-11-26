/**
 * A small element tree for the quality views' renderers (website ADR 0035 decision 1; ADR 0007, no
 * chart library): each renderer is a pure function from a model to a tree, which the server prints
 * as HTML (`toHtml`, for a view drawn into the page, such as the dataset summary's histograms) and
 * the browser builds into elements (`toDom`). So every drawing is tested without a browser, and
 * the server and the page draw one tree.
 *
 * Text is always escaped and attribute names are checked: a stored cell is never markup.
 */

export interface Element {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly Child[];
}
export type Child = Element | string;

type Attrs = Readonly<Record<string, string | number | boolean | null | undefined>>;

const NAME = /^[a-z][a-z0-9-]*$/i;

/** An element; attributes that are null, undefined or false are left out, true is present. */
export function h(tag: string, attrs: Attrs = {}, ...children: (Child | null | false)[]): Element {
  if (!NAME.test(tag)) throw new Error(`tree: tag ${JSON.stringify(tag)}`);
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (!NAME.test(name) || /^on/i.test(name))
      throw new Error(`tree: attribute ${JSON.stringify(name)}`);
    if (value === null || value === undefined || value === false) continue;
    kept[name] = value === true ? "" : String(value);
  }
  return {
    tag,
    attrs: kept,
    children: children.filter((c): c is Child => c !== null && c !== false),
  };
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Elements HTML writes with no end tag. */
const VOID = new Set(["br", "col", "hr", "img", "input", "wbr"]);

/** The tree as HTML (SVG inside it as SVG markup). */
export function toHtml(node: Child): string {
  if (typeof node === "string") return escapeHtml(node);
  const attrs = Object.entries(node.attrs)
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join("");
  if (VOID.has(node.tag)) return `<${node.tag}${attrs}>`;
  return `<${node.tag}${attrs}>${node.children.map(toHtml).join("")}</${node.tag}>`;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** The tree as DOM nodes of `doc`; an `svg` element and everything in it are SVG elements. */
export function toDom(node: Child, doc: Document, inSvg = false): Node {
  if (typeof node === "string") return doc.createTextNode(node);
  const svg = inSvg || node.tag === "svg";
  const element = svg ? doc.createElementNS(SVG_NS, node.tag) : doc.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) element.setAttribute(name, value);
  for (const child of node.children) element.appendChild(toDom(child, doc, svg));
  return element;
}

/** Every element of the tree, depth first (for tests and attaching behavior). */
export function* walk(node: Child): Generator<Element> {
  if (typeof node === "string") return;
  yield node;
  for (const child of node.children) yield* walk(child);
}

/** The text a tree shows, in document order. */
export function textOf(node: Child): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}
