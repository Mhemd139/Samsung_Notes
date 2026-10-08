import { readFileSync } from "node:fs";
import * as bindings from "@twango/sdocx/sdocx_bg.js";
import { readNoteDetails, readPageSvg, type NoteDetails, type RenderedPage } from "./note.js";

export type { NoteDetails, RenderedPage, TextSpan } from "./note.js";

let loaded = false;

function ensureLoaded(): void {
  if (loaded) return;
  const wasm = readFileSync(new URL(import.meta.resolve("@twango/sdocx/sdocx_bg.wasm")));
  const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), {
    "./sdocx_bg.js": bindings as unknown as WebAssembly.ModuleImports,
  });
  bindings.__wbg_set_wasm(instance.exports);
  (instance.exports.__wbindgen_start as (() => void) | undefined)?.();
  loaded = true;
}

function withSession<T>(bytes: Uint8Array, use: (session: bindings.DocumentSession) => T): T {
  ensureLoaded();
  const session = new bindings.DocumentSession(bytes);
  try {
    return use(session);
  } finally {
    session.free();
  }
}

export const inspectNote = (bytes: Uint8Array): NoteDetails => withSession(bytes, (session) => readNoteDetails(session, bytes));

export const renderPageSvg = (bytes: Uint8Array, pageIndex: number): RenderedPage =>
  withSession(bytes, (session) => readPageSvg(session, pageIndex));
