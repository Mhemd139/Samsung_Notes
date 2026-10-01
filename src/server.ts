import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { NO_FOLDER, type Catalog, type NoteEntry, type Overview } from "./catalog.js";
import { describeError, NoteError } from "./errors.js";
import { imageForClaude, pageParts, renderPage } from "./images.js";
import { readPdf } from "./pdf.js";
import { renderPageSvg } from "./sdocx.js";
import { formatDate, formatDateTime, formatPageRanges } from "./text.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const TOOL_NAMES = ["get_attachment", "get_page_image", "list_notes", "notes_overview", "read_note"] as const;

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_PDF_PAGES = 5;
const MAX_PDF_PAGES = 20;
const MAX_TEXT_CHARS = 100_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const INSTRUCTIONS = [
  "Read-only access to the user's Samsung Notes: typed text, tables, handwritten pages, and attached photos and PDFs. Nothing here can change a note.",
  "",
  "Which tool, when:",
  "- Start of a task, or \"what's in my notes?\": notes_overview shows sources, folders, totals and problems.",
  "- Find notes by words, folder, dates, attachments or handwriting: list_notes. Words match titles and typed text only, never handwriting.",
  "- Read a note: read_note gives its typed text, tables and attachments, and names the pages that hold handwriting or drawings.",
  "- Handwriting, sketches or page layout: get_page_image, one page at a time. Very tall pages come in parts; the reply says how to get the next.",
  "- Invoices, receipts, photos, scans and PDFs: list_notes with has_attachments=true (add a folder or dates to narrow it), then get_attachment for each file that read_note or list_notes names. Scanned PDF pages come back as images.",
  "- Go through everything (e.g. \"put all my invoices in a spreadsheet\"): repeat list_notes with next_offset until it stops returning one, open every note and file you need, then build the table, summary or file yourself.",
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

export function createServer(catalog: Catalog): McpServer {
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
        modified_after: z.string().regex(DATE).optional().describe("Only notes modified on or after this day, YYYY-MM-DD."),
        modified_before: z.string().regex(DATE).optional().describe("Only notes modified on or before this day, YYYY-MM-DD."),
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
                hint:
                  result.total === 0
                    ? "No notes matched. Handwriting isn't searchable: try a folder, dates or has_handwriting=true instead, then open pages with get_page_image."
                    : undefined,
                notes: result.notes.map((note) => ({
                  id: note.id,
                  title: note.title,
                  folder: note.folder || NO_FOLDER,
                  modified: note.modifiedMs === null ? undefined : formatDate(note.modifiedMs),
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
        "See one page as an image. Use it for handwriting, drawings and layout, which read_note's text leaves out. Very tall pages come in parts.",
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
        const svg = renderPageSvg(await catalog.ref(id)!.fullBytes(), page - 1);
        const parts = pageParts(svg);
        if (part > parts) throw new NoteError(`Page ${page} of “${entry.title}” has ${parts} part${parts === 1 ? "" : "s"}.`);
        const partNote = parts > 1 ? ` (part ${part} of ${parts}${part < parts ? `; call again with part=${part + 1} for the next` : ""})` : "";
        const fitted = imageForClaude(renderPage(svg, part), "image/png");
        return [text(`Page ${page} of ${entry.pageCount} — “${entry.title}”${partNote}`), image(fitted.data, fitted.mimeType)];
      }),
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Open an attachment",
      description:
        "Open a photo or PDF attached to a note, such as an invoice, receipt or scan. Photos come back as images; PDFs as text, plus images of pages without a text layer.",
      inputSchema: {
        id: z.string().describe("Note id from list_notes."),
        file: z.string().describe("Attachment file name from read_note or list_notes."),
        pages: z.array(z.number().int().min(1)).max(MAX_PDF_PAGES).optional().describe(`PDF only: page numbers to read, starting at 1. Default: the first ${DEFAULT_PDF_PAGES}.`),
        as_images: z.boolean().default(false).describe("PDF only: also send images of pages that have text."),
      },
      annotations: READ_ONLY,
    },
    ({ id, file, pages, as_images }) =>
      respond(async () => {
        const entry = requireNote(id);
        if (entry.locked) throw new NoteError(`“${entry.title}”: ${entry.problem}`);
        const attachment = entry.attachments.find((a) => a.file === file);
        if (!attachment) {
          const available = entry.attachments.map((a) => a.file).join(", ") || "none";
          throw new NoteError(`“${entry.title}” has no attachment named “${file}”. Its attachments: ${available}.`);
        }
        const bytes = await catalog.ref(id)!.readAttachment(file);
        if (attachment.mimeType.startsWith("image/")) {
          const fitted = imageForClaude(bytes, attachment.mimeType);
          return [text(`“${file}” from “${entry.title}”`), image(fitted.data, fitted.mimeType)];
        }
        if (attachment.mimeType === "application/pdf") return pdfContent(entry, file, bytes, pages, as_images);
        throw new NoteError(`Can't open “${file}” (${attachment.mimeType}). Photos (JPEG, PNG, GIF, WebP) and PDFs are supported.`);
      }),
  );

  return server;
}

async function pdfContent(entry: NoteEntry, file: string, bytes: Uint8Array, pages: number[] | undefined, asImages: boolean): Promise<Content> {
  const requested = pages ?? Array.from({ length: DEFAULT_PDF_PAGES }, (_, i) => i + 1);
  const pdf = await readPdf(bytes, requested, asImages);
  const shown = pdf.pages.map((page) => page.number);
  const rest = pdf.pageCount > Math.max(0, ...shown) ? ` Call again with pages=[${Math.max(0, ...shown) + 1}, …] for more.` : "";
  const content: Content = [text(`PDF “${file}” from “${entry.title}”: ${pdf.pageCount} pages. Showing ${shown.join(", ") || "none"}.${rest}`)];
  for (const page of pdf.pages) {
    content.push(text(`--- Page ${page.number} ---\n${page.text ? limit(page.text) : "(no text layer; see the image)"}`));
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

function formatNote(entry: NoteEntry): string {
  const facts = [
    `Folder: ${entry.folder || NO_FOLDER}`,
    entry.createdMs === null ? undefined : `Created: ${formatDateTime(entry.createdMs)}`,
    entry.modifiedMs === null ? undefined : `Modified: ${formatDateTime(entry.modifiedMs)}`,
    `Pages: ${entry.pageCount}`,
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
  const body = entry.text
    ? limit(entry.text)
    : `(No typed text. This note is handwriting, drawings or images: use get_page_image for pages 1–${entry.pageCount}.)`;
  return [...lines, "", body].join("\n");
}

function dayStart(date: string, addDays = 0): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const start = new Date(year, month - 1, day);
  if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) {
    throw new NoteError(`“${date}” is not a real date. Use YYYY-MM-DD.`);
  }
  return new Date(year, month - 1, day + addDays).getTime();
}

const limit = (value: string): string =>
  value.length > MAX_TEXT_CHARS ? `${value.slice(0, MAX_TEXT_CHARS)}\n…(cut at ${MAX_TEXT_CHARS.toLocaleString("en-US")} characters)` : value;

const formatBytes = (bytes: number): string =>
  bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
