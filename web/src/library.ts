import { readNoteDetails, readPageSvg, type NoteSession } from "../../src/note";
import { sheetBands, viewBox, withBand, cropToInk } from "../../src/svg";
import { buildNoteText, noteTitle } from "../../src/text";
import { listZipAttachments, readZipAttachment } from "../../src/zip";
import { loadParser, openSession } from "./parser";

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
      thumbnail: details.pageCount ? svgUrl(firstSheet(session.render_svg(0, "light"))) : undefined,
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

function firstSheet(svg: string): string {
  const box = viewBox(svg);
  if (!box) return svg;
  const [first] = sheetBands(box.width, box.height);
  return withBand(svg, box, box.y + first!.top, first!.height);
}
