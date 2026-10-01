import { readFileSync } from "node:fs";
import * as bindings from "@twango/sdocx/sdocx_bg.js";

export interface TextSpan {
  object_type: string;
  text_index_utf16: number;
  content?: Record<string, unknown>;
}

export interface NoteDetails {
  title: string;
  rawText: string;
  spans: TextSpan[];
  createdMs: number | null;
  modifiedMs: number | null;
  pageCount: number;
  inkPages: number[];
}

interface InspectedPage {
  strokes?: unknown[];
  elements?: unknown[];
}

interface Inspection {
  document: {
    pages: InspectedPage[];
    metadata: {
      note_title?: { text?: string };
      note_text?: { text?: string; object_spans?: TextSpan[] };
      created_ms?: number;
      modified_ms?: number;
    };
  };
  layout: { pages: { source_page_index: number }[] };
}

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

export function inspectNote(bytes: Uint8Array): NoteDetails {
  return withSession(bytes, (session) => {
    const { document, layout } = session.inspection() as Inspection;
    const { metadata } = document;
    return {
      title: metadata.note_title?.text ?? "",
      rawText: metadata.note_text?.text ?? "",
      spans: metadata.note_text?.object_spans ?? [],
      createdMs: metadata.created_ms ?? null,
      modifiedMs: metadata.modified_ms ?? null,
      pageCount: session.page_count,
      inkPages: layout.pages.flatMap(({ source_page_index }, i) => (hasInk(document.pages[source_page_index]) ? [i + 1] : [])),
    };
  });
}

const hasInk = (page: InspectedPage | undefined): boolean =>
  (page?.strokes?.length ?? 0) + (page?.elements?.length ?? 0) > 0;

export function renderPageSvg(bytes: Uint8Array, pageIndex: number): string {
  return withSession(bytes, (session) => session.render_svg(pageIndex, "light"));
}
