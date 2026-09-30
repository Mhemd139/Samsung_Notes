import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import initSqlJs from "sql.js";
import { fixtureBytes } from "./helpers.js";

export interface FixtureNote {
  uuid: string;
  fixture: string;
  folderId?: string;
  title?: string;
  deleted?: boolean;
  locked?: boolean;
  indexed?: boolean;
  extraMedia?: Record<string, Uint8Array>;
}

export interface FixtureFolder {
  uuid: string;
  parent?: string;
  name: string;
}

export async function makeLocalState(root: string, notes: FixtureNote[], folders: FixtureFolder[]): Promise<string> {
  const localState = join(root, "LocalState");
  for (const note of notes) {
    const files: Record<string, Uint8Array> = { ...unzipSync(fixtureBytes(note.fixture)) };
    for (const [name, data] of Object.entries(note.extraMedia ?? {})) files[`media/${name}`] = data;
    for (const [name, data] of Object.entries(files)) {
      if (name.endsWith("/")) continue;
      const path = join(localState, "wdoc", note.uuid, ...name.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
    }
  }
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run("CREATE TABLE NoteDB (UUID TEXT, CategoryUUID TEXT, DeletedStatus INTEGER, IsLocked INTEGER, Title TEXT, Extra TEXT)");
  db.run("CREATE TABLE CategoryTreeDB (UUID TEXT, ParentUUID TEXT, DisplayName TEXT, IsDeleted INTEGER)");
  for (const note of notes.filter((n) => n.indexed !== false)) {
    db.run("INSERT INTO NoteDB VALUES (?, ?, ?, ?, ?, 'x')", [
      note.uuid,
      note.folderId ?? "",
      note.deleted ? 2 : 0,
      note.locked ? 1 : 0,
      note.title ?? "",
    ]);
  }
  for (const folder of folders) {
    db.run("INSERT INTO CategoryTreeDB VALUES (?, ?, ?, 0)", [folder.uuid, folder.parent ?? null, folder.name]);
  }
  writeFileSync(join(localState, "Storage.sqlite"), db.export());
  db.close();
  return localState;
}
