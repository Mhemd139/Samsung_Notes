import { rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { windowsAppSource } from "../src/sources/windowsApp.js";
import { tempDir } from "./helpers.js";
import { makeLocalState } from "./windowsFixture.js";

let localState: string;

beforeEach(async () => {
  localState = await makeLocalState(
    tempDir("sn-win"),
    [
      { uuid: "aaaa", fixture: "03-image-placement.sdocx", folderId: "inv", title: "Receipt March", extraMedia: { "5@page_0000001.spi": new Uint8Array([1, 2]) } },
      { uuid: "bbbb", fixture: "01-basic-formatting.sdocx", folderId: "root" },
      { uuid: "cccc", fixture: "04-marker4-highlighter.sdocx", deleted: true },
      { uuid: "dddd", fixture: "02-shapes-and-dot-calibration.sdocx", locked: true },
      { uuid: "eeee", fixture: "04-marker4-highlighter.sdocx", indexed: false },
    ],
    [
      { uuid: "root", name: "Default" },
      { uuid: "inv", parent: "root", name: "Invoices" },
    ],
  );
});

const listing = () => windowsAppSource(localState).listNotes();
const note = async (id: string) => (await listing()).notes.find((n) => n.id === id)!;

describe("windowsAppSource", () => {
  it("lists notes on disk except the recycle bin", async () => {
    const { notes, warnings } = await listing();
    expect(notes.map((n) => n.id).sort()).toEqual(["aaaa", "bbbb", "dddd", "eeee"]);
    expect(warnings).toEqual([]);
  });

  it("takes folder, title and lock from the index", async () => {
    expect(await note("aaaa")).toMatchObject({ folder: "Invoices", indexTitle: "Receipt March", locked: false });
    expect(await note("bbbb")).toMatchObject({ folder: "", locked: false });
    expect(await note("dddd")).toMatchObject({ locked: true });
    expect(await note("eeee")).toMatchObject({ folder: "", locked: false, indexTitle: undefined });
  });

  it("lists real attachments only", async () => {
    expect(await (await note("aaaa")).attachments()).toEqual([
      { file: "0@paste_260914_153237_553.png", mimeType: "image/png", size: 221010 },
    ]);
    expect(await (await note("bbbb")).attachments()).toEqual([]);
  });

  it("refuses to read internal or unknown files", async () => {
    const receipt = await note("aaaa");
    await expect(receipt.readAttachment("5@page_0000001.spi")).rejects.toThrow("no attachment named");
    await expect(receipt.readAttachment("..\\..\\Storage.sqlite")).rejects.toThrow("no attachment named");
    expect((await receipt.readAttachment("0@paste_260914_153237_553.png")).length).toBe(221010);
  });

  it("refuses the media index and paths outside the note", async () => {
    const receipt = await note("aaaa");
    await expect(receipt.readAttachment("mediaInfo.dat")).rejects.toThrow("no attachment named");
    await expect(receipt.readAttachment("../../Storage.sqlite")).rejects.toThrow("no attachment named");
  });

  it("zips lean bytes without attachments and full bytes with them", async () => {
    const receipt = await note("aaaa");
    const leanNames = Object.keys(unzipSync(await receipt.leanBytes()));
    const fullNames = Object.keys(unzipSync(await receipt.fullBytes()));
    expect(leanNames).not.toContain("media/0@paste_260914_153237_553.png");
    expect(fullNames).toContain("media/0@paste_260914_153237_553.png");
  });

  it("changes the stamp when note files change", async () => {
    const before = (await note("bbbb")).stamp;
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(localState, "wdoc", "bbbb", "note.note"), later, later);
    expect((await note("bbbb")).stamp).not.toBe(before);
  });

  it("still lists notes with a warning when the index is unreadable", async () => {
    rmSync(join(localState, "Storage.sqlite"));
    const { notes, warnings } = await listing();
    expect(notes).toHaveLength(5);
    expect(warnings[0]).toMatch(/Couldn't read Samsung Notes' index/);
  });

  it("says there are no notes yet before the first sync", async () => {
    rmSync(join(localState, "wdoc"), { recursive: true });
    expect(await listing()).toEqual({ notes: [], warnings: [expect.stringMatching(/no notes yet/)] });
  });
});
