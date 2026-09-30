import { stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { windowsAppSource } from "../src/sources/windowsApp.js";
import { tempDir } from "./helpers.js";
import { makeLocalState } from "./windowsFixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const { stat: realStat } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");

let localState: string;

beforeEach(async () => {
  vi.mocked(stat).mockImplementation(realStat);
  localState = await makeLocalState(
    tempDir("sn-win-unreadable"),
    [
      { uuid: "aaaa", fixture: "01-basic-formatting.sdocx", title: "Receipt March" },
      { uuid: "bbbb", fixture: "01-basic-formatting.sdocx" },
      { uuid: "cccc", fixture: "01-basic-formatting.sdocx" },
    ],
    [],
  );
});

function makeUnreadable(uuid: string): void {
  const dir = join(localState, "wdoc", uuid);
  vi.mocked(stat).mockImplementation(async (path, options) => {
    if (String(path).startsWith(dir)) throw new Error("EPERM: operation not permitted");
    return realStat(path, options);
  });
}

describe("windowsAppSource with an unreadable note folder", () => {
  it("skips that note with a warning and lists the others", async () => {
    makeUnreadable("aaaa");
    const { notes, warnings } = await windowsAppSource(localState).listNotes();
    expect(notes.map((n) => n.id).sort()).toEqual(["bbbb", "cccc"]);
    expect(warnings).toEqual([
      "Couldn't read the note “Receipt March” (EPERM: operation not permitted). It is skipped for now and tried again on the next request.",
    ]);
  });

  it("names an untitled note by its folder", async () => {
    makeUnreadable("bbbb");
    const { notes, warnings } = await windowsAppSource(localState).listNotes();
    expect(notes.map((n) => n.id).sort()).toEqual(["aaaa", "cccc"]);
    expect(warnings).toEqual([expect.stringContaining("Couldn't read the note “bbbb” (EPERM: operation not permitted).")]);
  });
});
