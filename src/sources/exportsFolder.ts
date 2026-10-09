import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { NoteError } from "../errors.js";
import { listZipAttachments, readZipAttachment, stripMedia } from "../core/zip.js";
import { mimeTypeFor, type NoteRef, type NoteSource } from "./types.js";

const NOTE_FILE = /\.sdocx$/i;

export function exportsFolderSource(root: string): NoteSource {
  return {
    name: "Exported notes",
    location: root,
    async listNotes() {
      let entries: Dirent[];
      try {
        entries = await readdir(root, { recursive: true, withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        throw new NoteError("Folder not found. Create it, or choose another exported-notes folder.");
      }
      const notes: NoteRef[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !NOTE_FILE.test(entry.name)) continue;
        const path = join(entry.parentPath, entry.name);
        const { size, mtimeMs } = await stat(path);
        notes.push(exportedNote(path, relative(root, path).split(sep).join("/"), `${size}:${mtimeMs}`));
      }
      return { notes, warnings: [] };
    },
  };
}

function exportedNote(path: string, relativePath: string, stamp: string): NoteRef {
  const read = () => readFile(path);
  const slash = relativePath.lastIndexOf("/");
  return {
    id: `file:${relativePath}`,
    folder: slash === -1 ? "" : relativePath.slice(0, slash),
    stamp,
    locked: false,
    indexTitle: basename(relativePath).replace(NOTE_FILE, ""),
    leanBytes: async () => stripMedia(await read()),
    fullBytes: read,
    attachments: async () =>
      listZipAttachments(await read()).map(({ name, size }) => ({ file: name, mimeType: mimeTypeFor(name), size })),
    readAttachment: async (file) => {
      const data = readZipAttachment(await read(), file);
      if (!data) throw new NoteError(`This note has no attachment named “${file}”.`);
      return data;
    },
  };
}
