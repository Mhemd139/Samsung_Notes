const MAX_SINGLE_PART_RATIO = 1.66;
const PART_RATIO = 1.5;
const PART_OVERLAP_RATIO = 0.1;
const A4_RATIO = 297 / 210;
const SINGLE_SHEET_SLACK = 1.1;
const MIN_LAST_SHEET = 0.15;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function viewBox(svg: string): Box | undefined {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? "";
  const values = /\sviewBox="([^"]+)"/.exec(root)?.[1]?.trim().split(/[\s,]+/).map(Number);
  if (!values || values.length !== 4 || values.some((value) => !Number.isFinite(value))) return undefined;
  const [x, y, width, height] = values as [number, number, number, number];
  return width > 0 && height > 0 ? { x, y, width, height } : undefined;
}

export const withBand = (svg: string, box: Box, top: number, height: number): string =>
  svg.replace(/<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\sviewBox="[^"]*"/, ` viewBox="${box.x} ${top} ${box.width} ${height}"`)
      .replace(/\swidth="[^"]*"/, ` width="${box.width}"`)
      .replace(/\sheight="[^"]*"/, ` height="${height}"`),
  );

export function pageParts(svg: string): number {
  const box = viewBox(svg);
  return box ? partCount(box.width, box.height, MAX_SINGLE_PART_RATIO) : 1;
}

export function cropToInk(svg: string, inkBottom: number | undefined): string {
  const box = viewBox(svg);
  if (inkBottom === undefined || !box || pageParts(svg) === 1) return svg;
  const height = Math.max(inkBottom - box.y + box.width * PART_OVERLAP_RATIO, box.width * PART_RATIO);
  return height < box.height ? withBand(svg, box, box.y, height) : svg;
}

export function partBand(width: number, height: number, part: number, parts: number): { top: number; height: number } {
  if (parts === 1) return { top: 0, height };
  const partHeight = width * PART_RATIO;
  return { top: ((part - 1) * (height - partHeight)) / (parts - 1), height: partHeight };
}

// Printed sheets for one page: A4-tall cuts with no overlap, so a long scrolling page reads like a printout.
export function sheetBands(width: number, height: number): { top: number; height: number }[] {
  const sheet = width * A4_RATIO;
  if (height <= sheet * SINGLE_SHEET_SLACK) return [{ top: 0, height }];
  const bands: { top: number; height: number }[] = [];
  for (let top = 0; top < height; top += sheet) bands.push({ top, height: Math.min(sheet, height - top) });
  const last = bands.at(-1)!;
  if (last.height < sheet * MIN_LAST_SHEET) {
    bands.pop();
    bands.at(-1)!.height += last.height;
  }
  return bands;
}

export function partCount(width: number, height: number, maxSinglePartRatio: number): number {
  if (height <= width * maxSinglePartRatio) return 1;
  const overlap = width * PART_OVERLAP_RATIO;
  return Math.ceil((height - overlap) / (width * PART_RATIO - overlap));
}
