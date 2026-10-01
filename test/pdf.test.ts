import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { IMAGE_WIDTH } from "../src/images.js";
import { readPdf } from "../src/pdf.js";
import { BLUE_SQUARE_PAGE, makePdf, TEXT_PAGE } from "./pdfFixture.js";

const pdf = makePdf([TEXT_PAGE, BLUE_SQUARE_PAGE]);

describe("readPdf", () => {
  it("returns text for text pages and skips their images", async () => {
    const { pageCount, pages } = await readPdf(pdf, [1], false);
    expect(pageCount).toBe(2);
    expect(pages[0]?.text).toContain("Invoice 42 ACME");
    expect(pages[0]?.image).toBeUndefined();
  });

  it("renders pages without text as JPEG, proportionally and in true colour", async () => {
    const { pages } = await readPdf(pdf, [2], false);
    const image = jpeg.decode(pages[0]!.image!);
    expect([image.width, image.height]).toEqual([IMAGE_WIDTH, IMAGE_WIDTH * 2]);
    const at = (1800 * image.width + 600) * 4;
    const [red, green, blue] = [...image.data.slice(at, at + 3)];
    expect(blue).toBeGreaterThan(200);
    expect(red).toBeLessThan(60);
    expect(green).toBeLessThan(60);
  });

  it("renders text pages too when asked", async () => {
    const { pages } = await readPdf(pdf, [1], true);
    expect(pages[0]?.image).toBeDefined();
  });

  it("ignores page numbers outside the document", async () => {
    const { pages } = await readPdf(pdf, [0, 2, 9], false);
    expect(pages.map((page) => page.number)).toEqual([2]);
  });

  it("stops adding pages once the size budget is spent", async () => {
    const squares = makePdf([BLUE_SQUARE_PAGE, BLUE_SQUARE_PAGE, BLUE_SQUARE_PAGE]);
    expect((await readPdf(squares, [1, 2, 3], false, 1)).pages.map((page) => page.number)).toEqual([1]);
    expect((await readPdf(squares, [1, 2, 3], false)).pages.map((page) => page.number)).toEqual([1, 2, 3]);
  });

  it("explains files it can't open", async () => {
    await expect(readPdf(new Uint8Array([1, 2, 3]), [1], false)).rejects.toThrow(/can't be opened/);
  });
});
