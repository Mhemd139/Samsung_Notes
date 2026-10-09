import { formatDate as isoDate, formatDateTime, formatPageRanges } from "../../src/core/text";
import { cleanName } from "../../src/core/fileName";
import { buildPdf, type PdfImage } from "../../src/core/pdfWriter";
import { attachmentFileName, noteFileName, pageSheets, uniqueName, type Progress } from "./exporters";
import { audioType, imageType, isPdf, mimeType } from "./fileTypes";
import { blobOf, openNote, type LibraryNote } from "./library";
import { photoToJpeg } from "./raster";
import { displayName } from "./text-view";

// Gemini takes 10 files per prompt, the fewest of the main AI apps. Claude reads at most 100 PDF pages as images,
// and 30 MB is the smallest per-file limit found, so the images stay below both.
export const MAX_FILES = 10;
export const MAX_IMAGES = 100;
const MAX_IMAGE_BYTES = 28 * 1024 * 1024;
const STEM_BYTES = 40;
const IMAGE_MARKER = /\[image: ([^\]\n]+)\]/g;
const TOO_MANY = "(more than one message holds)";

export interface AiPack {
  files: File[];
  // Some pages or files were left out to fit one message; the text file names them.
  incomplete: boolean;
}

export interface TextEntry {
  title: string;
  createdMs: number | null;
  modifiedMs: number | null;
  text: string;
  pages: string[];
  files: string[];
  notSent: string[];
}

interface Sheet {
  page: number;
  image: PdfImage;
}

interface Attached {
  name: string;
  bytes: Uint8Array;
}

interface Photo extends Attached {
  jpeg: PdfImage;
}

interface Gathered {
  note: LibraryNote;
  sheets: Sheet[];
  photos: Photo[];
  documents: Attached[];
  notSent: string[];
  pagesLeftOut: number[];
}

// Separate files read best in every AI app; when they don't fit one message, the images share one PDF.
export function layout(images: number, documents: number): { separate: boolean; documents: number } {
  const separate = 1 + images + documents <= MAX_FILES;
  const used = 1 + (separate ? images : Math.min(images, 1));
  return { separate, documents: Math.min(documents, MAX_FILES - used) };
}

// One text file for every note: typed text as text, plus where each note's page images and files went.
export function packText(entries: TextEntry[]): string {
  const lines = [
    entries.length === 1 ? "A Samsung Note, shared from Inkport." : `${entries.length} Samsung Notes, shared from Inkport.`,
    "Below is each note's typed text. Pages with handwriting or drawings come as images, and attached photos and PDFs as files; each note lists its own.",
  ];
  for (const entry of entries) {
    lines.push("", `=== ${entry.title} ===`);
    if (entry.createdMs !== null) lines.push(`Created: ${formatDateTime(entry.createdMs)}`);
    if (entry.modifiedMs !== null) lines.push(`Modified: ${formatDateTime(entry.modifiedMs)}`);
    if (entry.pages.length) lines.push(`Pages with handwriting or drawings: ${entry.pages.join("; ")}`);
    if (entry.files.length) lines.push(`Attached: ${entry.files.join("; ")}`);
    if (entry.notSent.length) lines.push(`Not sent: ${entry.notSent.join("; ")}`);
    lines.push("", entry.text || "(No typed text.)");
  }
  return `${lines.join("\n")}\n`;
}

export async function buildAiPack(notes: LibraryNote[], onNote: Progress): Promise<AiPack> {
  const gathered = await gather(notes, onNote);
  const images = gathered.reduce((sum, { sheets, photos }) => sum + sheets.length + photos.length, 0);
  const documents = gathered.flatMap(({ documents }) => documents);
  const plan = layout(images, documents.length);
  const base = notes.length === 1 ? noteFileName(notes[0]!) : `Notes ${isoDate(Date.now())}`;
  const used = new Set<string>();
  const textName = uniqueName(base, ".txt", used);
  const pdfName = plan.separate || !images ? "" : uniqueName(`${base} (images)`, ".pdf", used);
  const files: File[] = [];
  const pdfImages: PdfImage[] = [];
  const sentDocuments = new Set(documents.slice(0, plan.documents));

  const entries: TextEntry[] = [];
  for (const { note, sheets, photos, documents, notSent, pagesLeftOut } of gathered) {
    const stem = cleanName(note.title, STEM_BYTES) || "Note";
    const where = new Map<string, string>();
    const pages = [...new Set(sheets.map(({ page }) => page))].map((page) => {
      const parts = sheets.filter((sheet) => sheet.page === page);
      if (plan.separate) {
        const names = parts.map(({ image }, i) => {
          const name = uniqueName(`${stem} p${page}${parts.length > 1 ? `-${i + 1}` : ""}`, ".jpg", used);
          files.push(new File([blobOf(image.jpeg, "image/jpeg")], name, { type: "image/jpeg" }));
          return `"${name}"`;
        });
        return `page ${page} → ${names.join(", ")}`;
      }
      const first = pdfImages.length + 1;
      pdfImages.push(...parts.map(({ image }) => image));
      return `page ${page} → ${pdfPages(first, pdfImages.length, pdfName)}`;
    });
    const attached: string[] = [];
    const skipped = [...notSent];
    for (const photo of photos) {
      if (plan.separate) {
        const name = attachmentFileName(photo.name, used);
        files.push(new File([blobOf(photo.bytes, mimeType(name))], name, { type: mimeType(name) }));
        where.set(photo.name, `"${name}"`);
      } else {
        pdfImages.push(photo.jpeg);
        where.set(photo.name, `${displayName(photo.name)}, ${pdfPages(pdfImages.length, pdfImages.length, pdfName)}`);
      }
      attached.push(where.get(photo.name)!);
    }
    for (const document of documents) {
      if (!sentDocuments.has(document)) {
        skipped.push(`"${displayName(document.name)}" ${TOO_MANY}`);
        continue;
      }
      const name = attachmentFileName(document.name, used);
      files.push(new File([blobOf(document.bytes, "application/pdf")], name, { type: "application/pdf" }));
      attached.push(`"${name}"`);
    }
    if (pagesLeftOut.length) skipped.push(`pages ${formatPageRanges(pagesLeftOut)} ${TOO_MANY}`);
    entries.push({
      title: note.title,
      createdMs: note.createdMs,
      modifiedMs: note.modifiedMs,
      text: note.text.replace(IMAGE_MARKER, (_, name: string) => `[image: ${where.get(name) ?? `${displayName(name)}, not sent`}]`),
      pages,
      files: attached,
      notSent: skipped,
    });
  }
  if (pdfImages.length) {
    const pdf = buildPdf(pdfImages, { title: base });
    files.unshift(new File([blobOf(pdf, "application/pdf")], pdfName, { type: "application/pdf" }));
  }
  files.unshift(new File([packText(entries)], textName, { type: "text/plain" }));
  return { files, incomplete: entries.some(({ notSent }) => notSent.length > 0) };
}

const pdfPages = (first: number, last: number, pdf: string): string =>
  first === last ? `page ${first} of "${pdf}"` : `pages ${first}–${last} of "${pdf}"`;

// Renders only pages with handwriting or drawings: typed pages are already in the text file.
async function gather(notes: LibraryNote[], onNote: Progress): Promise<Gathered[]> {
  let images = 0;
  let bytes = 0;
  let full = false;
  const fits = (count: number, size: number): boolean => {
    full ||= images + count > MAX_IMAGES || bytes + size > MAX_IMAGE_BYTES;
    if (full) return false;
    images += count;
    bytes += size;
    return true;
  };
  const gathered: Gathered[] = [];
  for (const [index, note] of notes.entries()) {
    onNote(index + 1, notes.length);
    const entry: Gathered = { note, sheets: [], photos: [], documents: [], notSent: [], pagesLeftOut: [] };
    const open = await openNote(note);
    try {
      for (const page of note.inkPages) {
        if (full) {
          entry.pagesLeftOut.push(page);
          continue;
        }
        let sheets: PdfImage[];
        try {
          sheets = await pageSheets(note, open, page - 1);
        } catch (error) {
          console.error(`Couldn't draw page ${page} of “${note.title}”`, error);
          entry.notSent.push(`page ${page} (couldn't be drawn)`);
          continue;
        }
        if (fits(sheets.length, sheets.reduce((sum, { jpeg }) => sum + jpeg.length, 0))) {
          entry.sheets.push(...sheets.map((image) => ({ page, image })));
        } else {
          entry.pagesLeftOut.push(page);
        }
      }
      for (const { name } of note.attachments) {
        const label = `"${displayName(name)}"`;
        if (!imageType(name) && !isPdf(name)) {
          entry.notSent.push(`${label} (${audioType(name) ? "a voice recording" : "a file type Inkport doesn't send"})`);
          continue;
        }
        const data = open.attachment(name);
        if (!data) {
          entry.notSent.push(`${label} (couldn't be read)`);
          continue;
        }
        if (isPdf(name)) {
          entry.documents.push({ name, bytes: data });
          continue;
        }
        if (full) {
          entry.notSent.push(`${label} ${TOO_MANY}`);
          continue;
        }
        // Converted up front: in a shared PDF the photo's JPEG, not the original, counts toward the size limit.
        let jpeg: PdfImage;
        try {
          jpeg = await photoToJpeg(blobOf(data, mimeType(name)));
        } catch (error) {
          console.error(`Couldn't read ${name} of “${note.title}”`, error);
          entry.notSent.push(`${label} (couldn't be read)`);
          continue;
        }
        if (fits(1, Math.max(data.length, jpeg.jpeg.length))) entry.photos.push({ name, bytes: data, jpeg });
        else entry.notSent.push(`${label} ${TOO_MANY}`);
      }
    } finally {
      open.close();
    }
    gathered.push(entry);
  }
  return gathered;
}
