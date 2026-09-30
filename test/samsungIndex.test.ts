import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSamsungIndex } from "../src/sources/samsungIndex.js";
import { tempDir } from "./helpers.js";
import { makeLocalState } from "./windowsFixture.js";

const FOLDERS = [
  { uuid: "root_container", name: "Default" },
  { uuid: "inv-0001", parent: "root_container", name: "Invoices" },
  { uuid: "sub-2026", parent: "inv-0001", name: "2026" },
  { uuid: "nameless", parent: "root_container", name: "  " },
  { uuid: "loner", name: "Top level" },
  { uuid: "loop-a", parent: "loop-b", name: "A" },
  { uuid: "loop-b", parent: "loop-a", name: "B" },
];

async function indexFor(notes: Parameters<typeof makeLocalState>[1]) {
  const localState = await makeLocalState(tempDir("sn-index"), notes, FOLDERS);
  return readSamsungIndex(join(localState, "Storage.sqlite"));
}

describe("readSamsungIndex", () => {
  it("builds folder paths below the root container", async () => {
    const index = await indexFor([
      { uuid: "n1", fixture: "01-basic-formatting.sdocx", folderId: "sub-2026" },
      { uuid: "n2", fixture: "01-basic-formatting.sdocx", folderId: "root_container" },
      { uuid: "n3", fixture: "01-basic-formatting.sdocx", folderId: "nameless" },
      { uuid: "n4", fixture: "01-basic-formatting.sdocx", folderId: "loner" },
      { uuid: "n5", fixture: "01-basic-formatting.sdocx", folderId: "not-in-table" },
      { uuid: "n6", fixture: "01-basic-formatting.sdocx", folderId: "loop-a" },
    ]);
    expect(index.get("n1")?.folder).toBe("Invoices/2026");
    expect(index.get("n2")?.folder).toBe("");
    expect(index.get("n3")?.folder).toBe("Unnamed folder");
    expect(index.get("n4")?.folder).toBe("Top level");
    expect(index.get("n5")?.folder).toBe("");
    expect(typeof index.get("n6")?.folder).toBe("string");
  });

  it("reads trash, lock and title flags", async () => {
    const index = await indexFor([
      { uuid: "t", fixture: "01-basic-formatting.sdocx", deleted: true },
      { uuid: "l", fixture: "01-basic-formatting.sdocx", locked: true, title: "Bank" },
    ]);
    expect(index.get("t")).toMatchObject({ deleted: true, locked: false });
    expect(index.get("l")).toMatchObject({ deleted: false, locked: true, title: "Bank" });
  });

  it("fails loudly on a file that is not SQLite", async () => {
    await expect(readSamsungIndex(join(tempDir("sn-bad"), "missing.sqlite"))).rejects.toThrow();
  });

  it("fails loudly on a file that exists but is not a database", async () => {
    const notADatabase = join(tempDir("sn-bad"), "Storage.sqlite");
    writeFileSync(notADatabase, "this is not a sqlite database, just text that is long enough to read as a header");
    await expect(readSamsungIndex(notADatabase)).rejects.toThrow();
  });
});
