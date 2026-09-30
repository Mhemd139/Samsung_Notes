import { describe, expect, it } from "vitest";
import { inspectNote } from "../src/sdocx.js";
import { buildNoteText, formatDate, noteTitle } from "../src/text.js";
import { fixtureBytes } from "./helpers.js";

const textOf = (name: string, files: string[] = []) => {
  const note = inspectNote(fixtureBytes(name));
  return buildNoteText(note.rawText, note.spans, files);
};

const tableAt = (index: number, ...rows: string[]) => ({
  object_type: "Table",
  text_index_utf16: index,
  content: { Table: { rows: rows.map((text) => ({ cells: [{ content: { text } }] })) } },
});

describe("buildNoteText", () => {
  it("puts tables in place as markdown", () => {
    const text = textOf("01-basic-formatting.sdocx");
    expect(text).toContain("| Column A | Column B |\n| --- | --- |\n| Alpha | Beta |");
    expect(text).not.toContain("￼");
  });

  it("keeps code blocks fenced with their title", () => {
    expect(textOf("01-basic-formatting.sdocx")).toMatch(/```text\nfn main\(\) \{/);
  });

  it("marks inline images with their attachment file", () => {
    expect(textOf("03-image-placement.sdocx", ["0@paste_260914_153237_553.png"])).toContain(
      "[image: 0@paste_260914_153237_553.png]",
    );
  });

  it("uses a bare marker when the image file is unknown", () => {
    const span = { object_type: "Image", text_index_utf16: 1, content: { Image: { media_id: 7 } } };
    expect(buildNoteText("a￼b", [span], [])).toBe("a[image]b");
  });

  it("names objects it can't render", () => {
    const span = { object_type: "Voice", text_index_utf16: 0, content: { Voice: {} } };
    expect(buildNoteText("￼", [span], [])).toBe("[Voice]");
  });

  it("appends an object whose index misses its marker instead of dropping it", () => {
    const text = buildNoteText("one two", [tableAt(4, "Col", "val")], []);
    expect(text).toBe("one two\n\n| Col |\n| --- |\n| val |");
  });

  it("appends several misplaced objects in note order", () => {
    const voice = { object_type: "Voice", text_index_utf16: 99, content: { Voice: {} } };
    const text = buildNoteText("one two", [voice, tableAt(4, "Col")], []);
    expect(text).toBe("one two\n\n| Col |\n| --- |\n\n[Voice]");
  });

  it("decodes HTML entities in one pass", () => {
    expect(buildNoteText("a &lt; b &gt; c &amp;lt; &quot;q&quot;", [], [])).toBe('a < b > c &lt; "q"');
  });

  it("drops trailing spaces and collapses blank runs", () => {
    expect(buildNoteText("  one  \n\n\n\ntwo \n", [], [])).toBe("one\n\ntwo");
  });
});

describe("noteTitle", () => {
  const base = { title: "", text: "", modifiedMs: null };

  it("prefers the note's own title", () => {
    expect(noteTitle({ ...base, title: " Groceries ", indexTitle: "x" })).toBe("Groceries");
  });

  it("uses the index or file title next", () => {
    expect(noteTitle({ ...base, indexTitle: "From index" })).toBe("From index");
  });

  it("falls back to the first line with words", () => {
    expect(noteTitle({ ...base, text: "\n[image: a.png]\n| x | y |\n  Invoice 42 – ACME\nmore" })).toBe(
      "Invoice 42 – ACME",
    );
  });

  it("names notes without any words by date", () => {
    expect(noteTitle({ ...base, modifiedMs: new Date(2026, 1, 23, 9, 30).getTime() })).toBe(
      "Untitled note (2026-02-23)",
    );
    expect(noteTitle(base)).toBe("Untitled note");
  });

  it("truncates long titles to 80 characters", () => {
    const title = noteTitle({ ...base, text: "x".repeat(200) });
    expect(title).toHaveLength(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("cuts titles on code points, never inside an emoji", () => {
    const title = noteTitle({ ...base, text: `${"x".repeat(78)}😀${"x".repeat(50)}` });
    expect(title).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(title).toBe(`${"x".repeat(78)}😀…`);
  });
});

describe("formatDate", () => {
  it("formats local dates", () => {
    expect(formatDate(new Date(2026, 0, 5, 23, 59).getTime())).toBe("2026-01-05");
  });
});
