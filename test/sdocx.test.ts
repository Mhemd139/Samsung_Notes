import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { inspectNote, renderPageSvg } from "../src/sdocx.js";
import { stripMedia } from "../src/zip.js";
import { fixtureBytes } from "./helpers.js";

const rezip = (name: string, change: (files: Record<string, Uint8Array>) => void): Uint8Array => {
  const files = unzipSync(fixtureBytes(name));
  change(files);
  return zipSync(files);
};

describe("inspectNote", () => {
  it("reads title, text, dates and visible page count", () => {
    const note = inspectNote(fixtureBytes("01-basic-formatting.sdocx"));
    expect(note.title).toBe("01-basic-test");
    expect(note.rawText.startsWith("Compatibility Test 01 - Basic Test\nProject Atlas")).toBe(true);
    expect(note.createdMs).toBe(1787680973769);
    expect(note.modifiedMs).toBe(1787681127064);
    expect(note.pageCount).toBe(5);
  });

  it.each([
    ["01-basic-formatting.sdocx", 1787680973756, 1787681127083],
    ["02-shapes-and-dot-calibration.sdocx", 1789948187239, 1789948286103],
    ["03-image-placement.sdocx", 1789415847775, 1789418134900],
    ["04-marker4-highlighter.sdocx", 1790114086002, 1790114857298],
  ])("keeps the real dates of %s when the note is re-zipped", (name, created, modified) => {
    const full = inspectNote(fixtureBytes(name));
    const lean = inspectNote(stripMedia(fixtureBytes(name)));
    expect(lean).toMatchObject({ createdMs: full.createdMs, modifiedMs: full.modifiedMs });
    expect(Math.abs(full.createdMs! - created)).toBeLessThan(1000);
    expect(Math.abs(full.modifiedMs! - modified)).toBeLessThan(1000);
  });

  it("reports unknown dates when the end tag's date fields are empty", () => {
    const bytes = rezip("01-basic-formatting.sdocx", (files) => {
      files["end_tag.bin"]!.fill(0, 8, 16);
      files["end_tag.bin"]!.fill(0, 46, 54);
    });
    expect(inspectNote(bytes)).toMatchObject({ createdMs: null, modifiedMs: null });
  });

  it("reports unknown dates, not the parser's microsecond values, when there is no end tag", () => {
    const bytes = rezip("01-basic-formatting.sdocx", (files) => {
      delete files["end_tag.bin"];
    });
    expect(inspectNote(bytes)).toMatchObject({ createdMs: null, modifiedMs: null });
  });

  it.each([
    ["02-shapes-and-dot-calibration.sdocx", 1],
    ["03-image-placement.sdocx", 3],
    ["04-marker4-highlighter.sdocx", 1],
  ])("counts only visible pages in %s", (name, pages) => {
    expect(inspectNote(fixtureBytes(name)).pageCount).toBe(pages);
  });

  it("exposes table, code block and image spans", () => {
    const contentKinds = (name: string) =>
      inspectNote(fixtureBytes(name)).spans.flatMap((span) => Object.keys(span.content ?? {}));
    expect(contentKinds("01-basic-formatting.sdocx")).toEqual(expect.arrayContaining(["Table", "CodeBlock"]));
    expect(contentKinds("03-image-placement.sdocx")).toContain("Image");
  });

  it.each([
    ["01-basic-formatting.sdocx", []],
    ["02-shapes-and-dot-calibration.sdocx", [1]],
    ["03-image-placement.sdocx", []],
    ["04-marker4-highlighter.sdocx", [1]],
  ])("finds the pages with handwriting or drawings in %s", (name, pages) => {
    expect(inspectNote(fixtureBytes(name)).inkPages).toEqual(pages);
  });

  it("throws on bytes that are not a note", () => {
    expect(() => inspectNote(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe("renderPageSvg", () => {
  it("renders a page as SVG with a viewBox", () => {
    const svg = renderPageSvg(fixtureBytes("04-marker4-highlighter.sdocx"), 0);
    expect(svg).toMatch(/<svg\b/);
    expect(svg).toMatch(/viewBox="[^"]+"/);
  });
});
