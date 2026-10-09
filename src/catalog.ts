import type { SourceSetup } from "./config.js";
import { describeError } from "./errors.js";
import { inspectNote } from "./sdocx.js";
import type { AttachmentInfo, NoteRef, NoteSource } from "./sources/types.js";
import { buildNoteText, noteTitle } from "./core/text.js";

export const NO_FOLDER = "(no folder)";
export const MAX_LISTED_PROBLEMS = 10;
const SNIPPET_RADIUS = 80;

export interface NoteEntry {
  id: string;
  title: string;
  folder: string;
  source: string;
  createdMs: number | null;
  modifiedMs: number | null;
  pageCount: number;
  inkPages: number[];
  attachments: AttachmentInfo[];
  text: string;
  locked: boolean;
  problem?: string;
}

export interface ListFilter {
  query?: string;
  folder?: string;
  modifiedAfter?: number;
  modifiedBefore?: number;
  hasAttachments?: boolean;
  hasInk?: boolean;
  limit: number;
  offset: number;
}

export interface ListedNote extends NoteEntry {
  snippet?: string;
}

export interface ListResult {
  total: number;
  undatedIncluded: number;
  notes: ListedNote[];
}

export interface Overview {
  sources: { name: string; location: string; notes: number }[];
  folders: { name: string; notes: number }[];
  totals: {
    notes: number;
    withAttachments: number;
    withInk: number;
    withoutTypedText: number;
    locked: number;
    unreadable: number;
  };
  problems: string[];
}

interface Cached {
  ref: NoteRef;
  entry: NoteEntry;
}

export class Catalog {
  private readonly cache = new Map<string, Cached>();
  private sources: NoteSource[] = [];
  private setupProblems: string[] = [];
  private warnings: string[] = [];
  private running?: Promise<void>;

  constructor(private readonly setup: () => SourceSetup) {}

  refresh(): Promise<void> {
    this.running ??= this.rebuild().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  get(id: string): NoteEntry | undefined {
    return this.cache.get(id)?.entry;
  }

  ref(id: string): NoteRef | undefined {
    return this.cache.get(id)?.ref;
  }

  list(filter: ListFilter): ListResult {
    const query = filter.query ?? "";
    const [firstWord] = queryWords(query);
    const folder = normalize(filter.folder ?? "").replace(/^\/+|\/+$/g, "");
    const matches = this.entries()
      .filter(
        (entry) =>
          (!folder || inFolder(entry.folder, folder)) &&
          (filter.hasAttachments === undefined || entry.attachments.length > 0 === filter.hasAttachments) &&
          (filter.hasInk === undefined || entry.inkPages.length > 0 === filter.hasInk) &&
          inDateRange(entry.modifiedMs, filter.modifiedAfter, filter.modifiedBefore) &&
          matchesQuery(entry.title, entry.text, query),
      )
      .sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0) || a.title.localeCompare(b.title));
    const page = matches.slice(filter.offset, filter.offset + filter.limit);
    const dateFiltered = filter.modifiedAfter !== undefined || filter.modifiedBefore !== undefined;
    return {
      total: matches.length,
      undatedIncluded: dateFiltered ? matches.filter((entry) => entry.modifiedMs === null).length : 0,
      notes: firstWord ? page.map((entry) => ({ ...entry, snippet: snippet(entry.text, firstWord) })) : page,
    };
  }

  overview(): Overview {
    const all = this.entries();
    const folders = new Map<string, number>();
    for (const entry of all) {
      const name = entry.folder || NO_FOLDER;
      folders.set(name, (folders.get(name) ?? 0) + 1);
    }
    const unreadable = all.filter((entry) => entry.problem && !entry.locked);
    const hiddenWarnings = this.warnings.length - MAX_LISTED_PROBLEMS;
    return {
      sources: this.sources.map((source) => ({
        name: source.name,
        location: source.location,
        notes: all.filter((entry) => entry.source === source.name).length,
      })),
      folders: [...folders].map(([name, notes]) => ({ name, notes })).sort((a, b) => a.name.localeCompare(b.name)),
      totals: {
        notes: all.length,
        withAttachments: all.filter((entry) => entry.attachments.length > 0).length,
        withInk: all.filter((entry) => entry.inkPages.length > 0).length,
        withoutTypedText: all.filter((entry) => !entry.text && !entry.problem).length,
        locked: all.filter((entry) => entry.locked).length,
        unreadable: unreadable.length,
      },
      problems: [
        ...this.setupProblems,
        ...this.warnings.slice(0, MAX_LISTED_PROBLEMS),
        ...(hiddenWarnings > 0 ? [`…and ${hiddenWarnings} more warning${hiddenWarnings === 1 ? "" : "s"}.`] : []),
        ...unreadable.slice(0, MAX_LISTED_PROBLEMS).map((entry) => `“${entry.title}” (${entry.id}): ${entry.problem}`),
      ],
    };
  }

  private entries(): NoteEntry[] {
    return [...this.cache.values()].map((cached) => cached.entry);
  }

  private async rebuild(): Promise<void> {
    const { sources, problems } = this.setup();
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const source of sources) {
      try {
        const listing = await source.listNotes();
        warnings.push(...listing.warnings);
        for (const ref of listing.notes) {
          seen.add(ref.id);
          const cached = this.cache.get(ref.id);
          if (cached && !cached.entry.problem && cached.ref.stamp === ref.stamp) {
            cached.ref = ref;
            continue;
          }
          this.cache.set(ref.id, { ref, entry: await buildEntry(source.name, ref) });
        }
      } catch (err) {
        warnings.push(`${source.name} (${source.location}): ${describeError(err)}`);
        for (const [id, cached] of this.cache) if (cached.entry.source === source.name) seen.add(id);
      }
    }
    for (const id of this.cache.keys()) if (!seen.has(id)) this.cache.delete(id);
    this.sources = sources;
    this.setupProblems = problems;
    this.warnings = warnings;
  }
}

async function buildEntry(source: string, ref: NoteRef): Promise<NoteEntry> {
  const entry: NoteEntry = {
    id: ref.id,
    title: ref.indexTitle?.trim() || "Untitled note",
    folder: ref.folder,
    source,
    createdMs: null,
    modifiedMs: null,
    pageCount: 0,
    inkPages: [],
    attachments: [],
    text: "",
    locked: ref.locked,
  };
  if (ref.locked) return { ...entry, problem: "This note is locked in Samsung Notes. Unlock it there to read it here." };
  try {
    entry.attachments = await ref.attachments();
    const details = inspectNote(await ref.leanBytes());
    const text = buildNoteText(details.rawText, details.spans, entry.attachments.map((a) => a.file));
    return {
      ...entry,
      text,
      title: noteTitle({ title: details.title, indexTitle: ref.indexTitle, text, modifiedMs: details.modifiedMs }),
      createdMs: details.createdMs,
      modifiedMs: details.modifiedMs,
      pageCount: details.pageCount,
      inkPages: details.inkPages,
    };
  } catch (err) {
    return { ...entry, problem: friendlyProblem(err) };
  }
}

export function friendlyProblem(err: unknown): string {
  const message = describeError(err);
  const tooLong = /text characters limit exceeded: (\d+) > (\d+)/.exec(message);
  if (tooLong) {
    const [size, limit] = [Number(tooLong[1]), Number(tooLong[2])].map((n) => n.toLocaleString("en-US"));
    return `This note is too long to read (${size} characters; the limit is ${limit}).`;
  }
  return `Couldn't read this note: ${message}`;
}

export function matchesQuery(title: string, text: string, query: string): boolean {
  const haystack = normalize(`${title}\n${text}`);
  return queryWords(query).every((word) => haystack.includes(word));
}

const inDateRange = (modifiedMs: number | null, after?: number, before?: number): boolean =>
  modifiedMs === null || ((after === undefined || modifiedMs >= after) && (before === undefined || modifiedMs < before));

const visible = (value: string): string => value.normalize("NFKC").replace(/\p{Cf}/gu, "");

const normalize = (value: string): string => visible(value).toLowerCase().trim();

const queryWords = (query: string): string[] => normalize(query).split(/\s+/).filter(Boolean);

function inFolder(entryFolder: string, folder: string): boolean {
  if (folder === normalize(NO_FOLDER)) return entryFolder === "";
  const own = normalize(entryFolder);
  return own === folder || own.startsWith(`${folder}/`);
}

export function snippet(text: string, word: string): string {
  const flat = visible(text).replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(word);
  if (at === -1) return flat.slice(0, 2 * SNIPPET_RADIUS);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = at + word.length + SNIPPET_RADIUS;
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
