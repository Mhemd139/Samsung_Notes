import type { TextSpan } from "./sdocx.js";

const OBJECT_CHAR = "￼";
const MAX_TITLE_LENGTH = 80;
const ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&amp;": "&",
};

interface TableContent {
  rows?: { cells?: { content?: { text?: string } }[] }[];
}
interface CodeBlockContent {
  title?: { text?: string };
  body?: { text?: string };
}
interface ImageContent {
  media_id?: number;
}

export interface TitleParts {
  title: string;
  indexTitle?: string;
  text: string;
  modifiedMs: number | null;
}

export function buildNoteText(rawText: string, spans: TextSpan[], attachmentFiles: string[]): string {
  let text = rawText;
  const misplaced: string[] = [];
  for (const span of [...spans].sort((a, b) => b.text_index_utf16 - a.text_index_utf16)) {
    const at = span.text_index_utf16;
    const rendered = renderSpan(span, attachmentFiles);
    if (text[at] === OBJECT_CHAR) {
      text = text.slice(0, at) + rendered + text.slice(at + 1);
    } else {
      misplaced.unshift(rendered);
    }
  }
  return decodeEntities([text, ...misplaced].join("\n").replaceAll(OBJECT_CHAR, ""))
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function noteTitle({ title, indexTitle, text, modifiedMs }: TitleParts): string {
  const chosen = title.trim() || indexTitle?.trim() || firstLine(text);
  if (chosen) return truncate(chosen);
  return modifiedMs === null ? "Untitled note" : `Untitled note (${formatDate(modifiedMs)})`;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function formatDate(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(ms: number): string {
  const date = new Date(ms);
  return `${formatDate(ms)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const formatPageRanges = (pages: number[]): string =>
  pages
    .reduce<[number, number][]>((runs, page) => {
      const last = runs.at(-1);
      if (last && page === last[1] + 1) last[1] = page;
      else runs.push([page, page]);
      return runs;
    }, [])
    .map(([start, end]) => (start === end ? `${start}` : `${start}–${end}`))
    .join(", ");

function renderSpan(span: TextSpan, attachmentFiles: string[]): string {
  const content = span.content ?? {};
  if ("Table" in content) return `\n${tableToMarkdown(content.Table as TableContent)}\n`;
  if ("CodeBlock" in content) {
    const block = content.CodeBlock as CodeBlockContent;
    return `\n\`\`\`${block.title?.text ?? ""}\n${block.body?.text ?? ""}\n\`\`\`\n`;
  }
  if ("Image" in content) {
    const mediaId = (content.Image as ImageContent).media_id;
    const file = attachmentFiles.find((name) => name.startsWith(`${mediaId}@`));
    return file ? `[image: ${file}]` : "[image]";
  }
  return `[${span.object_type}]`;
}

function tableToMarkdown(table: TableContent): string {
  const rows = (table.rows ?? []).map((row) =>
    (row.cells ?? []).map((cell) =>
      (cell.content?.text ?? "").replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|").trim(),
    ),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
  const [header, ...body] = rows;
  return [line(header), `|${" --- |".repeat(width)}`, ...body.map(line)].join("\n");
}

const decodeEntities = (text: string): string =>
  text.replace(/&(?:lt|gt|quot|#39|apos|amp);/g, (entity) => ENTITIES[entity] ?? entity);

const firstLine = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /[\p{L}\p{N}]/u.test(line) && !/^(\[image|\||```)/.test(line)) ?? "";

const truncate = (value: string): string => {
  const chars = Array.from(value);
  return chars.length > MAX_TITLE_LENGTH ? `${chars.slice(0, MAX_TITLE_LENGTH - 1).join("")}…` : value;
};
