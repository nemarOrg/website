import { Resvg, initWasm } from "@resvg/resvg-wasm";
import wasmUrl from "@resvg/resvg-wasm/index_bg.wasm?url";

let initPromise: Promise<void> | null = null;

async function ensureResvg(requestUrl: string): Promise<void> {
  if (!initPromise) {
    const absoluteWasmUrl = new URL(wasmUrl, requestUrl).toString();
    initPromise = initWasm(fetch(absoluteWasmUrl));
  }
  return initPromise;
}

export async function svgToPng(svg: string, requestUrl: string): Promise<Uint8Array> {
  await ensureResvg(requestUrl);
  const renderer = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: {
      loadSystemFonts: false,
      defaultFontFamily: "Inter",
      sansSerifFamily: "Inter",
      monospaceFamily: "monospace",
    },
    shapeRendering: 2,
    textRendering: 1,
    imageRendering: 0,
  });

  try {
    const image = renderer.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    renderer.free();
  }
}
