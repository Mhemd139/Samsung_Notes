import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { imageSize, MAX_IMAGE_EDGE } from "../src/images.js";
import { readPdf } from "../src/pdf.js";
import { BLUE_SQUARE_PAGE, makePdf, TALL_PAGE, TEXT_PAGE } from "./pdfFixture.js";

const MAX_API_EDGE = 2000;
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
    expect([image.width, image.height]).toEqual([MAX_IMAGE_EDGE / 2, MAX_IMAGE_EDGE]);
    const at = (Math.floor(image.height * 0.75) * image.width + image.width / 2) * 4;
    const [red, green, blue] = [...image.data.slice(at, at + 3)];
    expect(blue).toBeGreaterThan(200);
    expect(red).toBeLessThan(60);
    expect(green).toBeLessThan(60);
  });

  it("shrinks a very tall page without text under the image limits, keeping its shape", async () => {
    const { pages } = await readPdf(makePdf([TALL_PAGE]), [1], false);
    const size = imageSize(pages[0]!.image!)!;
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_API_EDGE);
    expect(size.width / size.height).toBeCloseTo(TALL_PAGE.width / TALL_PAGE.height, 2);
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
