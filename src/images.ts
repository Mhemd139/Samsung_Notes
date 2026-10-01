import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { NoteError } from "./errors.js";

export const IMAGE_WIDTH = 1200;
export const MAX_IMAGE_BYTES = 600_000;
export const MAX_IMAGE_EDGE = 1568;
const MAX_SINGLE_PART_RATIO = 2;
const PART_RATIO = 1.5;
const JPEG_QUALITY = 80;
const SHRINK_STEP = 0.8;
const MIN_IMAGE_EDGE = 200;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function svgToPng(svg: string, width = IMAGE_WIDTH): Uint8Array {
  return rasterize(svg, width).asPng();
}

export function pageParts(svg: string): number {
  const box = viewBox(svg);
  if (!box || box.height <= box.width * MAX_SINGLE_PART_RATIO) return 1;
  return Math.ceil(box.height / (box.width * PART_RATIO));
}

export function renderPage(svg: string, part: number): Uint8Array {
  const box = viewBox(svg);
  if (!box || pageParts(svg) === 1) return svgToPng(svg);
  const partHeight = box.width * PART_RATIO;
  const top = box.y + (part - 1) * partHeight;
  const height = Math.min(partHeight, box.y + box.height - top);
  const sliced = svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\sviewBox="[^"]*"/, ` viewBox="${box.x} ${top} ${box.width} ${height}"`)
      .replace(/\swidth="[^"]*"/, ` width="${box.width}"`)
      .replace(/\sheight="[^"]*"/, ` height="${height}"`),
  );
  return svgToPng(sliced);
}

export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
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

export function imageForClaude(bytes: Uint8Array, mimeType: string, maxBytes = MAX_IMAGE_BYTES): { data: Uint8Array; mimeType: string } {
  if (bytes.length <= maxBytes) return { data: bytes, mimeType };
  const size = imageSize(bytes);
  if (!size) throw new NoteError(`This image is too large to send (${(bytes.length / 1e6).toFixed(1)} MB).`);
  const longEdge = Math.max(size.width, size.height);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size.width}" height="${size.height}">` +
    `<image width="${size.width}" height="${size.height}" xlink:href="data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}"/></svg>`;
  let edge = Math.min(MAX_IMAGE_EDGE, longEdge);
  while (edge >= MIN_IMAGE_EDGE) {
    const rendered = rasterize(svg, Math.round((size.width * edge) / longEdge));
    const data = encodeJpeg(rendered.width, rendered.height, rendered.pixels);
    if (data.length <= maxBytes) return { data, mimeType: "image/jpeg" };
    edge = Math.floor(edge * Math.min(SHRINK_STEP, Math.sqrt(maxBytes / data.length)));
  }
  throw new NoteError(`This image is too large to send (${(bytes.length / 1e6).toFixed(1)} MB).`);
}

export const encodeJpeg = (width: number, height: number, rgba: Uint8Array): Uint8Array =>
  jpeg.encode({ width, height, data: rgba }, JPEG_QUALITY).data;

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
