import type { PDFiumLibrary } from "@hyzyla/pdfium";
import wasmUrl from "@hyzyla/pdfium/pdfium.wasm?url";
import type { PdfPageRenderer } from "../../src/core/note";

const JPEG_QUALITY = 0.82;

let library: Promise<PDFiumLibrary> | undefined;

// Loaded only when a note made from a PDF is drawn: most notes never need the 4 MB PDF engine.
function loadPdfium(): Promise<PDFiumLibrary> {
  library ??= import("@hyzyla/pdfium").then(
    ({ PDFiumLibrary }) => PDFiumLibrary.init({ wasmUrl }),
    (error: unknown) => {
      library = undefined;
      throw error;
    },
  );
  return library;
}

export const renderPdfPage: PdfPageRenderer = async (pdf, pageIndex, pixelWidth) => {
  const pdfDocument = await (await loadPdfium()).loadDocument(pdf);
  try {
    const page = pdfDocument.getPage(pageIndex);
    const { originalWidth, originalHeight } = page.getOriginalSize();
    const { width, height, data } = await page.render({
      render: "bitmap",
      width: pixelWidth,
      height: Math.round((pixelWidth * originalHeight) / originalWidth),
    });
    return jpegUrl(new ImageData(new Uint8ClampedArray(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength), width, height));
  } finally {
    pdfDocument.destroy();
  }
};

function jpegUrl(pixels: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser can't draw pages.");
  context.putImageData(pixels, 0, 0);
  const url = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  canvas.width = canvas.height = 0;
  return url;
}
