import { Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { cleanName } from "../../src/fileName";
import { noteMarkdown } from "../../src/markdown";
import { buildPdf, type PdfImage } from "../../src/pdfWriter";
import { sheetBands, viewBox, withBand } from "../../src/svg";
import { blobOf, openNote, type LibraryNote, type OpenNote } from "./library";
import { svgToJpeg } from "./raster";
import { displayName } from "./text-view";

// Short enough that "Downloads\export\<note>\<note>.pdf" stays under Windows' 260-character path limit when unzipped.
const NAME_BYTES = 80;
const EXTENSION_BYTES = 12;
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
    images.push(...(await pageSheets(note, open, index)));
  }
  return buildPdf(images, { title: note.title, createdMs: note.createdMs, modifiedMs: note.modifiedMs });
}

export async function pageSheets(note: LibraryNote, open: OpenNote, index: number): Promise<PdfImage[]> {
  const svg = open.page(index);
  const box = viewBox(svg);
  if (!box) throw new Error(`Page ${index + 1} of “${note.title}” has no size.`);
  const sheets: PdfImage[] = [];
  for (const band of sheetBands(box.width, box.height)) {
    sheets.push(await svgToJpeg(withBand(svg, box, box.y + band.top, band.height), box.width, band.height));
  }
  return sheets;
}

// One folder per note: Markdown with the note's dates, the pages as PDF, and the attached files, all stamped with the note's date.
// A note that fails is left out and named, so one damaged file never costs the whole export.
export async function exportZip(notes: LibraryNote[], onNote: Progress): Promise<{ blob: Blob; failed: string[] }> {
  const chunks: Uint8Array[] = [];
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  const folders = new Set<string>();
  const failed: string[] = [];
  for (const [index, note] of notes.entries()) {
    onNote(index + 1, notes.length);
    try {
      addNote(zip, note, await noteEntries(note, uniqueName(noteFileName(note), "", folders)));
    } catch (error) {
      console.error(`Couldn't export “${note.title}”`, error);
      failed.push(note.title);
    }
  }
  zip.end();
  return { blob: new Blob(chunks as BlobPart[], { type: "application/zip" }), failed };
}

interface Entry {
  path: string;
  data: Uint8Array;
  compress?: boolean;
}

// Builds every file of one note before any is added, so a failure leaves no half-written folder in the ZIP.
async function noteEntries(note: LibraryNote, folder: string): Promise<Entry[]> {
  const open = await openNote(note);
  try {
    const names = new Set<string>();
    const files = note.attachments.map(({ name }) => ({ name, path: `${FILES_DIR}/${attachmentFileName(name, names)}` }));
    const pdf = open.pageCount ? `${folder}.pdf` : undefined;
    const entries: Entry[] = [
      { path: `${folder}/${folder}.md`, data: encoder.encode(noteMarkdown({ ...note, pdf, files })), compress: true },
      ...(pdf ? [{ path: `${folder}/${pdf}`, data: await pdfOf(note, open) }] : []),
    ];
    for (const file of files) {
      const data = open.attachment(file.name);
      if (data) entries.push({ path: `${folder}/${file.path}`, data });
    }
    return entries;
  } finally {
    open.close();
  }
}

function addNote(zip: Zip, note: LibraryNote, entries: Entry[]): void {
  const mtime = new Date(Math.max(note.modifiedMs ?? note.createdMs ?? Date.now(), EARLIEST_ZIP_DATE));
  for (const { path, data, compress } of entries) {
    const entry = compress ? new ZipDeflate(path, { level: 6 }) : new ZipPassThrough(path);
    entry.mtime = mtime;
    zip.add(entry);
    entry.push(data, true);
  }
}

export const attachmentFileName = (name: string, used: Set<string>): string => uniqueName(...splitName(displayName(name)), used);

// Cuts the name, never the extension: "invoice.pdf" must stay a PDF however long the name is.
function splitName(name: string): [stem: string, extension: string] {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? cleanName(name.slice(dot + 1), EXTENSION_BYTES).toLowerCase() : "";
  const stem = cleanName(dot > 0 ? name.slice(0, dot) : name, NAME_BYTES) || "file";
  return [stem, extension ? `.${extension}` : ""];
}

export function uniqueName(stem: string, extension: string, used: Set<string>): string {
  let candidate = stem + extension;
  for (let copy = 2; used.has(candidate.toLocaleLowerCase()); copy++) candidate = `${stem} (${copy})${extension}`;
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

export const canShareFiles = (): boolean =>
  typeof navigator.canShare === "function" && navigator.canShare({ files: [new File(["%PDF"], "probe.pdf", { type: "application/pdf" })] });
