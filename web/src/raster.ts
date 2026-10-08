import type { PdfImage } from "../../src/pdfWriter";

const SHEET_PIXEL_WIDTH = 1400;
const MAX_CANVAS_PIXELS = 16_000_000;
const JPEG_QUALITY = 0.82;

// The browser draws the page, so every script, emoji and stroke comes out exactly as on screen.
export async function svgToJpeg(svg: string, width: number, height: number, pixelWidth = SHEET_PIXEL_WIDTH): Promise<PdfImage> {
  const scale = Math.min(pixelWidth / width, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser can't draw pages.");
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);
  }
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
