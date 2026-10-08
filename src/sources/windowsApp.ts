import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { zipSync } from "fflate";
import { describeError, NoteError } from "../errors.js";
import { isAttachmentEntry, isMediaEntry } from "../zip.js";
import { readSamsungIndex, type IndexedNote, type SamsungIndex } from "./samsungIndex.js";
import { mimeTypeFor, type AttachmentInfo, type NoteRef, type NoteSource } from "./types.js";

const NO_NOTES_YET =
  "Samsung Notes for Windows has no notes yet. Open Samsung Notes, sign in and let it sync; the notes appear on the next request.";

export function windowsAppSource(localState: string): NoteSource {
  const wdoc = join(localState, "wdoc");
  return {
    name: "Samsung Notes for Windows",
    location: localState,
    async listNotes() {
      let entries: Dirent[];
      try {
        entries = await readdir(wdoc, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return { notes: [], warnings: [NO_NOTES_YET] };
      }
      const warnings: string[] = [];
      let index: SamsungIndex = new Map();
      try {
        index = await readSamsungIndex(join(localState, "Storage.sqlite"));
      } catch (err) {
        warnings.push(
          `Couldn't read Samsung Notes' index (${describeError(err)}). Folder names are missing and notes in the recycle bin may appear.`,
        );
      }
      const notes: NoteRef[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const indexed = index.get(entry.name);
        if (indexed?.deleted) continue;
        const dir = join(wdoc, entry.name);
        let stamp: string;
        try {
          stamp = JSON.stringify([await folderStamp(dir), indexed?.folder, indexed?.locked, indexed?.title]);
        } catch (err) {
          warnings.push(
            `Couldn't read the note “${indexed?.title || entry.name}” (${describeError(err)}). It is skipped for now and tried again on the next request.`,
          );
          continue;
        }
        notes.push(windowsNote(entry.name, dir, stamp, indexed));
      }
      return { notes, warnings };
    },
  };
}

export async function zipNoteFolder(dir: string, includeMedia: boolean): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(dir, path).split(sep).join("/");
    if (includeMedia || !isMediaEntry(name)) entries[name] = await readFile(path);
  }
  return zipSync(entries, { level: 0 });
}

async function folderStamp(dir: string): Promise<string> {
  const files = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile());
  const times = await Promise.all(files.map(async (entry) => (await stat(join(dir, entry.name))).mtimeMs));
  return `${files.length}:${Math.max(0, ...times)}`;
}

async function listAttachments(mediaDir: string): Promise<AttachmentInfo[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(mediaDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files = entries.filter((entry) => entry.isFile() && isAttachmentEntry(`media/${entry.name}`));
  return Promise.all(
    files.map(async (entry) => ({
      file: entry.name,
      mimeType: mimeTypeFor(entry.name),
      size: (await stat(join(mediaDir, entry.name))).size,
    })),
  );
}

function windowsNote(uuid: string, dir: string, stamp: string, indexed: IndexedNote | undefined): NoteRef {
  const mediaDir = join(dir, "media");
  return {
    id: uuid,
    folder: indexed?.folder ?? "",
    stamp,
    locked: indexed?.locked ?? false,
    indexTitle: indexed?.title || undefined,
    leanBytes: () => zipNoteFolder(dir, false),
    fullBytes: () => zipNoteFolder(dir, true),
    attachments: () => listAttachments(mediaDir),
    readAttachment: async (file) => {
      if (!(await listAttachments(mediaDir)).some((attachment) => attachment.file === file)) {
        throw new NoteError(`This note has no attachment named “${file}”.`);
      }
      return readFile(join(mediaDir, file));
    },
  };
}
