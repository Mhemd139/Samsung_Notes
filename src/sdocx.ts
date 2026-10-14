import { readFileSync } from "node:fs";
import { DocumentSession, initSync } from "@twango/sdocx";
import { readNoteDetails, readPageSvg, type NoteDetails, type RenderedPage } from "./core/note.js";

export type { NoteDetails, RenderedPage, TextSpan } from "./core/note.js";

let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  initSync({ module: readFileSync(new URL(import.meta.resolve("@twango/sdocx/sdocx_bg.wasm"))) });
  loaded = true;
}

function withSession<T>(bytes: Uint8Array, use: (session: DocumentSession) => T): T {
  ensureLoaded();
  const session = new DocumentSession(bytes);
  try {
    return use(session);
  } finally {
    session.free();
  }
}

export const inspectNote = (bytes: Uint8Array): NoteDetails => withSession(bytes, (session) => readNoteDetails(session, bytes));

export const renderPageSvg = (bytes: Uint8Array, pageIndex: number): RenderedPage =>
  withSession(bytes, (session) => readPageSvg(session, pageIndex));
