import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { NoteError } from "./errors.js";

export const IMAGE_WIDTH = 1200;
export const MAX_IMAGE_BYTES = 600_000;
export const MAX_IMAGE_EDGE = 1568;
const MAX_PASS_THROUGH_EDGE = 2000;
const MAX_SINGLE_PART_RATIO = 1.66;
const MAX_SINGLE_PART_ATTACHMENT_RATIO = 2.5;
const PART_RATIO = 1.5;
const PART_OVERLAP_RATIO = 0.1;
const JPEG_QUALITY = 80;
const SHRINK_STEP = 0.8;
const MIN_IMAGE_EDGE = 200;
const EXIF_SIGNATURE = 0x45786966;
const TIFF_LITTLE_ENDIAN = 0x4949;
const TIFF_BIG_ENDIAN = 0x4d4d;
const TIFF_SHORT = 3;
const EXIF_ORIENTATION_TAG = 0x0112;

interface Size {
  width: number;
  height: number;
}

interface Box extends Size {
  x: number;
  y: number;
}

const ORIENTATIONS: Record<number, { swapsAxes: boolean; matrix: (width: number, height: number) => string }> = {
  1: { swapsAxes: false, matrix: () => "1 0 0 1 0 0" },
  2: { swapsAxes: false, matrix: (width) => `-1 0 0 1 ${width} 0` },
  3: { swapsAxes: false, matrix: (width, height) => `-1 0 0 -1 ${width} ${height}` },
  4: { swapsAxes: false, matrix: (_, height) => `1 0 0 -1 0 ${height}` },
  5: { swapsAxes: true, matrix: () => "0 1 1 0 0 0" },
  6: { swapsAxes: true, matrix: (_, height) => `0 1 -1 0 ${height} 0` },
  7: { swapsAxes: true, matrix: (width, height) => `0 -1 -1 0 ${height} ${width}` },
  8: { swapsAxes: true, matrix: (width) => `0 -1 1 0 0 ${width}` },
};

export function svgToPng(svg: string, width = IMAGE_WIDTH): Uint8Array {
  return rasterize(svg, width).asPng();
}

export function pageParts(svg: string): number {
  const box = viewBox(svg);
  return box ? partCount(box.width, box.height, MAX_SINGLE_PART_RATIO) : 1;
}

export function renderPage(svg: string, part: number): Uint8Array {
  const box = viewBox(svg);
  const parts = pageParts(svg);
  if (!box || parts === 1) return svgToPng(svg);
  const band = partBand(box.width, box.height, part, parts);
  const sliced = svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\sviewBox="[^"]*"/, ` viewBox="${box.x} ${box.y + band.top} ${box.width} ${band.height}"`)
      .replace(/\swidth="[^"]*"/, ` width="${box.width}"`)
      .replace(/\sheight="[^"]*"/, ` height="${band.height}"`),
  );
  return svgToPng(sliced);
}

export const attachmentParts = (width: number, height: number): number =>
  width > 0 && height > MAX_IMAGE_EDGE ? partCount(width, height, MAX_SINGLE_PART_ATTACHMENT_RATIO) : 1;

export function imageParts(bytes: Uint8Array): number {
  const stored = imageSize(bytes);
  if (!stored) return 1;
  const { width, height } = upright(stored, exifOrientation(bytes));
  return attachmentParts(width, height);
}

export function partBand(width: number, height: number, part: number, parts: number): { top: number; height: number } {
  if (parts === 1) return { top: 0, height };
  const partHeight = width * PART_RATIO;
  return { top: ((part - 1) * (height - partHeight)) / (parts - 1), height: partHeight };
}

function partCount(width: number, height: number, maxSinglePartRatio: number): number {
  if (height <= width * maxSinglePartRatio) return 1;
  const overlap = width * PART_OVERLAP_RATIO;
  return Math.ceil((height - overlap) / (width * PART_RATIO - overlap));
}

export function imageSize(bytes: Uint8Array): Size | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return undefined;
  let at = 2;
  while (at + 9 < bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
    }
    at += 2 + view.getUint16(at + 2);
  }
  return undefined;
}

export function imageForClaude(
  bytes: Uint8Array,
  mimeType: string,
  maxBytes = MAX_IMAGE_BYTES,
  part?: number,
): { data: Uint8Array; mimeType: string } {
  const stored = imageSize(bytes);
  const orientation = stored ? exifOrientation(bytes) : 1;
  const parts = part === undefined ? 1 : imageParts(bytes);
  const overEdgeLimit = stored !== undefined && Math.max(stored.width, stored.height) > MAX_PASS_THROUGH_EDGE;
  if (parts === 1 && bytes.length <= maxBytes && orientation === 1 && !overEdgeLimit) return { data: bytes, mimeType };
  if (!stored) throw new NoteError(`This image is too large to send (${(bytes.length / 1e6).toFixed(1)} MB).`);
  const { svg, width, height } = uprightSvg(bytes, mimeType, stored, orientation, part ?? 1, parts);
  const longEdge = Math.max(width, height);
  const minEdge = Math.min(MIN_IMAGE_EDGE, longEdge);
  let edge = Math.min(MAX_IMAGE_EDGE, longEdge);
  while (edge >= minEdge) {
    const rendered = rasterize(svg, Math.floor((width * edge) / longEdge));
    const pixels = rendered.pixels;
    if (parts === 1 && bytes.length > maxBytes && pixels.every((byte) => byte === 255)) {
      throw new NoteError("Couldn't read this image. The file may be damaged; open the note in Samsung Notes to check it.");
    }
    const data = encodeJpeg(rendered.width, rendered.height, pixels);
    if (data.length <= maxBytes) return { data, mimeType: "image/jpeg" };
    edge = Math.floor(edge * Math.min(SHRINK_STEP, Math.sqrt(maxBytes / data.length)));
  }
  throw new NoteError(`This image is too large to send (${(bytes.length / 1e6).toFixed(1)} MB).`);
}

export const encodeJpeg = (width: number, height: number, rgba: Uint8Array): Uint8Array =>
  jpeg.encode({ width, height, data: rgba }, JPEG_QUALITY).data;

const upright = (stored: Size, orientation: number): Size =>
  ORIENTATIONS[orientation]!.swapsAxes ? { width: stored.height, height: stored.width } : stored;

function uprightSvg(bytes: Uint8Array, mimeType: string, stored: Size, orientation: number, part: number, parts: number): Size & { svg: string } {
  const { width, height } = upright(stored, orientation);
  const band = partBand(width, height, part, parts);
  const href = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${band.height}" viewBox="0 ${band.top} ${width} ${band.height}">` +
    `<image width="${stored.width}" height="${stored.height}" transform="matrix(${ORIENTATIONS[orientation]!.matrix(stored.width, stored.height)})" xlink:href="${href}"/></svg>`;
  return { svg, width, height: band.height };
}

function exifOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return 1;
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff && bytes[at + 1] !== 0xda) {
    const end = Math.min(at + 2 + view.getUint16(at + 2), bytes.length);
    const isExif = bytes[at + 1] === 0xe1 && at + 10 <= end && view.getUint32(at + 4) === EXIF_SIGNATURE && view.getUint16(at + 8) === 0;
    if (isExif) return tiffOrientation(view, at + 10, end);
    at = end;
  }
  return 1;
}

function tiffOrientation(view: DataView, tiff: number, end: number): number {
  if (tiff + 8 > end) return 1;
  const byteOrder = view.getUint16(tiff);
  if (byteOrder !== TIFF_LITTLE_ENDIAN && byteOrder !== TIFF_BIG_ENDIAN) return 1;
  const little = byteOrder === TIFF_LITTLE_ENDIAN;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  if (ifd + 2 > end) return 1;
  const entries = view.getUint16(ifd, little);
  for (let i = 0; i < entries; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (view.getUint16(entry, little) !== EXIF_ORIENTATION_TAG) continue;
    const orientation = view.getUint16(entry + 8, little);
    return view.getUint16(entry + 2, little) === TIFF_SHORT && orientation >= 1 && orientation <= 8 ? orientation : 1;
  }
  return 1;
}

function rasterize(svg: string, width: number) {
  return new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    background: "white",
    font: { loadSystemFonts: true },
  }).render();
}

function viewBox(svg: string): Box | undefined {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const values = /\sviewBox="([^"]+)"/.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (!values || values.length !== 4 || values.some((value) => !Number.isFinite(value))) return undefined;
  const [x, y, width, height] = values as [number, number, number, number];
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}
