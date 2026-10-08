import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { attachmentFileName } from "../src/exporters";
import { sortFiles } from "../src/intake";
import { LANGUAGES, matchLanguage } from "../src/i18n";
import { fixtureBytes } from "../../test/helpers.js";

const locales = import.meta.glob<{ default: Record<string, string> }>("../src/locales/*.ts", { eager: true });
const english = locales["../src/locales/en.ts"]!.default;
const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

describe("translations", () => {
  it("exist for every language in the picker", () => {
    const files = Object.keys(locales).map((path) => path.replace(/^.*\/|\.ts$/g, "")).sort();
    expect(files).toEqual(LANGUAGES.map(([code]) => code).sort());
  });

  it.each(Object.entries(locales))("%s has every key, nothing empty, and the same placeholders", (_, { default: strings }) => {
    expect(Object.keys(strings).sort()).toEqual(Object.keys(english).sort());
    for (const [key, value] of Object.entries(strings)) {
      expect(value.trim(), key).not.toBe("");
      expect(placeholders(value), key).toEqual(placeholders(english[key]!));
    }
  });

  it("matches browser language tags", () => {
    expect(matchLanguage("pt-BR")).toBe("pt");
    expect(matchLanguage("zh-Hant-HK")).toBe("zh-TW");
    expect(matchLanguage("zh-SG")).toBe("zh-CN");
    expect(matchLanguage("iw-IL")).toBe("he");
    expect(matchLanguage("sw")).toBeUndefined();
  });
});

describe("sortFiles", () => {
  const note = (name: string) => new File([fixtureBytes("01-basic-formatting.sdocx") as BlobPart], name);

  it("keeps .sdocx notes and recognises a note shared without its extension", async () => {
    const { notes, problems } = await sortFiles([note("Shopping.sdocx"), note("Shopping")]);
    expect(notes.map((file) => file.name)).toEqual(["Shopping.sdocx", "Shopping.sdocx"]);
    expect(problems).toEqual([]);
  });

  it("unpacks the notes inside a zip and skips macOS clutter", async () => {
    const archive = zipSync({
      "Notes/a.sdocx": fixtureBytes("01-basic-formatting.sdocx"),
      "Notes/b.SDOCX": fixtureBytes("04-marker4-highlighter.sdocx"),
      "__MACOSX/Notes/._a.sdocx": new Uint8Array([1]),
      "Notes/readme.txt": new TextEncoder().encode("hi"),
    });
    const { notes } = await sortFiles([new File([archive as BlobPart], "export.zip")]);
    expect(notes.map((file) => file.name).sort()).toEqual(["a.sdocx", "b.SDOCX"]);
  });

  it("explains files it can't open", async () => {
    const { notes, problems } = await sortFiles([
      new File(["hello"], "notes.txt"),
      new File(["old"], "lecture.snb"),
      new File([zipSync({ "x.txt": new Uint8Array([1]) }) as BlobPart], "photos.zip"),
    ]);
    expect(notes).toEqual([]);
    expect(problems).toEqual([
      { name: "notes.txt", reason: "notNote" },
      { name: "lecture.snb", reason: "oldFormat" },
      { name: "photos.zip", reason: "notNote" },
    ]);
  });
});

describe("attachmentFileName", () => {
  it("drops the media number, keeps the extension when cutting, and numbers duplicates", () => {
    const used = new Set<string>();
    const longHebrew = `${"חשבונית מהאינסטלטור ".repeat(5)}.pdf`;
    expect(attachmentFileName("0@invoice from the plumber.PDF", used)).toBe("invoice from the plumber.pdf");
    expect(attachmentFileName(longHebrew, used)).toMatch(/^חשבונית.*\.pdf$/);
    expect(new TextEncoder().encode(attachmentFileName(longHebrew, new Set())).length).toBeLessThanOrEqual(84);
    expect(attachmentFileName("1@scan.jpg", used)).toBe("scan.jpg");
    expect(attachmentFileName("2@scan.jpg", used)).toBe("scan (2).jpg");
    expect(attachmentFileName("3@Scan.JPG", used)).toBe("Scan (3).jpg");
    expect(attachmentFileName("4@recording", used)).toBe("recording");
    expect(attachmentFileName("5@a/b:c?.png", used)).toBe("a_b_c_.png");
  });
});
