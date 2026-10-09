import { unzipSync, zipSync } from "fflate";

const MEDIA_DIR = "media/";
const MEDIA_INDEX = "media/mediaInfo.dat";
const INTERNAL_MEDIA = /\.spi$/i;

export const isMediaEntry = (name: string): boolean => name.startsWith(MEDIA_DIR) && name !== MEDIA_INDEX;

export const isAttachmentEntry = (name: string): boolean =>
  isMediaEntry(name) && !name.endsWith("/") && !INTERNAL_MEDIA.test(name);

export function stripMedia(sdocx: Uint8Array): Uint8Array {
  return zipSync(unzipSync(sdocx, { filter: (file) => !isMediaEntry(file.name) && !file.name.endsWith("/") }), {
    level: 0,
  });
}

export function listZipAttachments(sdocx: Uint8Array): { name: string; size: number }[] {
  const found: { name: string; size: number }[] = [];
  unzipSync(sdocx, {
    filter: (file) => {
      if (isAttachmentEntry(file.name)) found.push({ name: file.name.slice(MEDIA_DIR.length), size: file.originalSize });
      return false;
    },
  });
  return found;
}

export function readZipAttachment(sdocx: Uint8Array, file: string): Uint8Array | undefined {
  const name = MEDIA_DIR + file;
  if (!isAttachmentEntry(name)) return undefined;
  return unzipSync(sdocx, { filter: (entry) => entry.name === name })[name];
}
