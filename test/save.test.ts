import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NoteError } from "../src/errors.js";
import { fileNameFor, openSaveFolder, subfolders, targetFolder } from "../src/save.js";
import { tempDir } from "./helpers.js";

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("fileNameFor", () => {
  it("keeps the original name without Samsung's N@ prefix", () => {
    expect(fileNameFor("12@scan_0001.JPG")).toBe("scan_0001.jpg");
  });

  it("uses the given name with the original extension", () => {
    expect(fileNameFor("3@x.pdf", "2025-03-14 שופרסל 245.90 ILS")).toBe("2025-03-14 שופרסל 245.90 ILS.pdf");
  });

  it("drops a photo or PDF extension typed into the name", () => {
    expect(fileNameFor("3@x.jpg", "Receipt.JPEG")).toBe("Receipt.jpg");
    expect(fileNameFor("3@x.jpg", "Receipt.pdf")).toBe("Receipt.jpg");
  });

  it("replaces characters Windows forbids and removes control and bidi characters", () => {
    expect(fileNameFor("1@a.png", 'a<b>c:d"e/f\\g|h?i*j')).toBe("a_b_c_d_e_f_g_h_i_j.png");
    expect(fileNameFor("1@a.png", "inv\u202Egpj.exe\u0007\tdone")).toBe("invgpj.exe done.png");
  });

  it("strips leading and trailing dots and spaces", () => {
    expect(fileNameFor("1@a.png", " ..Receipt. . ")).toBe("Receipt.png");
  });

  it("prefixes Windows reserved names", () => {
    expect(fileNameFor("1@a.pdf", "con")).toBe("_con.pdf");
    expect(fileNameFor("1@a.pdf", "LPT1.backup")).toBe("_LPT1.backup.pdf");
    expect(fileNameFor("1@a.pdf", "Console")).toBe("Console.pdf");
  });

  it("cuts a long name to 200 bytes without splitting a character", () => {
    expect(fileNameFor("1@a.pdf", "ק".repeat(150))).toBe(`${"ק".repeat(100)}.pdf`);
    expect(fileNameFor("1@a.pdf", "😀".repeat(60))).toBe(`${"😀".repeat(50)}.pdf`);
  });

  it("falls back to the original name when the given one is empty after cleaning", () => {
    expect(fileNameFor("4@photo.png", " . ")).toBe("photo.png");
    expect(fileNameFor("4@photo.png", ".png")).toBe("photo.png");
  });
});

describe("targetFolder", () => {
  const root = tempDir("sn-save-root");

  it("puts a plain or nested name inside the Save folder", () => {
    expect(targetFolder(root, "קבלות מס")).toBe(join(root, "קבלות מס"));
    expect(targetFolder(root, "Invoices/2025\\Q1")).toBe(join(root, "Invoices", "2025", "Q1"));
  });

  it("cleans each folder name", () => {
    expect(targetFolder(root, "Tax: 2025. ")).toBe(join(root, "Tax_ 2025"));
  });

  it.each(["/etc", "C:\\Users", "C:temp", "\\\\server\\share", "../outside", "a/../../b", "./x", " ", "...", "a/ ./b"])(
    "rejects %j",
    (folder) => {
      expect(() => targetFolder(root, folder)).toThrow(NoteError);
    },
  );
});

describe("openSaveFolder", () => {
  it("never overwrites a file", async () => {
    const root = tempDir("sn-save");
    mkdirSync(join(root, "Invoices"));
    writeFileSync(join(root, "Invoices", "b.jpg"), "old");
    const folder = await openSaveFolder(root, "Invoices/2025");
    expect(folder.path).toBe(join(root, "Invoices", "2025"));
    expect(await folder.write(bytes("one"), "a.pdf")).toBe("a.pdf");
    expect(await folder.write(bytes("two"), "a.pdf")).toBe("a (2).pdf");
    expect(await folder.write(bytes("three"), "a.pdf")).toBe("a (3).pdf");

    const parent = await openSaveFolder(root, "Invoices");
    expect(await parent.write(bytes("new"), "b.jpg")).toBe("b (2).jpg");
    expect(readFileSync(join(root, "Invoices", "b.jpg"), "utf8")).toBe("old");
  });

  it("finds a file with the same bytes, including one saved by the same call", async () => {
    const root = tempDir("sn-save");
    mkdirSync(join(root, "R"));
    writeFileSync(join(root, "R", "old.png"), "same");
    writeFileSync(join(root, "R", "other.png"), "diff");
    const folder = await openSaveFolder(root, "R");
    expect(await folder.find(bytes("same"))).toBe("old.png");
    expect(await folder.find(bytes("nope"))).toBeUndefined();
    await folder.write(bytes("fresh"), "new.png");
    expect(await folder.find(bytes("fresh"))).toBe("new.png");
  });

  it("creates the folder only when it writes", async () => {
    const root = tempDir("sn-save");
    const folder = await openSaveFolder(root, "Later");
    expect(folder.exists).toBe(false);
    expect(await folder.find(bytes("x"))).toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
    await folder.write(bytes("x"), "x.png");
    expect(readdirSync(join(root, "Later"))).toEqual(["x.png"]);
  });
});

describe("subfolders", () => {
  it("lists the Save folder's subfolders, or none when it doesn't exist yet", async () => {
    const root = tempDir("sn-save");
    mkdirSync(join(root, "קבלות מס 2025"));
    writeFileSync(join(root, "loose.pdf"), "x");
    expect(await subfolders(root)).toEqual(["קבלות מס 2025"]);
    expect(await subfolders(join(root, "missing"))).toEqual([]);
  });
});
