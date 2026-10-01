import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { NoteError } from "./errors.js";

export interface SaveFolder {
  path: string;
  exists: boolean;
  find(bytes: Uint8Array): Promise<string | undefined>;
  write(bytes: Uint8Array, name: string): Promise<string>;
}

const MAX_NAME_BYTES = 200;
const ROOTED = /^\s*([\\/]|[a-z]:)/i;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\s*(\.|$)/i;
const TYPED_EXTENSION = /\.(jpe?g|png|gif|webp|pdf)\s*$/i;

export function targetFolder(root: string, folder: string): string {
  const parts = folder.split(/[\\/]+/).filter(Boolean);
  const cleaned = parts.map(cleanName);
  if (ROOTED.test(folder) || !parts.length || parts.some((p) => p === "." || p === "..") || cleaned.some((p) => !p)) {
    throw new NoteError(
      `“${folder}” isn't a folder name inside the Save folder. Use a relative name such as “Invoices 2025”, with no drive, leading slash or “..”.`,
    );
  }
  return join(root, ...cleaned);
}

export function fileNameFor(file: string, name?: string): string {
  const extension = extname(file);
  const original = basename(file, extension).replace(/^\d+@/, "");
  const stem = cleanName((name ?? "").replace(TYPED_EXTENSION, "")) || cleanName(original) || "attachment";
  return stem + extension.toLowerCase();
}

export async function openSaveFolder(root: string, folder: string): Promise<SaveFolder> {
  const path = targetFolder(root, folder);
  const entries = await entriesOf(path);
  const files = new Map(
    await Promise.all(
      (entries ?? []).filter((e) => e.isFile()).map(async (e) => [e.name, (await stat(join(path, e.name))).size] as const),
    ),
  );
  return {
    path,
    exists: entries !== undefined,
    async find(bytes) {
      for (const [name, size] of files) {
        if (size === bytes.length && Buffer.from(bytes).equals(await readFile(join(path, name)))) return name;
      }
      return undefined;
    },
    async write(bytes, name) {
      await mkdir(path, { recursive: true });
      const extension = extname(name);
      const stem = name.slice(0, name.length - extension.length);
      for (let copy = 1; ; copy++) {
        const candidate = copy === 1 ? name : `${stem} (${copy})${extension}`;
        try {
          await writeFile(join(path, candidate), bytes, { flag: "wx" });
          files.set(candidate, bytes.length);
          return candidate;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
      }
    },
  };
}

export async function subfolders(root: string): Promise<string[]> {
  return ((await entriesOf(root)) ?? [])
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function cleanName(name: string): string {
  const clean = cutToBytes(
    name
      .replace(/[\t\n\r\v\f]/g, " ")
      .replace(/[\p{Cc}\p{Cf}]/gu, "")
      .replace(/\s+/g, " ")
      .replace(/[<>:"/\\|?*]/g, "_")
      .replace(/^[. ]+|[. ]+$/g, ""),
    MAX_NAME_BYTES,
  ).replace(/[. ]+$/, "");
  return RESERVED.test(clean) ? `_${clean}` : clean;
}

function cutToBytes(value: string, max: number): string {
  let bytes = 0;
  let out = "";
  for (const char of value) {
    bytes += Buffer.byteLength(char);
    if (bytes > max) break;
    out += char;
  }
  return out;
}

async function entriesOf(path: string): Promise<Dirent[] | undefined> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (err) {
    const { code } = err as NodeJS.ErrnoException;
    if (code === "ENOENT") return undefined;
    if (code === "ENOTDIR") throw new NoteError(`“${path}” is a file, not a folder. Use another folder name.`);
    throw err;
  }
}
