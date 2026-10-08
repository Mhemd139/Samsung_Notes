import { randomBytes } from "node:crypto";
import { decode, encode } from "fast-png";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import {
  attachmentParts,
  IMAGE_WIDTH,
  imageForClaude,
  imageParts,
  imageSize,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  renderPage,
  svgToPng,
} from "../src/images.js";
import { renderPageSvg } from "../src/sdocx.js";
import { cropToInk, pageParts, partBand } from "../src/svg.js";
import { fixtureBytes } from "./helpers.js";

const tallSvg = (width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
  `<rect x="0" y="0" width="${width}" height="${height}" fill="white"/>` +
  `<rect x="0" y="${height - 50}" width="${width}" height="50" fill="#0000ff"/></svg>`;

const pixel = (png: Uint8Array, x: number, y: number) => {
  const image = decode(png);
  const at = (y * image.width + x) * image.channels;
  return [...image.data.slice(at, at + 3)];
};

type Rgb = readonly [number, number, number];

const RED: Rgb = [255, 0, 0];
const GREEN: Rgb = [0, 255, 0];
const BLUE: Rgb = [0, 0, 255];
const YELLOW: Rgb = [255, 255, 0];
const WHITE: Rgb = [255, 255, 255];
const PNG_HEADER_BYTES = 33;
const EXIF_ID = Buffer.from("Exif\0\0", "latin1");

const paintedRgba = (width: number, height: number, colourAt: (x: number, y: number) => Rgb): Buffer => {
  const data = Buffer.alloc(width * height * 4, 255);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(colourAt(x, y), (y * width + x) * 4);
  }
  return data;
};

const paintedJpeg = (width: number, height: number, colourAt: (x: number, y: number) => Rgb): Uint8Array =>
  jpeg.encode({ width, height, data: paintedRgba(width, height, colourAt) }, 90).data;

const paintedPng = (width: number, height: number, colourAt: (x: number, y: number) => Rgb): Uint8Array =>
  encode({ width, height, data: paintedRgba(width, height, colourAt), channels: 4 });

const noisyJpeg = (width: number, height: number): Uint8Array => jpeg.encode({ width, height, data: randomBytes(width * height * 4) }, 80).data;

const colourName = (r: number, g: number, b: number): string => {
  if (r > 200 && g < 60 && b < 60) return "red";
  if (g > 200 && r < 60 && b < 60) return "green";
  if (b > 200 && r < 60 && g < 60) return "blue";
  if (r > 200 && g > 200 && b < 60) return "yellow";
  return `rgb(${r}, ${g}, ${b})`;
};

const quadrantColours = (photo: Uint8Array): string[] => {
  const { width, height, data } = jpeg.decode(photo);
  return [[1, 1], [3, 1], [1, 3], [3, 3]].map(([quarterX, quarterY]) => {
    const at = (Math.floor((height * quarterY!) / 4) * width + Math.floor((width * quarterX!) / 4)) * 4;
    return colourName(data[at]!, data[at + 1]!, data[at + 2]!);
  });
};

const app1 = (body: Buffer): Buffer => {
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([header, body]);
};

const exifSegment = (orientation: number, byteOrder: "II" | "MM" = "II"): Buffer => {
  const little = byteOrder === "II";
  const tiff = Buffer.alloc(38);
  const put16 = (value: number, at: number) => (little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
  const put32 = (value: number, at: number) => (little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
  tiff.write(byteOrder, 0, "latin1");
  put16(42, 2); // TIFF magic
  put32(8, 4); // IFD0 starts right after this 8-byte header
  put16(2, 8); // two entries
  put16(0x010f, 10); // entry 1, tag: Make (unrelated, the reader must skip it)
  put16(2, 12); // type: ASCII
  put32(1, 14); // count
  put16(0x0112, 22); // entry 2, tag: Orientation
  put16(3, 24); // type: SHORT
  put32(1, 26); // count
  put16(orientation, 30); // value
  return app1(Buffer.concat([EXIF_ID, tiff]));
};

const withSegment = (photo: Uint8Array, segment: Buffer): Buffer => Buffer.concat([photo.subarray(0, 2), segment, photo.subarray(2)]);

describe("svgToPng", () => {
  it("renders a real note page at the standard width", () => {
    const png = svgToPng(renderPageSvg(fixtureBytes("04-marker4-highlighter.sdocx"), 0).svg);
    expect(imageSize(png)?.width).toBe(IMAGE_WIDTH);
  });
});

describe("tall pages", () => {
  it("keeps pages up to 1.66 times as tall as wide whole, under 2000 px at the standard width", () => {
    expect(pageParts(tallSvg(100, 141))).toBe(1);
    expect(pageParts(tallSvg(100, 166))).toBe(1);
    expect(imageSize(renderPage(tallSvg(100, 166), 1))).toEqual({ width: IMAGE_WIDTH, height: 1992 });
  });

  it("splits a page 1.9 times as tall as wide into parts that fit the image limits", () => {
    const svg = tallSvg(100, 190);
    expect(pageParts(svg)).toBe(2);
    expect(imageSize(renderPage(svg, 1))).toEqual({ width: IMAGE_WIDTH, height: 1800 });
    expect(imageSize(renderPage(svg, 2))).toEqual({ width: IMAGE_WIDTH, height: 1800 });
  });

  it("slices tall pages into readable parts", () => {
    const svg = tallSvg(100, 1000);
    expect(pageParts(svg)).toBe(8);
    expect(imageSize(renderPage(svg, 1))).toEqual({ width: IMAGE_WIDTH, height: 1800 });
    const last = renderPage(svg, 8);
    expect(imageSize(last)).toEqual({ width: IMAGE_WIDTH, height: 1800 });
    expect(pixel(last, 600, 1700)).toEqual([0, 0, 255]);
  });

  it.each<[string, number, number, (width: number, height: number) => number, number]>([
    ["a page just over 1.66:1", 1000, 1661, (width, height) => pageParts(tallSvg(width, height)), 2],
    ["a photo just over 2.5:1", 1000, 2501, attachmentParts, 2],
    ["a photo one pixel over 1568 px", 600, 1569, attachmentParts, 2],
    ["the tallest photo two parts cover", 1000, 2900, attachmentParts, 2],
    ["a photo one pixel taller", 1000, 2901, attachmentParts, 3],
    ["a scroll screenshot", 1080, 5400, attachmentParts, 4],
  ])("cuts %s into full-size parts that overlap by at least a tenth of the width", (_, width, height, count, expected) => {
    const parts = count(width, height);
    expect(parts).toBe(expected);
    const bands = Array.from({ length: parts }, (_, i) => partBand(width, height, i + 1, parts));
    expect(bands[0]!.top).toBe(0);
    expect(bands[parts - 1]!.top + bands[parts - 1]!.height).toBeCloseTo(height, 9);
    for (const band of bands) expect(band.height).toBe(width * 1.5);
    for (let i = 1; i < parts; i++) {
      expect(bands[i - 1]!.top + bands[i - 1]!.height - bands[i]!.top).toBeGreaterThanOrEqual(width * 0.1 - 1e-9);
    }
  });

  it("treats SVG without a viewBox as one part", () => {
    expect(pageParts('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="100"/>')).toBe(1);
  });
});

describe("cropToInk", () => {
  const memo = tallSvg(100, 14_100);

  it("cuts a tall page a tenth of its width below the ink", () => {
    const cropped = cropToInk(memo, 160);
    expect(pageParts(cropped)).toBe(2);
    expect(cropped).toContain('viewBox="0 0 100 170"');
    expect(imageSize(renderPage(cropped, 2))).toEqual({ width: IMAGE_WIDTH, height: 1800 });
  });

  it("never cuts above one part's height", () => {
    const cropped = cropToInk(memo, 20);
    expect(pageParts(cropped)).toBe(1);
    expect(imageSize(renderPage(cropped, 1))).toEqual({ width: IMAGE_WIDTH, height: 1800 });
  });

  it.each<[string, string, number | undefined]>([
    ["a page that fits one part", tallSvg(100, 160), 10],
    ["a page inked to the bottom", memo, 14_100],
    ["a page with other content", memo, undefined],
  ])("leaves %s whole", (_, svg, inkBottom) => {
    expect(cropToInk(svg, inkBottom)).toBe(svg);
  });
});

describe("tall attachments", () => {
  const rgbAt = (photo: Uint8Array, x: number, y: number): Rgb => {
    const { width, data } = jpeg.decode(photo);
    const at = (y * width + x) * 4;
    return [data[at]!, data[at + 1]!, data[at + 2]!];
  };

  it("keeps phone screenshots whole, and tall images Claude sees at full size anyway", () => {
    expect(imageParts(paintedPng(1080, 2400, () => WHITE))).toBe(1);
    expect(imageParts(paintedPng(1000, 2500, () => WHITE))).toBe(1);
    expect(imageParts(paintedPng(100, 1000, () => WHITE))).toBe(1);
    expect(imageParts(paintedPng(600, MAX_IMAGE_EDGE, () => WHITE))).toBe(1);
    expect(imageParts(paintedPng(600, MAX_IMAGE_EDGE + 1, () => WHITE))).toBe(2);
  });

  it("treats a header with zero width as one part", () => {
    const broken = Uint8Array.from(paintedPng(10, 3000, () => WHITE));
    broken.fill(0, 16, 20);
    expect(imageParts(broken)).toBe(1);
  });

  const scroll = paintedPng(1080, 5400, (_, y) => (y < 100 ? RED : y >= 5300 ? BLUE : WHITE));

  it("shrinks a tall image whole when no part is asked for", () => {
    const size = imageSize(imageForClaude(scroll, "image/png").data)!;
    expect(size.width / size.height).toBeCloseTo(1080 / 5400, 2);
  });

  it("splits a scroll screenshot into overlapping parts", () => {
    expect(imageParts(scroll)).toBe(4);
    for (const part of [1, 4]) {
      const size = imageSize(imageForClaude(scroll, "image/png", MAX_IMAGE_BYTES, part).data)!;
      expect(size.height).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
      expect(size.width / size.height).toBeCloseTo(1 / 1.5, 2);
    }
    expect(colourName(...rgbAt(imageForClaude(scroll, "image/png", MAX_IMAGE_BYTES, 1).data, 500, 30))).toBe("red");
    expect(colourName(...rgbAt(imageForClaude(scroll, "image/png", MAX_IMAGE_BYTES, 4).data, 500, 1530))).toBe("blue");
  });

  it("splits a tall photo after turning it upright", () => {
    const photo = withSegment(paintedJpeg(3000, 600, (x) => (x < 100 ? RED : WHITE)), exifSegment(6));
    expect(imageParts(photo)).toBe(4);
    const first = imageForClaude(photo, "image/jpeg", MAX_IMAGE_BYTES, 1).data;
    expect(imageSize(first)).toEqual({ width: 600, height: 900 });
    expect(colourName(...rgbAt(first, 300, 30))).toBe("red");
    expect(Math.min(...rgbAt(first, 300, 600))).toBeGreaterThan(240);
  });

  it("returns a blank part of a large image instead of calling it damaged", () => {
    const rgba = randomBytes(400 * 2000 * 4);
    rgba.fill(255, 400 * 600 * 4);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const tall = encode({ width: 400, height: 2000, data: rgba, channels: 4 });
    expect(tall.length).toBeGreaterThan(100_000);
    expect(imageParts(tall)).toBe(4);
    expect(imageSize(imageForClaude(tall, "image/png", 100_000, 4).data)).toEqual({ width: 400, height: 600 });
  });
});

describe("imageSize", () => {
  it("reads PNG and JPEG dimensions", () => {
    const rgba = new Uint8Array(40 * 30 * 4).fill(200);
    expect(imageSize(encode({ width: 40, height: 30, data: rgba, channels: 4 }))).toEqual({ width: 40, height: 30 });
    expect(imageSize(jpeg.encode({ data: Buffer.from(rgba), width: 40, height: 30 }, 80).data)).toEqual({ width: 40, height: 30 });
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});

describe("imageForClaude", () => {
  const [width, height] = [2400, 1800];
  const noise = randomBytes(width * height * 4);
  for (let i = 3; i < noise.length; i += 4) noise[i] = 255;
  const big = encode({ width, height, data: noise, channels: 4 });

  it("passes small images through untouched", () => {
    const png = fixtureBytes("03-image-placement.sdocx").slice(0, 10);
    expect(imageForClaude(png, "image/png")).toEqual({ data: png, mimeType: "image/png" });
  });

  it("shrinks large photos into a JPEG under the limit, keeping their shape", () => {
    expect(big.length).toBeGreaterThan(MAX_IMAGE_BYTES);
    const result = imageForClaude(big, "image/png");
    const size = imageSize(result.data)!;
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES);
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(size.width / size.height).toBeCloseTo(width / height, 2);
  });

  it("re-encodes a phone screenshot that fits the byte limit but is 2400 px tall", () => {
    const screenshot = paintedPng(1080, 2400, (_, y) => (y < 240 ? BLUE : WHITE));
    expect(screenshot.length).toBeLessThan(MAX_IMAGE_BYTES);
    const result = imageForClaude(screenshot, "image/png");
    const size = imageSize(result.data)!;
    expect(result.mimeType).toBe("image/jpeg");
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
    expect(size.width / size.height).toBeCloseTo(1080 / 2400, 2);
  });

  it("passes a photo through at 2000 px on its long edge and re-encodes it at 2001", () => {
    const atLimit = paintedJpeg(2000, 100, () => BLUE);
    const overLimit = paintedJpeg(2001, 100, () => BLUE);
    expect(imageForClaude(atLimit, "image/jpeg").data).toBe(atLimit);
    expect(imageSize(imageForClaude(overLimit, "image/jpeg").data)!.width).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
  });

  it("fits a smaller budget when asked", () => {
    expect(imageForClaude(big, "image/png", 100_000).data.length).toBeLessThanOrEqual(100_000);
  });

  it("re-encodes a small image over the budget at its own size", () => {
    const small = encode({ width: 120, height: 80, data: randomBytes(120 * 80 * 4), channels: 4 });
    expect(small.length).toBeGreaterThan(30_000);
    const result = imageForClaude(small, "image/png", 30_000);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data.length).toBeLessThanOrEqual(30_000);
    expect(imageSize(result.data)).toEqual({ width: 120, height: 80 });
  });

  it("passes a blank page that fits the limit", () => {
    const blank = paintedJpeg(300, 400, () => WHITE);
    expect(imageForClaude(blank, "image/jpeg").data).toBe(blank);
  });

  it("returns a white screenshot that is only too tall instead of calling it damaged", () => {
    const blank = paintedPng(1080, 2400, () => WHITE);
    expect(blank.length).toBeLessThan(MAX_IMAGE_BYTES);
    const result = imageForClaude(blank, "image/png");
    const size = imageSize(result.data)!;
    expect(result.mimeType).toBe("image/jpeg");
    expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(MAX_IMAGE_EDGE);
  });

  const claimedPhoto = encode({ width: 1600, height: 1200, data: new Uint8Array(1600 * 1200 * 4), channels: 4 }).subarray(0, PNG_HEADER_BYTES);
  const garbagePng = new Uint8Array(150_000);
  garbagePng.set(claimedPhoto);
  const fullJpeg = noisyJpeg(500, 400);
  const truncatedJpeg = fullJpeg.subarray(0, Math.floor(fullJpeg.length * 0.6));

  it.each<[string, Uint8Array, string]>([
    ["a PNG with a valid header and a garbage body", garbagePng, "image/png"],
    ["a truncated JPEG", truncatedJpeg, "image/jpeg"],
  ])("refuses %s instead of sending a blank image", (_, bytes, mimeType) => {
    expect(bytes.length).toBeGreaterThan(100_000);
    expect(() => imageForClaude(bytes, mimeType, 100_000)).toThrow(
      "Couldn't read this image. The file may be damaged; open the note in Samsung Notes to check it.",
    );
  });
});

describe("photo orientation", () => {
  const twoColour = paintedJpeg(600, 300, (x) => (x < 300 ? RED : BLUE));
  const corners = [[RED, GREEN], [BLUE, YELLOW]] as const;
  const quadrants = paintedJpeg(400, 300, (x, y) => corners[y < 150 ? 0 : 1][x < 200 ? 0 : 1]);

  it("turns a photo tagged orientation 6 upright", () => {
    const result = imageForClaude(withSegment(twoColour, exifSegment(6)), "image/jpeg");
    expect(result.mimeType).toBe("image/jpeg");
    expect(imageSize(result.data)).toEqual({ width: 300, height: 600 });
    expect(quadrantColours(result.data)).toEqual(["red", "red", "blue", "blue"]);
  });

  it("reads big-endian Exif", () => {
    const result = imageForClaude(withSegment(twoColour, exifSegment(8, "MM")), "image/jpeg");
    expect(imageSize(result.data)).toEqual({ width: 300, height: 600 });
    expect(quadrantColours(result.data)).toEqual(["blue", "blue", "red", "red"]);
  });

  it("finds the Exif segment after another APP1 segment", () => {
    const xmp = app1(Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>", "latin1"));
    const result = imageForClaude(withSegment(twoColour, Buffer.concat([xmp, exifSegment(6)])), "image/jpeg");
    expect(imageSize(result.data)).toEqual({ width: 300, height: 600 });
    expect(quadrantColours(result.data)).toEqual(["red", "red", "blue", "blue"]);
  });

  it.each<[number, boolean, string[]]>([
    [1, false, ["red", "green", "blue", "yellow"]],
    [2, false, ["green", "red", "yellow", "blue"]],
    [3, false, ["yellow", "blue", "green", "red"]],
    [4, false, ["blue", "yellow", "red", "green"]],
    [5, true, ["red", "blue", "green", "yellow"]],
    [6, true, ["blue", "red", "yellow", "green"]],
    [7, true, ["yellow", "green", "blue", "red"]],
    [8, true, ["green", "yellow", "red", "blue"]],
  ])("draws orientation %i the right way up", (orientation, swaps, upright) => {
    const result = imageForClaude(withSegment(quadrants, exifSegment(orientation)), "image/jpeg");
    expect(imageSize(result.data)).toEqual(swaps ? { width: 300, height: 400 } : { width: 400, height: 300 });
    expect(quadrantColours(result.data)).toEqual(upright);
  });

  it.each<[string, Uint8Array]>([
    ["no Exif segment", twoColour],
    ["orientation 1", withSegment(twoColour, exifSegment(1))],
    ["an orientation outside 1 to 8", withSegment(twoColour, exifSegment(9))],
    ["an IFD offset past the segment end", withSegment(twoColour, app1(Buffer.concat([EXIF_ID, Buffer.from([0x49, 0x49, 0x2a, 0, 0xff, 0xff, 0, 0])])))],
    ["no TIFF header", withSegment(twoColour, app1(Buffer.concat([EXIF_ID, Buffer.from("not a TIFF header")])))],
  ])("leaves a photo untouched when it has %s", (_, photo) => {
    expect(imageForClaude(photo, "image/jpeg").data).toBe(photo);
  });

  it("returns a white photo that only needed turning instead of calling it damaged", () => {
    const blank = paintedJpeg(600, 300, () => WHITE);
    const result = imageForClaude(withSegment(blank, exifSegment(6)), "image/jpeg");
    expect(imageSize(result.data)).toEqual({ width: 300, height: 600 });
  });

  it("turns a photo smaller than the minimum edge upright at its own size", () => {
    const tiny = paintedJpeg(100, 60, (x) => (x < 50 ? RED : BLUE));
    const result = imageForClaude(withSegment(tiny, exifSegment(6)), "image/jpeg");
    expect(imageSize(result.data)).toEqual({ width: 60, height: 100 });
    expect(quadrantColours(result.data)).toEqual(["red", "red", "blue", "blue"]);
  });

  it("caps a large rotated photo at the maximum edge even when it fits the byte limit", () => {
    const wide = paintedJpeg(2000, 1000, (x) => (x < 1000 ? RED : BLUE));
    expect(wide.length).toBeLessThan(MAX_IMAGE_BYTES);
    const result = imageForClaude(withSegment(wide, exifSegment(6)), "image/jpeg");
    expect(imageSize(result.data)).toEqual({ width: 784, height: MAX_IMAGE_EDGE });
    expect(quadrantColours(result.data)).toEqual(["red", "red", "blue", "blue"]);
  });

  it("keeps a rotated photo upright while shrinking it to a smaller budget", () => {
    const result = imageForClaude(withSegment(noisyJpeg(600, 300), exifSegment(6)), "image/jpeg", 50_000);
    const size = imageSize(result.data)!;
    expect(result.data.length).toBeLessThanOrEqual(50_000);
    expect(size.height / size.width).toBeCloseTo(2, 1);
  });
});
