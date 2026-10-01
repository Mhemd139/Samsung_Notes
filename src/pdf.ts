import { PDFiumLibrary, type PDFiumDocument, type PDFiumPage } from "@hyzyla/pdfium";
import { describeError, NoteError } from "./errors.js";
import { encodeJpeg, IMAGE_WIDTH, imageForClaude } from "./images.js";

const MIN_TEXT_CHARS = 20;
export const PDF_BUDGET_BYTES = 850_000;

export interface PdfPage {
  number: number;
  text: string;
  image?: Uint8Array;
}

let library: Promise<PDFiumLibrary> | undefined;

export async function readPdf(
  bytes: Uint8Array,
  pageNumbers: number[],
  alwaysRender: boolean,
  budget = PDF_BUDGET_BYTES,
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
      const image = !alwaysRender && text.length >= MIN_TEXT_CHARS ? undefined : await renderJpeg(page);
      const size = Buffer.byteLength(text) + (image ? Math.ceil(image.length / 3) * 4 : 0);
      if (pages.length > 0 && used + size > budget) break;
      used += size;
      pages.push(image ? { number, text, image } : { number, text });
    }
    return { pageCount, pages };
  } finally {
    document.destroy();
  }
}

async function renderJpeg(page: PDFiumPage): Promise<Uint8Array> {
  const { originalWidth, originalHeight } = page.getOriginalSize();
  const rendered = await page.render({
    width: IMAGE_WIDTH,
    height: Math.round((IMAGE_WIDTH * originalHeight) / originalWidth),
    render: async (bitmap: { width: number; height: number; data: Uint8Array }) => encodeJpeg(bitmap.width, bitmap.height, bitmap.data),
  });
  return imageForClaude(rendered.data, "image/jpeg").data;
}
