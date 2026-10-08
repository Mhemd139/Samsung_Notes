import { unzipSync } from "fflate";

export interface Problem {
  name: string;
  reason: "notNote" | "oldFormat";
}

export interface Intake {
  notes: File[];
  problems: Problem[];
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const NOTE_FILE = /\.sdocx$/i;
const OPENABLE_IN_FOLDER = /\.(sdocx|zip)$/i;
const OLD_FORMAT = /\.(sdoc|snb|spd)$/i;
const NOTE_ENTRY = "note.note";

// Decides by content, not by name: phones often share a note without its extension, or many notes as one zip.
export async function sortFiles(files: File[]): Promise<Intake> {
  const intake: Intake = { notes: [], problems: [] };
  for (const file of files) {
    if (!(await startsWithZip(file))) {
      intake.problems.push({ name: file.name, reason: OLD_FORMAT.test(file.name) ? "oldFormat" : "notNote" });
      continue;
    }
    if (NOTE_FILE.test(file.name)) {
      intake.notes.push(file);
      continue;
    }
    const found = await openZip(file);
    if (found.length) intake.notes.push(...found);
    else intake.problems.push({ name: file.name, reason: "notNote" });
  }
  return intake;
}

async function startsWithZip(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, ZIP_MAGIC.length).arrayBuffer());
  return ZIP_MAGIC.every((byte, i) => head[i] === byte);
}

async function openZip(file: File): Promise<File[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let isNote = false;
  const entries = unzipSync(bytes, {
    filter: ({ name }) => {
      if (name === NOTE_ENTRY) isNote = true;
      return NOTE_FILE.test(name) && !isHidden(name);
    },
  });
  if (isNote) return [new File([bytes], `${file.name.replace(/\.[^.]*$/, "")}.sdocx`)];
  return Object.entries(entries).map(([name, data]) => new File([data], baseName(name)));
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const isHidden = (path: string): boolean => path.startsWith("__MACOSX/") || baseName(path).startsWith(".");

// Must be called inside the drop event: the browser forgets the dropped items once the event returns.
export function droppedFiles(transfer: DataTransfer): Promise<File[]> {
  const entries = [...transfer.items]
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);
  return entries.length ? collect(entries, false) : Promise.resolve([...transfer.files]);
}

async function collect(entries: FileSystemEntry[], insideFolder: boolean): Promise<File[]> {
  const files: File[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) files.push(...(await collect(await readFolder(entry as FileSystemDirectoryEntry), true)));
    else if (!insideFolder || OPENABLE_IN_FOLDER.test(entry.name)) files.push(await fileOf(entry as FileSystemFileEntry));
  }
  return files;
}

const fileOf = (entry: FileSystemFileEntry): Promise<File> => new Promise((resolve, reject) => entry.file(resolve, reject));

async function readFolder(folder: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = folder.createReader();
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}
