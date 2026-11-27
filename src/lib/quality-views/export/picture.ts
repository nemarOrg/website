/**
 * A view's images (website phase W8), one chunk loaded as a view's export controls open: the PNG,
 * painted at the chosen scale (`raster.ts`), encoded by the browser, with the text chunks naming
 * the view added to it (`png.ts`); and the SVG (`svg.ts`), re-exported here so both come in one
 * request before any click.
 */

import { metaEntries } from "./meta";
export { exportSvg, svgDrawing } from "./svg";
import { withTextChunks } from "./png";
import { type PictureInput, type Scale, paintPicture } from "./raster";

/** The canvas's PNG bytes, as the browser encodes them. */
export function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error("export: the canvas gave no PNG"));
      blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
    }, "image/png");
  });
}

/** The PNG of a view at `scale`, with its text chunks. */
export async function exportPng(
  doc: Document,
  input: PictureInput,
  scale: Scale,
): Promise<Uint8Array> {
  const canvas = await paintPicture(doc, input, scale);
  return withTextChunks(await canvasPng(canvas), metaEntries(input.meta));
}
