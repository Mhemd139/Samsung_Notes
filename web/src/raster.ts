import type { PdfImage } from "../../src/core/pdfWriter";

const SHEET_PIXEL_WIDTH = 1400;
const PHOTO_PIXEL_SIDE = 2400;
const MAX_CANVAS_PIXELS = 16_000_000;
const JPEG_QUALITY = 0.82;

// The browser draws the page, so every script, emoji and stroke comes out exactly as on screen.
export async function svgToJpeg(svg: string, width: number, height: number, pixelWidth = SHEET_PIXEL_WIDTH): Promise<PdfImage> {
  const scale = Math.min(pixelWidth / width, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return draw(image, width * scale, height * scale);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Photos go into a PDF as JPEG; the long side is capped so a 50-megapixel camera shot stays a few hundred kilobytes.
export async function photoToJpeg(photo: Blob): Promise<PdfImage> {
  const bitmap = await createImageBitmap(photo);
  try {
    const scale = Math.min(1, PHOTO_PIXEL_SIDE / Math.max(bitmap.width, bitmap.height));
    return draw(bitmap, bitmap.width * scale, bitmap.height * scale);
  } finally {
    bitmap.close();
  }
}

function draw(source: CanvasImageSource, width: number, height: number): PdfImage {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser can't draw pages.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  // toDataURL encodes right away; toBlob waits for idle time, which Chrome grants a background tab about once a second.
  const jpeg = base64Bytes(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
  const page = { jpeg, width: canvas.width, height: canvas.height };
  canvas.width = canvas.height = 0;
  return page;
}

function base64Bytes(dataUrl: string): Uint8Array {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
