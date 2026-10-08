import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { cleanName } from "../../src/fileName";
import { noteMarkdown } from "../../src/markdown";
import { buildPdf, type PdfImage } from "../../src/pdfWriter";
import { sheetBands, viewBox, withBand } from "../../src/svg";
import { openNote, type LibraryNote, type OpenNote } from "./library";
import { svgToJpeg } from "./raster";

// Short enough that "Downloads\export\<note>\<note>.pdf" stays under Windows' 260-character path limit when unzipped.
const NAME_BYTES = 80;
const FILES_DIR = "files";
const EARLIEST_ZIP_DATE = Date.UTC(1980, 0, 2);
const encoder = new TextEncoder();

export type Progress = (done: number, total: number) => void;

export const noteFileName = (note: LibraryNote): string => cleanName(note.title, NAME_BYTES) || "Note";

export async function notePdf(note: LibraryNote, onPage?: Progress): Promise<Uint8Array> {
  const open = await openNote(note);
  try {
    return await pdfOf(note, open, onPage);
  } finally {
    open.close();
  }
}

async function pdfOf(note: LibraryNote, open: OpenNote, onPage?: Progress): Promise<Uint8Array> {
  const images: PdfImage[] = [];
  for (let index = 0; index < open.pageCount; index++) {
    onPage?.(index + 1, open.pageCount);
    const svg = open.page(index);
    const box = viewBox(svg);
    if (!box) throw new Error(`Page ${index + 1} of “${note.title}” has no size.`);
    for (const band of sheetBands(box.width, box.height)) {
      images.push(await svgToJpeg(withBand(svg, box, box.y + band.top, band.height), box.width, band.height));
    }
  }
  return buildPdf(images, { title: note.title, createdMs: note.createdMs, modifiedMs: note.modifiedMs });
}

// One folder per note: Markdown with the note's dates, the pages as PDF, and the attached files, all stamped with the note's date.
export async function exportZip(notes: LibraryNote[], onNote: Progress): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  const used = new Set<string>();
  for (const [index, note] of notes.entries()) {
    onNote(index + 1, notes.length);
    const folder = uniqueName(noteFileName(note), used);
    const date = new Date(Math.max(note.modifiedMs ?? note.createdMs ?? Date.now(), EARLIEST_ZIP_DATE));
    const open = await openNote(note);
    try {
      const files = note.attachments.map(({ name }) => ({ name, path: `${FILES_DIR}/${cleanName(name, NAME_BYTES) || "file"}` }));
      const markdown = noteMarkdown({ ...note, pdf: `${folder}.pdf`, files });
      add(zip, `${folder}/${folder}.md`, encoder.encode(markdown), date, true);
      add(zip, `${folder}/${folder}.pdf`, await pdfOf(note, open), date);
      for (const file of files) {
        const bytes = open.attachment(file.name);
        if (bytes) add(zip, `${folder}/${file.path}`, bytes, date);
      }
    } finally {
      open.close();
    }
  }
  zip.end();
  return new Blob(chunks as BlobPart[], { type: "application/zip" });
}

function add(zip: Zip, path: string, data: Uint8Array, mtime: Date, compress = false): void {
  const entry = compress ? new ZipDeflate(path, { level: 6 }) : new ZipPassThrough(path);
  entry.mtime = mtime;
  zip.add(entry);
  entry.push(data, true);
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  for (let copy = 2; used.has(candidate.toLocaleLowerCase()); copy++) candidate = `${name} (${copy})`;
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const pdfFile = (pdf: Uint8Array, note: LibraryNote): File =>
  new File([pdf as BlobPart], `${noteFileName(note)}.pdf`, { type: "application/pdf" });

export const canShareFiles = (): boolean =>
  typeof navigator.canShare === "function" && navigator.canShare({ files: [new File(["%PDF"], "probe.pdf", { type: "application/pdf" })] });
