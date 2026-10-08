import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { inspectNote } from "../src/sdocx.js";
import { zipNoteFolder } from "../src/sources/windowsApp.js";
import { isAttachmentEntry, isMediaEntry, listZipAttachments, readZipAttachment, stripMedia } from "../src/zip.js";
import { fixtureBytes, tempDir } from "./helpers.js";

const entryNames = (zip: Uint8Array) => Object.keys(unzipSync(zip)).sort();

function unpack(fixture: string): string {
  const dir = tempDir("sn-folder");
  for (const [name, data] of Object.entries(unzipSync(fixtureBytes(fixture)))) {
    if (name.endsWith("/")) continue;
    const path = join(dir, ...name.split("/"));
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, data);
  }
  return dir;
}

describe("entry predicates", () => {
  it("separates media, attachments and internal files", () => {
    expect(isMediaEntry("media/mediaInfo.dat")).toBe(false);
    expect(isMediaEntry("media/0@page_0000001.spi")).toBe(true);
    expect(isAttachmentEntry("media/0@page_0000001.spi")).toBe(false);
    expect(isAttachmentEntry("media/0@paste.png")).toBe(true);
    expect(isAttachmentEntry("note.note")).toBe(false);
  });
});

describe("zipNoteFolder", () => {
  it("re-creates a parseable note from an unzipped folder", async () => {
    const dir = unpack("01-basic-formatting.sdocx");
    const zip = await zipNoteFolder(dir, true);
    expect(entryNames(zip)).toEqual(entryNames(fixtureBytes("01-basic-formatting.sdocx")).filter((n) => !n.endsWith("/")));
    expect(inspectNote(zip).title).toBe("01-basic-test");
  });

  it("leaves attachments out in lean mode but keeps mediaInfo.dat", async () => {
    const zip = await zipNoteFolder(unpack("03-image-placement.sdocx"), false);
    expect(entryNames(zip)).toContain("media/mediaInfo.dat");
    expect(entryNames(zip).some((n) => n.startsWith("media/0@"))).toBe(false);
    expect(inspectNote(zip).pageCount).toBe(3);
  });
});

describe("zip attachments", () => {
  const note = fixtureBytes("03-image-placement.sdocx");

  it("lists attachments by file name and size", () => {
    expect(listZipAttachments(note)).toEqual([{ name: "0@paste_260914_153237_553.png", size: 221010 }]);
    expect(listZipAttachments(fixtureBytes("02-shapes-and-dot-calibration.sdocx"))).toEqual([]);
  });

  it("reads one attachment", () => {
    const png = readZipAttachment(note, "0@paste_260914_153237_553.png");
    expect(png && [...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(readZipAttachment(note, "missing.png")).toBeUndefined();
  });

  it("does not serve Samsung-internal media as attachments", () => {
    expect(readZipAttachment(note, "mediaInfo.dat")).toBeUndefined();
    expect(readZipAttachment(fixtureBytes("02-shapes-and-dot-calibration.sdocx"), "0@page_0000001.spi")).toBeUndefined();
  });

  it("ignores directory entries", () => {
    const zip = zipSync({
      "media/": new Uint8Array(0),
      "media/mediaInfo.dat": new Uint8Array([1]),
      "media/a.png": new Uint8Array([2, 3]),
    });
    expect(listZipAttachments(zip)).toEqual([{ name: "a.png", size: 2 }]);
    expect(readZipAttachment(zip, "")).toBeUndefined();
  });

  it("strips media but keeps the text identical", () => {
    const lean = stripMedia(note);
    expect(lean.length).toBeLessThan(note.length);
    expect(inspectNote(lean).rawText).toBe(inspectNote(note).rawText);
  });
});
