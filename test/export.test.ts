import { PDFiumLibrary } from "@hyzyla/pdfium";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { cleanName } from "../src/fileName.js";
import { noteMarkdown } from "../src/markdown.js";
import { readPdf } from "../src/pdf.js";
import { buildPdf } from "../src/pdfWriter.js";
import { sheetBands } from "../src/svg.js";

const solidJpeg = (width: number, height: number, [red, green, blue]: [number, number, number]) => {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([red, green, blue, 255], i);
  return { jpeg: jpeg.encode({ width, height, data }, 90).data, width, height };
};

const TITLE = "Grocery list 🛒 قائمة";
const pdf = buildPdf([solidJpeg(210, 297, [0, 0, 255]), solidJpeg(400, 200, [255, 0, 0])], {
  title: TITLE,
  createdMs: Date.UTC(2024, 4, 1, 9, 30),
  modifiedMs: null,
});

describe("buildPdf", () => {
  it("makes one A4-wide page per image that PDFium opens", async () => {
    const library = await PDFiumLibrary.init();
    const document = await library.loadDocument(pdf);
    try {
      expect(document.getPageCount()).toBe(2);
      const portrait = document.getPage(0).getOriginalSize();
      expect(portrait.originalWidth).toBeCloseTo(595.28, 1);
      expect(portrait.originalHeight).toBeCloseTo(841.9, 1);
      const landscape = document.getPage(1).getOriginalSize();
      expect(landscape.originalWidth).toBeCloseTo(841.89, 1);
      expect(landscape.originalHeight).toBeCloseTo(420.95, 1);
    } finally {
      document.destroy();
      library.destroy();
    }
  });

  it("draws each image across its whole page", async () => {
    const { pages } = await readPdf(pdf, [1], false);
    const image = jpeg.decode(pages[0]!.image!);
    for (const [x, y] of [[0.05, 0.05], [0.5, 0.5], [0.95, 0.95]] as const) {
      const at = (Math.floor(image.height * y) * image.width + Math.floor(image.width * x)) * 4;
      expect(image.data[at + 2]).toBeGreaterThan(200);
      expect(image.data[at]).toBeLessThan(60);
    }
  });

  it("stores the title as UTF-16 so any language survives, and the creation date", () => {
    const raw = new TextDecoder("latin1").decode(pdf);
    const hex = Array.from({ length: TITLE.length }, (_, i) => TITLE.charCodeAt(i).toString(16).padStart(4, "0")).join("");
    expect(raw).toContain(`/Title <FEFF${hex}>`);
    expect(raw).toContain("/CreationDate (D:20240501093000Z)");
    expect(raw).not.toContain("/ModDate");
  });

  it("points the xref table at every object", () => {
    const raw = new TextDecoder("latin1").decode(pdf);
    const xref = Number(/startxref\n(\d+)/.exec(raw)![1]);
    const offsets = raw.slice(xref).split("\n").slice(3, 12).map((line) => Number(line.slice(0, 10)));
    offsets.forEach((offset, i) => expect(raw.slice(offset, offset + 10)).toMatch(new RegExp(`^${i + 1} 0 obj`)));
  });
});

describe("sheetBands", () => {
  it("keeps an A4-like page as one sheet", () => {
    expect(sheetBands(1080, 1527)).toEqual([{ top: 0, height: 1527 }]);
  });

  it("cuts a long page into A4 sheets with no overlap", () => {
    const bands = sheetBands(1000, 5000);
    expect(bands.map((band) => Math.round(band.height))).toEqual([1414, 1414, 1414, 757]);
    bands.slice(1).forEach((band, i) => expect(band.top).toBeCloseTo(bands[i]!.top + bands[i]!.height, 6));
  });

  it("folds a sliver at the end into the last sheet", () => {
    const bands = sheetBands(1000, 1414.3 * 2 + 100);
    expect(bands).toHaveLength(2);
    expect(bands[1]!.top + bands[1]!.height).toBeCloseTo(1414.3 * 2 + 100, 6);
  });
});

describe("noteMarkdown", () => {
  const files = [
    { name: "0@paste_1.png", path: "files/0@paste_1.png" },
    { name: "1@scan.pdf", path: "files/1@scan.pdf" },
    { name: "2@photo.jpg", path: "files/2@photo.jpg" },
  ];

  it("keeps dates in front matter, links inline images and lists the other files", () => {
    const markdown = noteMarkdown({
      title: 'Trip "Rome"',
      heading: 'Trip "Rome"',
      text: "Day 1\n[image: 0@paste_1.png]\n| a | b |",
      createdMs: Date.UTC(2024, 0, 2, 3, 4, 5),
      modifiedMs: Date.UTC(2024, 1, 3),
      pdf: 'Trip "Rome".pdf',
      files,
    });
    expect(markdown).toBe(
      [
        "---",
        'title: "Trip \\"Rome\\""',
        "created: 2024-01-02T03:04:05.000Z",
        "modified: 2024-02-03T00:00:00.000Z",
        "---",
        "",
        '# Trip "Rome"',
        "",
        "Day 1",
        "![](<files/0@paste_1.png>)",
        "| a | b |",
        "",
        '[Trip "Rome".pdf](<Trip "Rome".pdf>)',
        "",
        "- [1@scan.pdf](<files/1@scan.pdf>)",
        "![](<files/2@photo.jpg>)",
        "",
      ].join("\n"),
    );
  });

  it("leaves out a heading and dates it doesn't have, and keeps unknown image markers", () => {
    expect(noteMarkdown({ title: "x", text: "[image: 9@gone.png]", createdMs: null, modifiedMs: null, files: [] })).toBe(
      ['---', 'title: "x"', "---", "", "[image: 9@gone.png]", ""].join("\n"),
    );
  });
});

describe("cleanName", () => {
  it("cuts names at a byte limit without splitting a character", () => {
    expect(cleanName("שלום עולם", 9)).toBe("שלום");
    expect(cleanName("a/b:c", 100)).toBe("a_b_c");
  });
});
