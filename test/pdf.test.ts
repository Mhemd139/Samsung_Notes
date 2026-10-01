import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { IMAGE_WIDTH, imageSize, MAX_IMAGE_EDGE } from "../src/images.js";
import { PDF_BUDGET_BYTES, readPdf } from "../src/pdf.js";
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

  it("splits a very tall page without text into parts at full width", async () => {
    const tall = makePdf([TALL_PAGE]);
    const [first] = (await readPdf(tall, [1], false)).pages;
    expect(first?.parts).toBe(6);
    expect(imageSize(first!.image!)).toEqual({ width: IMAGE_WIDTH, height: 1800 });
    const [last] = (await readPdf(tall, [1], false, PDF_BUDGET_BYTES, 6)).pages;
    const image = jpeg.decode(last!.image!);
    expect([image.width, image.height]).toEqual([IMAGE_WIDTH, 1800]);
    const at = (1200 * image.width + image.width / 2) * 4;
    expect(image.data[at + 2]).toBeGreaterThan(200);
    expect(image.data[at]).toBeLessThan(60);
  });

  it("cuts parts on whole pixel rows", async () => {
    const strip = makePdf([{ width: 100, height: 777, content: "0 0 1 rg 0 0 10 777 re f" }]);
    for (const part of [2, 3, 4, 5]) {
      const [page] = (await readPdf(strip, [1], false, PDF_BUDGET_BYTES, part)).pages;
      const { width, data } = jpeg.decode(page!.image!);
      const blueAt = (x: number) => data[(900 * width + x) * 4 + 2]! > 200 && data[(900 * width + x) * 4]! < 60;
      expect([blueAt(60), blueAt(1100)]).toEqual([true, false]);
    }
  });

  it("explains a part out of range", async () => {
    await expect(readPdf(makePdf([TALL_PAGE]), [1], false, PDF_BUDGET_BYTES, 7)).rejects.toThrow("Page 1 has 6 parts.");
  });

  it("returns a blank tall page as an image instead of calling it damaged", async () => {
    const { pages } = await readPdf(makePdf([{ ...TALL_PAGE, content: "" }]), [1], false);
    expect(pages[0]?.text).toBe("");
    const size = imageSize(pages[0]!.image!)!;
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_API_EDGE);
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
