import { unzipSync } from "fflate";
import { viewBox } from "./svg.js";
import { readZipAttachment } from "./zip.js";

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
  paper: PaperPlacement[];
}

// A page of a PDF the note was made from, and where it lies on the note's page.
export interface PaperPlacement {
  file: string;
  pageIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

// The parts of the parser's DocumentSession used here, so Node and the browser can load the WASM their own way.
export interface NoteSession {
  inspection(): unknown;
  render_svg(pageIndex: number, colorMode: "light"): string;
  readonly page_count: number;
}

// Saved as left, top, right, bottom; older notes store floats, newer ones integers.
interface PdfPaper {
  media_id: number;
  page_index: number;
  rectangle: Record<string, [number, number, number, number]>;
}

interface InspectedPage {
  objects?: unknown[];
  content_bbox?: { y_max: number };
  background?: { pdf_paper?: PdfPaper[] };
}

interface Inspection {
  document: {
    pages: InspectedPage[];
    metadata: {
      note_title?: { text?: string };
      note_text?: { text?: string; object_spans?: TextSpan[] };
      created_ms?: number;
      modified_ms?: number;
      media_manifest?: { entries: { bind_id: number; file_name: string }[] };
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

const hasInk = (page: InspectedPage | undefined): boolean => (page?.objects?.length ?? 0) > 0;

// content_bbox bounds strokes and shapes only, so it marks the page's real end only when the note has no typed text,
// objects or PDF pages.
export function readPageSvg(session: NoteSession, pageIndex: number): RenderedPage {
  const svg = session.render_svg(pageIndex, "light");
  const { document, layout } = session.inspection() as Inspection;
  const { note_text, media_manifest } = document.metadata;
  const page = document.pages[layout.pages[pageIndex]!.source_page_index];
  const paper = (page?.background?.pdf_paper ?? []).map((record) => placePaper(record, media_manifest?.entries ?? []));
  if (paper.length || note_text?.text?.trim() || note_text?.object_spans?.length) return { svg, paper };
  return { svg, inkBottom: page?.content_bbox?.y_max, paper };
}

// Draws one PDF page as an image URL (a data: URL) the page's SVG can embed, pixelWidth pixels wide.
export type PdfPageRenderer = (pdf: Uint8Array, pageIndex: number, pixelWidth: number) => Promise<string>;

// The parser leaves out the PDF pages a note was made from, so they're drawn here: over the paper, under the ink.
export async function drawPaper(page: RenderedPage, sdocx: Uint8Array, pixelWidth: number, render: PdfPageRenderer): Promise<string> {
  if (!page.paper.length) return page.svg;
  const scale = pixelWidth / (viewBox(page.svg)?.width ?? pixelWidth);
  let images = "";
  for (const { file, pageIndex, x, y, width, height } of page.paper) {
    const pdf = readZipAttachment(sdocx, file);
    if (!pdf) throw new Error(`The note's PDF “${file}” is missing.`);
    const href = await render(pdf, pageIndex, Math.round(width * scale));
    images += `<image x="${x}" y="${y}" width="${width}" height="${height}" preserveAspectRatio="none" href="${href}"/>`;
  }
  const svg = page.svg.replace(PAPER, (paper) => paper + images);
  if (svg === page.svg) throw new Error("The page has no paper to draw its PDF on.");
  return svg;
}

const PAPER = /^\s*<svg\b[^>]*>\s*<rect\b[^>]*\/>/;

function placePaper(record: PdfPaper, media: { bind_id: number; file_name: string }[]): PaperPlacement {
  const file = media.find((entry) => entry.bind_id === record.media_id)?.file_name;
  if (!file) throw new Error(`The note's PDF (media ${record.media_id}) is missing from its file list.`);
  const [left, top, right, bottom] = Object.values(record.rectangle)[0]!;
  return { file, pageIndex: record.page_index, x: left, y: top, width: right - left, height: bottom - top };
}
