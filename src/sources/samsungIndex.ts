import { readFile } from "node:fs/promises";
import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";

export interface IndexedNote {
  folder: string;
  deleted: boolean;
  locked: boolean;
  title: string;
}

export type SamsungIndex = Map<string, IndexedNote>;

type Row = Record<string, unknown>;

let sqlJs: Promise<SqlJsStatic> | undefined;

export async function readSamsungIndex(dbPath: string): Promise<SamsungIndex> {
  const SQL = await (sqlJs ??= initSqlJs());
  const db = new SQL.Database(await readFile(dbPath));
  try {
    const folders = folderPaths(queryRows(db, "SELECT UUID, ParentUUID, DisplayName FROM CategoryTreeDB"));
    const notes: SamsungIndex = new Map();
    for (const row of queryRows(db, "SELECT UUID, CategoryUUID, DeletedStatus, IsLocked, Title FROM NoteDB")) {
      notes.set(String(row.UUID), {
        folder: folders.get(String(row.CategoryUUID ?? "")) ?? "",
        deleted: Number(row.DeletedStatus ?? 0) !== 0,
        locked: Number(row.IsLocked ?? 0) !== 0,
        title: String(row.Title ?? ""),
      });
    }
    return notes;
  } finally {
    db.close();
  }
}

function queryRows(db: Database, sql: string): Row[] {
  const statement = db.prepare(sql);
  const rows: Row[] = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function folderPaths(rows: Row[]): Map<string, string> {
  const byId = new Map(rows.map((row) => [String(row.UUID), row]));
  const containers = new Set(
    rows.filter((row) => !row.ParentUUID).map((row) => String(row.UUID)).filter((id) =>
      rows.some((row) => String(row.ParentUUID ?? "") === id),
    ),
  );
  const pathOf = (id: string, seen: Set<string>): string => {
    const row = byId.get(id);
    if (!row || containers.has(id) || seen.has(id)) return "";
    seen.add(id);
    const name = String(row.DisplayName ?? "").trim() || "Unnamed folder";
    const parent = row.ParentUUID ? pathOf(String(row.ParentUUID), seen) : "";
    return parent ? `${parent}/${name}` : name;
  };
  return new Map([...byId.keys()].map((id) => [id, pathOf(id, new Set())]));
}
