import { unzipSync } from "fflate";

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

export interface RenderedPage {
  svg: string;
  inkBottom?: number;
}

// The parts of the parser's DocumentSession used here, so Node and the browser can load the WASM their own way.
export interface NoteSession {
  inspection(): unknown;
  render_svg(pageIndex: number, colorMode: "light"): string;
  readonly page_count: number;
}

interface InspectedPage {
  strokes?: unknown[];
  elements?: unknown[];
  content_bbox?: { y_max: number };
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

// A real .sdocx carries its dates in a tail appended after the zip. Re-zipping drops that tail, and
// the parser then returns microsecond values labelled as ms. end_tag.bin holds both dates in
// microseconds (undocumented layout, checked on the public fixtures); anything unexpected gives null.
const END_TAG = "end_tag.bin";
const END_TAG_MODIFIED_US = 8;
const END_TAG_CREATED_US = 46;
const U64_BYTES = 8;
const EARLIEST_DATE_MS = Date.UTC(2000, 0, 1);
const ONE_DAY_MS = 86_400_000;

function endTagDates(bytes: Uint8Array): { createdMs: number; modifiedMs: number } | undefined {
  const tag = unzipSync(bytes, { filter: (file) => file.name === END_TAG })[END_TAG];
  if (!tag || tag.length < END_TAG_CREATED_US + U64_BYTES) return undefined;
  const view = new DataView(tag.buffer, tag.byteOffset, tag.byteLength);
  const ms = (at: number) => Math.round(Number(view.getBigUint64(at, true)) / 1000);
  return { createdMs: ms(END_TAG_CREATED_US), modifiedMs: ms(END_TAG_MODIFIED_US) };
}

const plausibleDate = (ms: number | undefined): number | null =>
  ms !== undefined && ms >= EARLIEST_DATE_MS && ms <= Date.now() + ONE_DAY_MS ? ms : null;

export function readNoteDetails(session: NoteSession, bytes: Uint8Array): NoteDetails {
  const { document, layout } = session.inspection() as Inspection;
  const { metadata } = document;
  const dates = endTagDates(bytes);
  return {
    title: metadata.note_title?.text ?? "",
    rawText: metadata.note_text?.text ?? "",
    spans: metadata.note_text?.object_spans ?? [],
    createdMs: plausibleDate(dates ? dates.createdMs : metadata.created_ms),
    modifiedMs: plausibleDate(dates ? dates.modifiedMs : metadata.modified_ms),
    pageCount: session.page_count,
    inkPages: layout.pages.flatMap(({ source_page_index }, i) => (hasInk(document.pages[source_page_index]) ? [i + 1] : [])),
  };
}

const hasInk = (page: InspectedPage | undefined): boolean =>
  (page?.strokes?.length ?? 0) + (page?.elements?.length ?? 0) > 0;

// content_bbox bounds strokes and shapes only, so it marks the page's real end only when the note has no typed text or objects.
export function readPageSvg(session: NoteSession, pageIndex: number): RenderedPage {
  const svg = session.render_svg(pageIndex, "light");
  const { document, layout } = session.inspection() as Inspection;
  const { note_text } = document.metadata;
  if (note_text?.text?.trim() || note_text?.object_spans?.length) return { svg };
  return { svg, inkBottom: document.pages[layout.pages[pageIndex]!.source_page_index]?.content_bbox?.y_max };
}
