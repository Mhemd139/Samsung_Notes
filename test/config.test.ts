import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_SOURCES_HELP, resolveSaveRoot, resolveSources } from "../src/config.js";
import { tempDir } from "./helpers.js";

function fakeLocalAppData(withNotes: boolean): string {
  const localAppData = tempDir("sn-appdata");
  const localState = join(localAppData, "Packages", "SAMSUNGELECTRONICSCoLtd.SamsungNotes_wyx1vj98g3asy", "LocalState");
  mkdirSync(withNotes ? join(localState, "wdoc") : localState, { recursive: true });
  return localAppData;
}

describe("resolveSources", () => {
  it("finds Samsung Notes for Windows automatically", () => {
    const setup = resolveSources({ LOCALAPPDATA: fakeLocalAppData(true) }, [], "win32");
    expect(setup.sources.map((s) => s.name)).toEqual(["Samsung Notes for Windows"]);
    expect(setup.problems).toEqual([]);
  });

  it("adds an installed app that has not synced yet, and says so when listing", async () => {
    const setup = resolveSources({ LOCALAPPDATA: fakeLocalAppData(false) }, [], "win32");
    expect(setup.sources.map((s) => s.name)).toEqual(["Samsung Notes for Windows"]);
    expect(setup.problems).toEqual([]);
    expect((await setup.sources[0]!.listNotes()).warnings[0]).toMatch(/no notes yet/);
  });

  it("only auto-detects on Windows", () => {
    const setup = resolveSources({ LOCALAPPDATA: fakeLocalAppData(true) }, [], "darwin");
    expect(setup.sources).toEqual([]);
    expect(setup.problems).toEqual([NO_SOURCES_HELP]);
  });

  it("adds an exports folder from --exports or the environment", () => {
    const exportsDir = tempDir("sn exports ü");
    expect(resolveSources({}, ["--exports", exportsDir], "linux").sources[0]?.location).toBe(resolve(exportsDir));
    expect(resolveSources({ SAMSUNG_NOTES_EXPORTS_DIR: exportsDir }, [], "linux").sources[0]?.name).toBe("Exported notes");
  });

  it("ignores an unfilled extension placeholder", () => {
    const setup = resolveSources({ SAMSUNG_NOTES_EXPORTS_DIR: "${user_config.exports_dir}" }, [], "darwin");
    expect(setup.sources).toEqual([]);
    expect(setup.problems).toEqual([NO_SOURCES_HELP]);
  });

  it("expands ~ to the home folder", () => {
    const setup = resolveSources({ SAMSUNG_NOTES_EXPORTS_DIR: "~/no-such-samsung-notes-folder" }, [], "linux");
    expect(setup.sources[0]?.location).toBe(join(homedir(), "no-such-samsung-notes-folder"));
  });

  it("keeps a missing exports folder and explains it when listing", async () => {
    const setup = resolveSources({}, ["--exports", "/definitely/not/here"], "linux");
    expect(setup.sources.map((s) => s.name)).toEqual(["Exported notes"]);
    expect(setup.problems).toEqual([]);
    await expect(setup.sources[0]!.listNotes()).rejects.toThrow("Folder not found");
  });

  it("accepts an explicit app folder override", () => {
    const localState = join(fakeLocalAppData(true), "Packages", "SAMSUNGELECTRONICSCoLtd.SamsungNotes_wyx1vj98g3asy", "LocalState");
    const setup = resolveSources({ SAMSUNG_NOTES_APP_DIR: localState }, [], "darwin");
    expect(setup.sources.map((s) => s.name)).toEqual(["Samsung Notes for Windows"]);
  });
});

describe("resolveSaveRoot", () => {
  it("uses --save-dir first, then the environment", () => {
    const dir = tempDir("sn-save-dir");
    expect(resolveSaveRoot({ SAMSUNG_NOTES_SAVE_DIR: "/elsewhere" }, ["--save-dir", dir], "linux")).toBe(resolve(dir));
    expect(resolveSaveRoot({ SAMSUNG_NOTES_SAVE_DIR: dir }, [], "linux")).toBe(resolve(dir));
  });

  it("defaults to Documents/Samsung Notes, ignoring an unfilled extension placeholder", () => {
    const root = resolveSaveRoot({ SAMSUNG_NOTES_SAVE_DIR: "${user_config.save_dir}" }, [], "darwin");
    expect(root).toBe(join(homedir(), "Documents", "Samsung Notes"));
  });

  it.runIf(process.platform === "win32")("finds Windows' Documents folder", () => {
    const root = resolveSaveRoot({}, [], "win32");
    expect(basename(root)).toBe("Samsung Notes");
    expect(existsSync(dirname(root))).toBe(true);
  });
});
