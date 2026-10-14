import { decode } from "fast-png";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { drawPaper, readPageSvg, type NoteSession } from "../src/core/note.js";
import { IMAGE_WIDTH, svgToPng } from "../src/images.js";
import { renderPdfPage } from "../src/pdf.js";
import { renderPageSvg } from "../src/sdocx.js";
import { fixtureBytes } from "./helpers.js";
import { BLUE_SQUARE_PAGE, makePdf, TEXT_PAGE } from "./pdfFixture.js";

const PDF_FILE = "0@pdf_1.pdf";
const PAGE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 400" width="200" height="400">\n' +
  '<rect fill="#fcfcfc" height="400" width="200" x="0" y="0"/>\n' +
  '<path d="M0 5 H200" stroke="#ff0000" stroke-width="10"/></svg>';
const NOTE = zipSync({ [`media/${PDF_FILE}`]: makePdf([TEXT_PAGE, BLUE_SQUARE_PAGE]) });
const FULL_PAGE = { Integer: [0, 0, 200, 400] };

// A note made from a PDF, as the parser describes it: the page's paper names a PDF page and where it lies.
function pdfNote(rectangle: Record<string, number[]>, files = [{ bind_id: 3, file_name: PDF_FILE }]): NoteSession {
  const inspection = {
    document: {
      pages: [{ objects: [{}], content_bbox: { y_max: 10 }, background: { pdf_paper: [{ media_id: 3, page_index: 1, rectangle }] } }],
      metadata: { media_manifest: { entries: files } },
    },
    layout: { pages: [{ source_page_index: 0 }] },
  };
  return { page_count: 1, inspection: () => inspection, render_svg: () => PAGE_SVG };
}

const pixel = (png: Uint8Array, x: number, y: number) => {
  const image = decode(png);
  const at = (y * image.width + x) * image.channels;
  return [...image.data.slice(at, at + 3)];
};

describe("PDF pages a note was made from", () => {
  it("says which PDF page lies where", () => {
    expect(readPageSvg(pdfNote(FULL_PAGE), 0).paper).toEqual([{ file: PDF_FILE, pageIndex: 1, x: 0, y: 0, width: 200, height: 400 }]);
  });

  it("reads older notes' float rectangles", () => {
    expect(readPageSvg(pdfNote({ Float: [0, 100.5, 200, 300.5] }), 0).paper[0]).toMatchObject({ y: 100.5, height: 200 });
  });

  it("never crops a PDF page to its ink", () => {
    expect(readPageSvg(pdfNote(FULL_PAGE), 0).inkBottom).toBeUndefined();
  });

  it("draws the PDF page over the paper and under the ink", async () => {
    const svg = await drawPaper(readPageSvg(pdfNote(FULL_PAGE), 0), NOTE, IMAGE_WIDTH, renderPdfPage);
    expect(svg.indexOf("<image")).toBeGreaterThan(svg.indexOf("<rect"));
    expect(svg.indexOf("<image")).toBeLessThan(svg.indexOf("<path"));
    const png = svgToPng(svg);
    const [red, green, blue] = pixel(png, 600, 1800);
    expect(blue).toBeGreaterThan(200);
    expect(red! + green!).toBeLessThan(80);
    expect(pixel(png, 600, 30)).toEqual([255, 0, 0]);
  });

  it("leaves pages without a PDF untouched", async () => {
    const bytes = fixtureBytes("04-marker4-highlighter.sdocx");
    const page = renderPageSvg(bytes, 0);
    expect(page.paper).toEqual([]);
    expect(await drawPaper(page, bytes, IMAGE_WIDTH, renderPdfPage)).toBe(page.svg);
  });

  it("says so when the note's PDF file is missing", async () => {
    await expect(drawPaper(readPageSvg(pdfNote(FULL_PAGE), 0), zipSync({}), IMAGE_WIDTH, renderPdfPage)).rejects.toThrow(/missing/);
  });

  it("says so when the note's file list doesn't name the PDF", () => {
    expect(() => readPageSvg(pdfNote(FULL_PAGE, []), 0)).toThrow(/missing/);
  });
});
