import { readNoteDetails, readPageSvg, type NoteSession } from "../../src/core/note";
import { sheetBands, viewBox, withBand, cropToInk } from "../../src/core/svg";
import { buildNoteText, noteTitle } from "../../src/core/text";
import { listZipAttachments, readZipAttachment } from "../../src/core/zip";
import { loadParser, openSession } from "./parser";
import { svgToJpeg } from "./raster";

const THUMBNAIL_WIDTH = 360;

export interface Attachment {
  name: string;
  size: number;
}

export interface LibraryNote {
  id: number;
  file: File;
  title: string;
  heading?: string;
  text: string;
  createdMs: number | null;
  modifiedMs: number | null;
  pageCount: number;
  inkPages: number[];
  attachments: Attachment[];
  thumbnail?: string;
  searchText: string;
}

export interface OpenNote {
  pageCount: number;
  page(index: number): string;
  attachment(name: string): Uint8Array | undefined;
  close(): void;
}

let nextId = 1;

export async function readNote(file: File): Promise<LibraryNote> {
  await loadParser();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const session = openSession(bytes);
  try {
    const details = readNoteDetails(session, bytes);
    const attachments = listZipAttachments(bytes);
    const text = buildNoteText(details.rawText, details.spans, attachments.map(({ name }) => name));
    const title = noteTitle({ title: details.title, indexTitle: file.name.replace(/\.sdocx$/i, ""), text, modifiedMs: details.modifiedMs });
    return {
      id: nextId++,
      file,
      title,
      heading: details.title.trim() || undefined,
      text,
      createdMs: details.createdMs,
      modifiedMs: details.modifiedMs,
      pageCount: details.pageCount,
      inkPages: details.inkPages,
      attachments,
      thumbnail: details.pageCount ? await thumbnailOf(session.render_svg(0, "light")) : undefined,
      searchText: `${title}\n${text}`.toLocaleLowerCase(),
    };
  } finally {
    session.free();
  }
}

// Keeps one parsed note open while it is on screen; inspection() is costly, so it runs once.
export async function openNote(note: LibraryNote): Promise<OpenNote> {
  await loadParser();
  const bytes = new Uint8Array(await note.file.arrayBuffer());
  const raw = openSession(bytes);
  let inspection: unknown;
  const session: NoteSession = {
    page_count: raw.page_count,
    inspection: () => (inspection ??= raw.inspection()),
    render_svg: (index, mode) => raw.render_svg(index, mode),
  };
  return {
    pageCount: raw.page_count,
    page: (index) => {
      const { svg, inkBottom } = readPageSvg(session, index);
      return cropToInk(svg, inkBottom);
    },
    attachment: (name) => readZipAttachment(bytes, name),
    close: () => raw.free(),
  };
}

export const svgUrl = (svg: string): string => URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));

// TypeScript's DOM types want ArrayBuffer-backed bytes; ours are, so this is the one place that says so.
export const blobOf = (bytes: Uint8Array, type: string): Blob => new Blob([bytes as BlobPart], { type });

// A small JPEG of the first sheet: a whole-page SVG per card would hold megabytes of strokes for every note.
async function thumbnailOf(svg: string): Promise<string | undefined> {
  const box = viewBox(svg);
  if (!box) return undefined;
  const [first] = sheetBands(box.width, box.height);
  try {
    const { jpeg } = await svgToJpeg(withBand(svg, box, box.y + first!.top, first!.height), box.width, first!.height, THUMBNAIL_WIDTH);
    return URL.createObjectURL(blobOf(jpeg, "image/jpeg"));
  } catch (error) {
    console.error("Couldn't draw a thumbnail; the card shows none", error);
    return undefined;
  }
}
