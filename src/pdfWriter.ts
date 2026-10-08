export interface PdfImage {
  jpeg: Uint8Array;
  width: number;
  height: number;
}

export interface PdfInfo {
  title: string;
  createdMs?: number | null;
  modifiedMs?: number | null;
}

const PORTRAIT_WIDTH_PT = 595.28;
const LANDSCAPE_WIDTH_PT = 841.89;
const BINARY_MARKER = new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);
const FIRST_PAGE_OBJECT = 4;
const OBJECTS_PER_PAGE = 3;
const encoder = new TextEncoder();

// One JPEG per page, drawn full-bleed: every script and handwriting survive because the browser or resvg already drew them.
export function buildPdf(images: PdfImage[], info: PdfInfo): Uint8Array {
  if (!images.length) throw new Error("A PDF needs at least one page.");
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const write = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, ...parts: (string | Uint8Array)[]) => {
    offsets[id] = length;
    write(`${id} 0 obj\n`);
    parts.forEach(write);
    write("\nendobj\n");
  };

  write("%PDF-1.4\n");
  write(BINARY_MARKER);
  const pageIds = images.map((_, i) => FIRST_PAGE_OBJECT + i * OBJECTS_PER_PAGE);
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${images.length} >>`);
  object(3, `<< /Title ${pdfText(info.title)} /Producer (Inkport)${pdfDate("CreationDate", info.createdMs)}${pdfDate("ModDate", info.modifiedMs)} >>`);
  images.forEach((image, i) => {
    const pageId = pageIds[i]!;
    const widthPt = points(image.width > image.height ? LANDSCAPE_WIDTH_PT : PORTRAIT_WIDTH_PT);
    const heightPt = points((Number(widthPt) * image.height) / image.width);
    const content = `q ${widthPt} 0 0 ${heightPt} 0 0 cm /Im0 Do Q`;
    object(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Resources << /XObject << /Im0 ${pageId + 1} 0 R >> >> /Contents ${pageId + 2} 0 R >>`,
    );
    object(
      pageId + 1,
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.jpeg.length} >>\nstream\n`,
      image.jpeg,
      "\nendstream",
    );
    object(pageId + 2, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  const xref = length;
  const size = FIRST_PAGE_OBJECT + images.length * OBJECTS_PER_PAGE;
  write(`xref\n0 ${size}\n0000000000 65535 f \n`);
  for (let id = 1; id < size; id++) write(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  write(`trailer\n<< /Size ${size} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const pdf = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    pdf.set(chunk, at);
    at += chunk.length;
  }
  return pdf;
}

const points = (value: number): string => String(Math.round(value * 100) / 100);

const pdfText = (value: string): string =>
  `<FEFF${Array.from({ length: value.length }, (_, i) => value.charCodeAt(i).toString(16).padStart(4, "0")).join("")}>`;

const pdfDate = (key: string, ms: number | null | undefined): string =>
  ms === null || ms === undefined ? "" : ` /${key} (D:${new Date(ms).toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z)`;
