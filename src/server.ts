import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { NO_FOLDER, type Catalog, type ListResult, type NoteEntry, type Overview } from "./catalog.js";
import { describeError, NoteError } from "./errors.js";
import { imageForClaude, imageParts, MAX_IMAGE_BYTES, renderPage } from "./images.js";
import { PDF_BUDGET_BYTES, readPdf } from "./pdf.js";
import { fileNameFor, openSaveFolder, subfolders } from "./save.js";
import { renderPageSvg } from "./sdocx.js";
import type { AttachmentInfo } from "./sources/types.js";
import { cropToInk, pageParts } from "./svg.js";
import { cutText, formatDate, formatDateTime, formatPageRanges } from "./text.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const TOOL_NAMES = ["get_attachment", "get_page_image", "list_notes", "notes_overview", "read_note", "save_attachments"] as const;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_PDF_PAGES = 5;
const MAX_PDF_PAGES = 20;
const MAX_TEXT_CHARS = 250_000;
const MAX_SAVE_ITEMS = 50;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NO_NOTES_HINT = "No notes are available yet. Call notes_overview: it says where notes come from and how to set them up.";
const NO_MATCH_HINT =
  "No notes matched. Handwriting isn't searchable: try a folder, dates or has_handwriting=true instead, then open pages with get_page_image.";

const INSTRUCTIONS = [
  "Access to the user's Samsung Notes: typed text, tables, handwritten pages, and attached photos and PDFs. Nothing here can change a note; save_attachments only saves copies of attachments into the user's Save folder, when the user asks.",
  "",
  "Which tool, when:",
  "- Start of a task, or \"what's in my notes?\": notes_overview shows sources, folders, totals and problems.",
  "- Find notes by words, folder, dates, attachments or handwriting: list_notes. Words match titles and typed text only, never handwriting.",
  "- Read a note: read_note gives its typed text, tables and attachments, and names the pages that hold handwriting or drawings.",
  "- Handwriting, sketches or page layout: get_page_image, one page at a time. Very tall pages come in overlapping parts; the reply says how to get the next.",
  "- Invoices, receipts, photos, scans and PDFs: list_notes with has_attachments=true (add a folder or dates to narrow it), then get_attachment for each file that read_note or list_notes names. Scanned PDF pages come back as images. Very tall photos and pages (long receipts, scroll screenshots) come in overlapping parts; the reply says how to get the next.",
  "- Dates: a note's date is its last edit, not the date printed on an invoice or receipt. For invoice dates, amounts or vendors, read the files with get_attachment; list_notes words don't search inside photos or PDFs.",
  "- Only need a PDF's date, vendor or total (e.g. to filter by month or name files): call get_attachment with pages=[1] first, and open more pages only if what you need isn't there.",
  "- Overlapping parts: each part begins with the last lines of the one before. Read every part before taking figures, and count a repeated line once.",
  "- Go through everything (e.g. \"put all my invoices in a spreadsheet\"): repeat list_notes with next_offset until it stops returning one, open every note and file you need, then build the table, summary or file yourself.",
  "- Save or organise attachments into a folder (e.g. \"put my invoices in a folder\"), only when the user asks: first call save_attachments with check_only=true for the files you plan to save, skip the ones already there (a job continued from an earlier chat), and reuse a folder it lists. Then open each remaining file with get_attachment and save as you go, up to 50 files per call. Name files \"YYYY-MM-DD Vendor Total Currency\" (e.g. \"2025-03-14 Shufersal 245.90 ILS\") from the date, vendor and total printed on the document. Write \"unknown\" for any part you can't read; never guess.",
  "- Before the first save, tell the user their app may ask permission to save files, and that allowing it always avoids repeat prompts. When done, tell them how many files were saved, the folder path, and which files to check by hand (any with \"unknown\" or hard to read).",
  "- Nothing matched: try a folder, dates or has_handwriting=true instead of words, then look at the pages.",
  "- A note is locked or unreadable: tell the user (locked notes must be unlocked in Samsung Notes) and move on.",
].join("\n");

type Content = CallToolResult["content"];

const text = (value: string): Content[number] => ({ type: "text", text: value });
const image = (data: Uint8Array, mimeType: string): Content[number] => ({
  type: "image",
  data: Buffer.from(data).toString("base64"),
  mimeType,
});
const partNote = (part: number, parts: number, next: string): string =>
  parts === 1 ? "" : ` (part ${part} of ${parts}${part < parts ? `; call again with ${next} for the next` : ""})`;

export function createServer(catalog: Catalog, saveRoot: () => string): McpServer {
  const server = new McpServer({ name: "samsung-notes", version }, { instructions: INSTRUCTIONS });

  const respond = async (produce: () => Promise<Content> | Content): Promise<CallToolResult> => {
    try {
      await catalog.refresh();
      return { content: await produce() };
    } catch (err) {
      if (!(err instanceof NoteError)) console.error("samsung-notes-mcp:", err);
      const message = err instanceof NoteError ? err.message : `Something went wrong: ${describeError(err)}`;
      return { isError: true, content: [text(message)] };
    }
  };

  const requireNote = (id: string): NoteEntry => {
    const entry = catalog.get(id);
    if (!entry) throw new NoteError(`No note with id “${id}”. Use list_notes to find note ids.`);
    return entry;
  };

  const requireAttachment = (id: string, file: string): { entry: NoteEntry; attachment: AttachmentInfo } => {
    const entry = requireNote(id);
    if (entry.locked) throw new NoteError(`“${entry.title}”: ${entry.problem}`);
    const attachment = entry.attachments.find((a) => a.file === file);
    if (!attachment) {
      const available = entry.attachments.map((a) => a.file).join(", ") || "none";
      throw new NoteError(`“${entry.title}” has no attachment named “${file}”. Its attachments: ${available}.`);
    }
    return { entry, attachment };
  };

  const requireReadable = (id: string): NoteEntry => {
    const entry = requireNote(id);
    if (entry.problem) throw new NoteError(`“${entry.title}”: ${entry.problem}`);
    return entry;
  };

  server.registerTool(
    "notes_overview",
    {
      title: "Notes overview",
      description:
        "Start here. Shows where notes are read from, every folder with its note count, totals, and any problems such as locked or unreadable notes.",
      annotations: READ_ONLY,
    },
    () => respond(() => [text(formatOverview(catalog.overview()))]),
  );

  server.registerTool(
    "list_notes",
    {
      title: "List or search notes",
      description:
        "Find notes: newest first, filtered by words, folder, modified dates, attachments or handwriting. Returns note ids for the other tools, and next_offset while more remain.",
      inputSchema: {
        query: z.string().optional().describe("Words to find in titles and typed text. Every word must appear. Handwriting isn't searched."),
        folder: z.string().optional().describe(`Folder name from notes_overview, e.g. "Invoices". Includes subfolders. Use "${NO_FOLDER}" for notes outside folders.`),
        modified_after: z.string().regex(DATE).optional().describe("Only notes last edited on or after this day, YYYY-MM-DD. Not the date written on an invoice inside the note."),
        modified_before: z.string().regex(DATE).optional().describe("Only notes last edited on or before this day, YYYY-MM-DD. Not the date written on an invoice inside the note."),
        has_attachments: z.boolean().optional().describe("true: only notes with photos or PDFs. false: only notes without."),
        has_handwriting: z.boolean().optional().describe("true: only notes with handwriting or drawings. false: only notes without."),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
        offset: z.number().int().min(0).default(0),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      respond(() => {
        const result = catalog.list({
          query: args.query,
          folder: args.folder,
          modifiedAfter: args.modified_after === undefined ? undefined : dayStart(args.modified_after),
          modifiedBefore: args.modified_before === undefined ? undefined : dayStart(args.modified_before, 1),
          hasAttachments: args.has_attachments,
          hasInk: args.has_handwriting,
          limit: args.limit,
          offset: args.offset,
        });
        const shown = args.offset + result.notes.length;
        return [
          text(
            JSON.stringify(
              {
                total: result.total,
                offset: args.offset,
                next_offset: shown < result.total ? shown : undefined,
                undated_included: result.undatedIncluded || undefined,
                hint: listHint(catalog, result),
                notes: result.notes.map((note) => ({
                  id: note.id,
                  title: note.title,
                  folder: note.folder || NO_FOLDER,
                  modified: note.modifiedMs === null ? "unknown" : formatDate(note.modifiedMs),
                  pages: note.pageCount,
                  handwriting_pages: note.inkPages.length ? formatPageRanges(note.inkPages) : undefined,
                  attachments: note.attachments.length ? note.attachments.map((a) => a.file) : undefined,
                  typed_text: note.text.length > 0,
                  snippet: note.snippet,
                  locked: note.locked || undefined,
                  problem: note.problem,
                })),
              },
              null,
              1,
            ),
          ),
        ];
      }),
  );

  server.registerTool(
    "read_note",
    {
      title: "Read a note",
      description:
        "Read one note: title, folder, dates, pages, attachment list, typed text with tables, and which pages hold handwriting or drawings.",
      inputSchema: { id: z.string().describe("Note id from list_notes.") },
      annotations: READ_ONLY,
    },
    ({ id }) => respond(() => [text(formatNote(requireNote(id)))]),
  );

  server.registerTool(
    "get_page_image",
    {
      title: "See a page",
      description:
        "See one page as an image. Use it for handwriting, drawings and layout, which read_note's text leaves out. Very tall pages come in overlapping parts: read them all, and count a repeated line once.",
      inputSchema: {
        id: z.string().describe("Note id from list_notes."),
        page: z.number().int().min(1).describe("Page number, starting at 1."),
        part: z.number().int().min(1).default(1).describe("For very tall pages: which part to show, starting at 1."),
      },
      annotations: READ_ONLY,
    },
    ({ id, page, part }) =>
      respond(async () => {
        const entry = requireReadable(id);
        if (page > entry.pageCount) {
          throw new NoteError(`“${entry.title}” has ${entry.pageCount} page${entry.pageCount === 1 ? "" : "s"}.`);
        }
        const rendered = renderPageSvg(await catalog.ref(id)!.fullBytes(), page - 1);
        const svg = cropToInk(rendered.svg, rendered.inkBottom);
        const parts = pageParts(svg);
        if (part > parts) throw new NoteError(`Page ${page} of “${entry.title}” has ${parts} part${parts === 1 ? "" : "s"}.`);
        const fitted = imageForClaude(renderPage(svg, part), "image/png");
        return [text(`Page ${page} of ${entry.pageCount} — “${entry.title}”${partNote(part, parts, `part=${part + 1}`)}`), image(fitted.data, fitted.mimeType)];
      }),
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Open an attachment",
      description:
        "Open a photo or PDF attached to a note, such as an invoice, receipt or scan. Photos come back as images; PDFs as text, plus images of pages without a text layer. Very tall photos and pages come in overlapping parts: read them all before taking figures, and count a repeated line once.",
      inputSchema: {
        id: z.string().describe("Note id from list_notes."),
        file: z.string().describe("Attachment file name from read_note or list_notes."),
        pages: z.array(z.number().int().min(1)).max(MAX_PDF_PAGES).optional().describe(`PDF only: page numbers to read, starting at 1. Default: the first ${DEFAULT_PDF_PAGES}.`),
        as_images: z.boolean().default(false).describe("PDF only: also send images of pages that have text."),
        part: z.number().int().min(1).default(1).describe("For very tall photos and PDF pages: which part to show, starting at 1. For a PDF, ask for one page at a time: pages=[N]."),
      },
      annotations: READ_ONLY,
    },
    ({ id, file, pages, as_images, part }) =>
      respond(async () => {
        const { entry, attachment } = requireAttachment(id, file);
        const bytes = await catalog.ref(id)!.readAttachment(file);
        if (attachment.mimeType.startsWith("image/")) {
          const parts = imageParts(bytes);
          if (part > parts) throw new NoteError(`“${file}” has ${parts} part${parts === 1 ? "" : "s"}.`);
          const fitted = imageForClaude(bytes, attachment.mimeType, MAX_IMAGE_BYTES, part);
          return [text(`“${file}” from “${entry.title}”${partNote(part, parts, `part=${part + 1}`)}`), image(fitted.data, fitted.mimeType)];
        }
        if (attachment.mimeType === "application/pdf") return pdfContent(entry, file, bytes, pages, as_images, part);
        throw new NoteError(`Can't open “${file}” (${attachment.mimeType}). Photos (JPEG, PNG, GIF, WebP) and PDFs are supported.`);
      }),
  );

  server.registerTool(
    "save_attachments",
    {
      title: "Save attachments to a folder",
      description:
        "Save copies of photos and PDFs attached to notes, such as invoices, receipts and scans, into a folder inside the user's Save folder, under names you choose. Use it only when the user asks to save, collect or organise files. Notes are never changed and no file is overwritten: a taken name gets “ (2)”, and a file whose contents are already in the folder is skipped, so repeating a call is safe. With check_only=true nothing is written: it says which files are already there, so a continued job skips them without opening them.",
      inputSchema: {
        folder: z
          .string()
          .min(1)
          .describe("Folder inside the Save folder, e.g. “Invoices 2025” or “Invoices/2025”. A relative name, not a full path; created when the first file is saved."),
        items: z
          .array(
            z.object({
              id: z.string().describe("Note id from list_notes."),
              file: z.string().describe("Attachment file name from read_note or list_notes."),
              name: z
                .string()
                .optional()
                .describe("New file name without extension, e.g. “2025-03-14 Shufersal 245.90 ILS”. The original extension is kept. Default: the original name."),
            }),
          )
          .min(1)
          .max(MAX_SAVE_ITEMS)
          .describe(`Files to save, up to ${MAX_SAVE_ITEMS}.`),
        check_only: z
          .boolean()
          .default(false)
          .describe("Write nothing; only say which files are already in the folder. Use it before opening files to save, and when continuing an earlier job."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ folder, items, check_only }) =>
      respond(async () => {
        const target = await openSaveFolder(saveRoot(), folder);
        const lines = [`Folder: ${target.path}`];
        if (check_only && !target.exists) {
          lines.push(`This folder doesn't exist yet. Folders in the Save folder: ${(await subfolders(saveRoot())).join(", ") || "none"}.`);
        }
        let saved = 0;
        let there = 0;
        let failed = 0;
        for (const [index, item] of items.entries()) {
          const label = `${index + 1}. “${item.file}”`;
          try {
            const { attachment } = requireAttachment(item.id, item.file);
            if (!attachment.mimeType.startsWith("image/") && attachment.mimeType !== "application/pdf") {
              throw new NoteError("Only photos (JPEG, PNG, GIF, WebP) and PDFs can be saved.");
            }
            const bytes = await catalog.ref(item.id)!.readAttachment(item.file);
            const existing = await target.find(bytes);
            if (existing) {
              there++;
              lines.push(`${label} already there as “${existing}”`);
            } else if (check_only) {
              lines.push(`${label} not saved yet`);
            } else {
              lines.push(`${label} saved as “${await target.write(bytes, fileNameFor(item.file, item.name))}”`);
              saved++;
            }
          } catch (err) {
            if (!(err instanceof NoteError)) console.error("samsung-notes-mcp:", err);
            failed++;
            lines.push(`${label} failed: ${err instanceof NoteError ? err.message : describeError(err)}`);
          }
        }
        lines.push(
          check_only
            ? `Already there ${there} · not saved yet ${items.length - there - failed} · failed ${failed}.`
            : `Saved ${saved} · already there ${there} · failed ${failed}.`,
        );
        return [text(lines.join("\n"))];
      }),
  );

  return server;
}

async function pdfContent(
  entry: NoteEntry,
  file: string,
  bytes: Uint8Array,
  pages: number[] | undefined,
  asImages: boolean,
  part: number,
): Promise<Content> {
  const requested = pages ?? Array.from({ length: DEFAULT_PDF_PAGES }, (_, i) => i + 1);
  const pdf = await readPdf(bytes, requested, asImages, PDF_BUDGET_BYTES, part);
  const shown = pdf.pages.map((page) => page.number);
  const rest = pdf.pageCount > Math.max(0, ...shown) ? ` Call again with pages=[${Math.max(0, ...shown) + 1}, …] for more.` : "";
  const content: Content = [text(`PDF “${file}” from “${entry.title}”: ${pdf.pageCount} pages. Showing ${shown.join(", ") || "none"}.${rest}`)];
  for (const page of pdf.pages) {
    const note = partNote(part, page.parts ?? 1, `pages=[${page.number}] and part=${part + 1}`);
    content.push(text(`--- Page ${page.number}${note} ---\n${page.text ? cutText(page.text, MAX_TEXT_CHARS) : "(no text layer; see the image)"}`));
    if (page.image) content.push(image(page.image, "image/jpeg"));
  }
  return content;
}

function formatOverview(overview: Overview): string {
  const lines = ["Sources:"];
  for (const source of overview.sources) lines.push(`- ${source.name} — ${source.location} — ${source.notes} notes`);
  if (overview.sources.length === 0) lines.push("- none");
  lines.push("", "Folders:");
  for (const folder of overview.folders) lines.push(`- ${folder.name}: ${folder.notes}`);
  const t = overview.totals;
  lines.push(
    "",
    `Totals: ${t.notes} notes · ${t.withAttachments} with attachments · ${t.withInk} with handwriting or drawings · ${t.withoutTypedText} without typed text · ${t.locked} locked · ${t.unreadable} unreadable`,
  );
  if (overview.problems.length) lines.push("", "Problems:", ...overview.problems.map((problem) => `- ${problem}`));
  return lines.join("\n");
}

function listHint(catalog: Catalog, { total, undatedIncluded }: ListResult): string | undefined {
  if (total === 0) return catalog.overview().totals.notes === 0 ? NO_NOTES_HINT : NO_MATCH_HINT;
  if (undatedIncluded === 0) return undefined;
  const one = undatedIncluded === 1;
  return `${undatedIncluded} ${one ? "note has" : "notes have"} no known date and ${one ? "is" : "are"} included; check ${one ? "its" : "their"} content for dates.`;
}

function formatNote(entry: NoteEntry): string {
  const facts = [
    `Folder: ${entry.folder || NO_FOLDER}`,
    entry.createdMs === null ? undefined : `Created: ${formatDateTime(entry.createdMs)}`,
    entry.modifiedMs === null ? undefined : `Modified: ${formatDateTime(entry.modifiedMs)}`,
    entry.problem ? undefined : `Pages: ${entry.pageCount}`,
  ].filter(Boolean);
  const lines = [`# ${entry.title}`, facts.join(" · ")];
  if (entry.inkPages.length) {
    const plural = entry.inkPages.length === 1 ? "" : "s";
    lines.push(`Handwriting or drawings on page${plural} ${formatPageRanges(entry.inkPages)}: not in the text below; see them with get_page_image.`);
  }
  if (entry.attachments.length) {
    const list = entry.attachments.map((a) => `${a.file} (${a.mimeType}, ${formatBytes(a.size)})`).join("; ");
    lines.push(`Attachments (open with get_attachment): ${list}`);
  }
  if (entry.problem) return [...lines, "", entry.problem].join("\n");
  return [...lines, "", entry.text ? cutText(entry.text, MAX_TEXT_CHARS) : noTextBody(entry)].join("\n");
}

function noTextBody(entry: NoteEntry): string {
  if (entry.attachments.length) return "(No typed text. Its content is in the attachments above: open them with get_attachment.)";
  if (entry.inkPages.length) return "(No typed text. See the pages listed above with get_page_image.)";
  return "(No typed text.)";
}

function dayStart(date: string, addDays = 0): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    throw new NoteError(`“${date}” is not a real date. Use YYYY-MM-DD.`);
  }
  return new Date(year, month - 1, day + addDays).getTime();
}

const formatBytes = (bytes: number): string =>
  bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
