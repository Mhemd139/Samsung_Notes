import { describe, expect, it } from "vitest";
import { inspectNote, renderPageSvg } from "../src/sdocx.js";
import { fixtureBytes } from "./helpers.js";

describe("inspectNote", () => {
  it("reads title, text, dates and visible page count", () => {
    const note = inspectNote(fixtureBytes("01-basic-formatting.sdocx"));
    expect(note.title).toBe("01-basic-test");
    expect(note.rawText.startsWith("Compatibility Test 01 - Basic Test\nProject Atlas")).toBe(true);
    expect(note.createdMs).toBe(1787680973756);
    expect(note.modifiedMs).toBe(1787681127083);
    expect(note.pageCount).toBe(5);
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
