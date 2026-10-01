import { PDFiumLibrary, type PDFiumDocument, type PDFiumPage } from "@hyzyla/pdfium";
import { describeError, NoteError } from "./errors.js";
import { attachmentParts, encodeJpeg, IMAGE_WIDTH, imageForClaude, partBand } from "./images.js";

const MIN_TEXT_CHARS = 20;
export const PDF_BUDGET_BYTES = 850_000;

export interface PdfPage {
  number: number;
  text: string;
  image?: Uint8Array;
  parts?: number;
}

let library: Promise<PDFiumLibrary> | undefined;

export async function readPdf(
  bytes: Uint8Array,
  pageNumbers: number[],
  alwaysRender: boolean,
  budget = PDF_BUDGET_BYTES,
  part = 1,
): Promise<{ pageCount: number; pages: PdfPage[] }> {
  const pdfium = await (library ??= PDFiumLibrary.init());
  let document: PDFiumDocument;
  try {
    document = await pdfium.loadDocument(bytes);
  } catch (err) {
    throw new NoteError(`This PDF can't be opened (${describeError(err)}). It may be password-protected or damaged.`);
  }
  try {
    const pageCount = document.getPageCount();
    const pages: PdfPage[] = [];
    let used = 0;
    for (const number of pageNumbers.filter((n) => n >= 1 && n <= pageCount)) {
      const page = document.getPage(number - 1);
      const text = page.getText().trim();
      const rendered = !alwaysRender && text.length >= MIN_TEXT_CHARS ? undefined : await renderJpeg(page, number, part);
      const size = Buffer.byteLength(text) + (rendered ? Math.ceil(rendered.image.length / 3) * 4 : 0);
      if (pages.length > 0 && used + size > budget) break;
      used += size;
      pages.push(rendered ? { number, text, ...rendered } : { number, text });
    }
    return { pageCount, pages };
  } finally {
    document.destroy();
  }
}

async function renderJpeg(page: PDFiumPage, number: number, part: number): Promise<{ image: Uint8Array; parts: number }> {
  const { originalWidth, originalHeight } = page.getOriginalSize();
  const height = Math.round((IMAGE_WIDTH * originalHeight) / originalWidth);
  const parts = attachmentParts(IMAGE_WIDTH, height);
  if (part > parts) throw new NoteError(`Page ${number} has ${parts} part${parts === 1 ? "" : "s"}.`);
  const band = partBand(IMAGE_WIDTH, height, part, parts);
  const { data } = await page.render({
    width: IMAGE_WIDTH,
    height,
    render: async (bitmap: { width: number; height: number; data: Uint8Array }) => {
      const row = bitmap.width * 4;
      const top = Math.round(band.top);
      return encodeJpeg(bitmap.width, band.height, bitmap.data.subarray(top * row, (top + band.height) * row));
    },
  });
  return { image: imageForClaude(data, "image/jpeg").data, parts };
}
