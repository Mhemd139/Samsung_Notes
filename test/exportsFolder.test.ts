import { copyFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { exportsFolderSource } from "../src/sources/exportsFolder.js";
import type { NoteRef } from "../src/sources/types.js";
import { fixturePath, tempDir } from "./helpers.js";

let root: string;

beforeEach(() => {
  root = tempDir("sn-exports");
  mkdirSync(join(root, "Invoices", "März 2026"), { recursive: true });
  copyFileSync(fixturePath("03-image-placement.sdocx"), join(root, "Invoices", "März 2026", "Receipt ACME.sdocx"));
  copyFileSync(fixturePath("01-basic-formatting.sdocx"), join(root, "basic.SDOCX"));
  writeFileSync(join(root, "readme.txt"), "not a note");
});

const list = async (): Promise<NoteRef[]> => (await exportsFolderSource(root).listNotes()).notes;
const receipt = async (): Promise<NoteRef> => (await list()).find((n) => n.folder.startsWith("Invoices"))!;

describe("exportsFolderSource", () => {
  it("finds .sdocx files in subfolders and names them by path", async () => {
    const notes = await list();
    expect(notes.map((n) => [n.id, n.folder, n.indexTitle]).sort()).toEqual([
      ["file:Invoices/März 2026/Receipt ACME.sdocx", "Invoices/März 2026", "Receipt ACME"],
      ["file:basic.SDOCX", "", "basic"],
    ]);
    expect(notes.every((n) => !n.locked)).toBe(true);
  });

  it("describes itself", () => {
    const source = exportsFolderSource(root);
    expect([source.name, source.location]).toEqual(["Exported notes", root]);
  });

  it("lists attachments with type and size", async () => {
    expect(await (await receipt()).attachments()).toEqual([
      { file: "0@paste_260914_153237_553.png", mimeType: "image/png", size: 221010 },
    ]);
  });

  it("reads an attachment and refuses unknown names", async () => {
    const note = await receipt();
    expect([...(await note.readAttachment("0@paste_260914_153237_553.png")).slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await expect(note.readAttachment("../../secret.txt")).rejects.toThrow("no attachment named “../../secret.txt”");
  });

  it("gives lean bytes smaller than the full note", async () => {
    const note = await receipt();
    expect((await note.leanBytes()).length).toBeLessThan((await note.fullBytes()).length);
  });

  it("changes the stamp when the file changes", async () => {
    const before = (await receipt()).stamp;
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(root, "Invoices", "März 2026", "Receipt ACME.sdocx"), later, later);
    expect((await receipt()).stamp).not.toBe(before);
  });

  it("explains a missing folder", async () => {
    await expect(exportsFolderSource(join(root, "missing")).listNotes()).rejects.toThrow("Folder not found");
  });
});
