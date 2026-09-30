export interface AttachmentInfo {
  file: string;
  mimeType: string;
  size: number;
}

export interface NoteRef {
  id: string;
  folder: string;
  stamp: string;
  locked: boolean;
  indexTitle?: string;
  leanBytes(): Promise<Uint8Array>;
  fullBytes(): Promise<Uint8Array>;
  attachments(): Promise<AttachmentInfo[]>;
  readAttachment(file: string): Promise<Uint8Array>;
}

export interface SourceListing {
  notes: NoteRef[];
  warnings: string[];
}

export interface NoteSource {
  name: string;
  location: string;
  listNotes(): Promise<SourceListing>;
}

const MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

export function mimeTypeFor(file: string): string {
  const dot = file.lastIndexOf(".");
  return (dot === -1 ? undefined : MIME_TYPES[file.slice(dot + 1).toLowerCase()]) ?? "application/octet-stream";
}
