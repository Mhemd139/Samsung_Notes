import { copyFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog, friendlyProblem, matchesQuery, MAX_LISTED_PROBLEMS, snippet } from "../src/catalog.js";
import { exportsFolderSource } from "../src/sources/exportsFolder.js";
import type { NoteRef, NoteSource } from "../src/sources/types.js";
import { windowsAppSource } from "../src/sources/windowsApp.js";
import { fixtureBytes, fixturePath, tempDir } from "./helpers.js";
import { makeLocalState } from "./windowsFixture.js";

const ALL = { limit: 50, offset: 0 };
let root: string;
let catalog: Catalog;

beforeEach(async () => {
  root = tempDir("sn-catalog");
  mkdirSync(join(root, "Invoices", "2026"), { recursive: true });
  copyFileSync(fixturePath("03-image-placement.sdocx"), join(root, "Invoices", "2026", "Receipt.sdocx"));
  copyFileSync(fixturePath("01-basic-formatting.sdocx"), join(root, "basic.sdocx"));
  copyFileSync(fixturePath("04-marker4-highlighter.sdocx"), join(root, "marker.sdocx"));
  writeFileSync(join(root, "broken.sdocx"), "this is not a zip");
  catalog = new Catalog(() => ({ sources: [exportsFolderSource(root)], problems: ["setup note"] }));
  await catalog.refresh();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function memoryNote(id: string, leanBytes: () => Promise<Uint8Array>): NoteRef {
  return {
    id,
    folder: "",
    stamp: "v1",
    locked: false,
    indexTitle: id,
    leanBytes,
    fullBytes: leanBytes,
    attachments: async () => [],
    readAttachment: async () => {
      throw new Error("not used");
    },
  };
}

const memorySource = (notes: NoteRef[], warnings: string[] = []): NoteSource => ({
  name: "Memory",
  location: "memory",
  listNotes: async () => ({ notes, warnings }),
});

describe("Catalog.refresh", () => {
  it("builds one entry per note, keeping unreadable ones as problems", () => {
    expect(catalog.list(ALL).total).toBe(4);
    expect(catalog.get("file:basic.sdocx")).toMatchObject({ title: "01-basic-test", pageCount: 5, source: "Exported notes" });
    expect(catalog.get("file:broken.sdocx")?.problem).toMatch(/^Couldn't read this note/);
  });

  it("uses the file name as a title when the note has none", () => {
    expect(catalog.get("file:Invoices/2026/Receipt.sdocx")?.title).toBe("Receipt");
  });

  it("puts table text into the note text", () => {
    expect(catalog.get("file:basic.sdocx")?.text).toContain("| Alpha | Beta |");
  });

  it("picks up an edited note without a restart", async () => {
    const path = join(root, "marker.sdocx");
    copyFileSync(fixturePath("01-basic-formatting.sdocx"), path);
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
    await catalog.refresh();
    expect(catalog.get("file:marker.sdocx")?.title).toBe("01-basic-test");
  });

  it("drops a deleted note", async () => {
    rmSync(join(root, "marker.sdocx"));
    await catalog.refresh();
    expect(catalog.get("file:marker.sdocx")).toBeUndefined();
  });

  it("lists a note added later", async () => {
    copyFileSync(fixturePath("02-shapes-and-dot-calibration.sdocx"), join(root, "shapes.sdocx"));
    await catalog.refresh();
    expect(catalog.get("file:shapes.sdocx")).toBeDefined();
    expect(catalog.list(ALL).total).toBe(5);
  });

  it("shares one run between concurrent refreshes", async () => {
    const first = catalog.refresh();
    expect(catalog.refresh()).toBe(first);
    await first;
    const second = catalog.refresh();
    expect(second).not.toBe(first);
    await second;
  });

  it("keeps the last listing and warns when a source fails", async () => {
    rmSync(root, { recursive: true });
    await catalog.refresh();
    expect(catalog.list(ALL).total).toBe(4);
    expect(catalog.overview().problems.some((p) => p.startsWith("Exported notes"))).toBe(true);
  });

  it("re-resolves the sources on every refresh", async () => {
    let ready = false;
    const late = new Catalog(() =>
      ready ? { sources: [exportsFolderSource(root)], problems: [] } : { sources: [], problems: ["not set up yet"] },
    );
    expect(late.overview()).toMatchObject({ sources: [], problems: [] });
    await late.refresh();
    expect(late.list(ALL).total).toBe(0);
    expect(late.overview().problems).toEqual(["not set up yet"]);
    ready = true;
    await late.refresh();
    expect(late.list(ALL).total).toBe(4);
    expect(late.overview().problems).not.toContain("not set up yet");
    ready = false;
    await late.refresh();
    expect(late.list(ALL).total).toBe(0);
  });

  it("passes on a failing setup and recovers on the next refresh", async () => {
    let broken = true;
    const unstable = new Catalog(() => {
      if (broken) throw new Error("Packages folder unreadable");
      return { sources: [exportsFolderSource(root)], problems: [] };
    });
    await expect(unstable.refresh()).rejects.toThrow("Packages folder unreadable");
    broken = false;
    await unstable.refresh();
    expect(unstable.list(ALL).total).toBe(4);
  });

  it("reads a note once while its stamp is unchanged", async () => {
    let reads = 0;
    const steady = memoryNote("steady", async () => {
      reads++;
      return fixtureBytes("01-basic-formatting.sdocx");
    });
    const cached = new Catalog(() => ({ sources: [memorySource([steady])], problems: [] }));
    await cached.refresh();
    await cached.refresh();
    expect(reads).toBe(1);
  });

  it("tries an unreadable note again even when its files look unchanged", async () => {
    let busy = true;
    const flaky = memoryNote("flaky", async () => {
      if (busy) throw new Error("EBUSY: resource busy or locked");
      return fixtureBytes("01-basic-formatting.sdocx");
    });
    const retrying = new Catalog(() => ({ sources: [memorySource([flaky])], problems: [] }));
    await retrying.refresh();
    expect(retrying.get("flaky")?.problem).toMatch(/EBUSY/);
    busy = false;
    await retrying.refresh();
    expect(retrying.get("flaky")).toMatchObject({ title: "01-basic-test", pageCount: 5 });
    expect(retrying.get("flaky")?.problem).toBeUndefined();
  });
});

describe("Catalog.list", () => {
  it("searches titles and text; every word must match", () => {
    expect(catalog.list({ ...ALL, query: "project ATLAS" }).notes.map((n) => n.id)).toEqual(["file:basic.sdocx"]);
    expect(catalog.list({ ...ALL, query: "alpha zebra" }).total).toBe(0);
  });

  it("adds a snippet around the first word", () => {
    const [hit] = catalog.list({ ...ALL, query: "atlas" }).notes;
    expect(hit?.snippet).toContain("Project Atlas");
  });

  it("filters by folder including subfolders, and by no folder", () => {
    expect(catalog.list({ ...ALL, folder: "invoices" }).total).toBe(1);
    expect(catalog.list({ ...ALL, folder: "Invoices/2026" }).total).toBe(1);
    expect(catalog.list({ ...ALL, folder: "(no folder)" }).total).toBe(3);
  });

  it("filters by attachments", () => {
    expect(catalog.list({ ...ALL, hasAttachments: true }).notes.map((n) => n.id)).toEqual(["file:Invoices/2026/Receipt.sdocx"]);
  });

  it("filters by handwriting or drawings", () => {
    expect(catalog.get("file:marker.sdocx")?.inkPages).toEqual([1]);
    expect(catalog.list({ ...ALL, hasInk: true }).notes.map((n) => n.id)).toEqual(["file:marker.sdocx"]);
  });

  it("filters by modified date", () => {
    const basic = catalog.get("file:basic.sdocx")!;
    const hits = catalog.list({ ...ALL, modifiedAfter: basic.modifiedMs!, modifiedBefore: basic.modifiedMs! + 1 });
    expect(hits.notes.map((n) => n.id)).toEqual(["file:basic.sdocx"]);
  });

  it("sorts newest first and paginates", () => {
    const all = catalog.list(ALL).notes.filter((n) => n.modifiedMs !== null).map((n) => n.modifiedMs!);
    expect([...all].sort((a, b) => b - a)).toEqual(all);
    const page = catalog.list({ limit: 1, offset: 1 });
    expect(page.total).toBe(4);
    expect(page.notes).toHaveLength(1);
  });
});

describe("Catalog.overview", () => {
  it("summarises sources, folders, totals and problems", () => {
    const overview = catalog.overview();
    expect(overview.sources).toEqual([{ name: "Exported notes", location: root, notes: 4 }]);
    expect(overview.folders).toEqual([
      { name: "(no folder)", notes: 3 },
      { name: "Invoices/2026", notes: 1 },
    ]);
    expect(overview.totals).toMatchObject({ notes: 4, withAttachments: 1, withInk: 1, locked: 0, unreadable: 1 });
    expect(overview.problems[0]).toBe("setup note");
    expect(overview.problems.some((p) => p.includes("broken"))).toBe(true);
  });

  it("marks locked Windows notes without parsing or listing them", async () => {
    const localState = await makeLocalState(tempDir("sn-win-cat"), [
      { uuid: "lock", fixture: "03-image-placement.sdocx", locked: true, title: "Bank" },
    ], []);
    const windows = new Catalog(() => ({ sources: [windowsAppSource(localState)], problems: [] }));
    await windows.refresh();
    expect(windows.get("lock")).toMatchObject({ title: "Bank", locked: true, text: "", attachments: [] });
    expect(windows.get("lock")?.problem).toMatch(/locked in Samsung Notes/);
    expect(windows.overview().totals).toMatchObject({ locked: 1, unreadable: 0 });
  });

  it.each([
    [MAX_LISTED_PROBLEMS, []],
    [MAX_LISTED_PROBLEMS + 1, ["…and 1 more warning."]],
    [MAX_LISTED_PROBLEMS + 15, ["…and 15 more warnings."]],
  ])("lists at most the first source warnings and counts the rest (%i warnings)", async (count, closing) => {
    const warnings = Array.from({ length: count }, (_, i) => `warning ${i + 1}`);
    const noisy = new Catalog(() => ({ sources: [memorySource([], warnings)], problems: ["setup note"] }));
    await noisy.refresh();
    expect(noisy.overview().problems).toEqual(["setup note", ...warnings.slice(0, MAX_LISTED_PROBLEMS), ...closing]);
  });

  it("lists at most the first unreadable notes but counts them all", async () => {
    const notes = Array.from({ length: MAX_LISTED_PROBLEMS + 2 }, (_, i) =>
      memoryNote(`bad${i}`, async () => {
        throw new Error("bad bytes");
      }),
    );
    const unreadable = new Catalog(() => ({ sources: [memorySource(notes)], problems: [] }));
    await unreadable.refresh();
    const { problems, totals } = unreadable.overview();
    expect(totals.unreadable).toBe(MAX_LISTED_PROBLEMS + 2);
    expect(problems).toHaveLength(MAX_LISTED_PROBLEMS);
  });
});

describe("matchesQuery", () => {
  it.each([
    ["Rechnung für März", "", "FÜR märz"],
    ["", "re\u{301}sume\u{301}", "résumé"],
    ["", "חשבונית מס 42", "חשבונית"],
    ["", "فاتورة رقم ٤٢", "فاتورة"],
    ["", "Ｉｎｖｏｉｃｅ", "invoice"],
    ["", "\u{FB01}le", "file"],
  ])("finds %s%s by %s", (title, text, query) => {
    expect(matchesQuery(title, text, query)).toBe(true);
  });

  it("requires every word", () => {
    expect(matchesQuery("Invoice ACME", "", "invoice globex")).toBe(false);
  });
});

describe("snippet", () => {
  it("shows the text around the word, with ellipses where it was cut", () => {
    const shown = snippet(`${"a ".repeat(100)}needle${" b".repeat(100)}`, "needle");
    expect(shown).toMatch(/^….*needle.*…$/);
    expect(shown.length).toBeLessThan(200);
  });

  it("starts at the beginning when the word is not in the text", () => {
    expect(snippet("short text", "title")).toBe("short text");
  });

  it("still finds the word after characters that normalise to two", () => {
    expect(snippet(`${"\u{FEFB}".repeat(100)} invoice`, "invoice")).toContain("invoice");
  });
});

describe("friendlyProblem", () => {
  it("explains the parser's size limit", () => {
    expect(friendlyProblem(new Error("text characters limit exceeded: 262080 > 250000"))).toBe(
      "This note is too long to read (262,080 characters; the limit is 250,000).",
    );
  });
});
