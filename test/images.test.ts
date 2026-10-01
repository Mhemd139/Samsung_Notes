import { randomBytes } from "node:crypto";
import { decode, encode } from "fast-png";
import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { IMAGE_WIDTH, imageForClaude, imageSize, MAX_IMAGE_BYTES, MAX_IMAGE_EDGE, pageParts, renderPage, svgToPng } from "../src/images.js";
import { renderPageSvg } from "../src/sdocx.js";
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

describe("svgToPng", () => {
  it("renders a real note page at the standard width", () => {
    const png = svgToPng(renderPageSvg(fixtureBytes("04-marker4-highlighter.sdocx"), 0));
    expect(imageSize(png)?.width).toBe(IMAGE_WIDTH);
  });
});

describe("tall pages", () => {
  it("keeps normal pages whole", () => {
    expect(pageParts(tallSvg(100, 141))).toBe(1);
    expect(pageParts(tallSvg(100, 200))).toBe(1);
  });

  it("slices tall pages into readable parts", () => {
    const svg = tallSvg(100, 1000);
    expect(pageParts(svg)).toBe(7);
    expect(imageSize(renderPage(svg, 1))).toEqual({ width: IMAGE_WIDTH, height: 1800 });
    const last = renderPage(svg, 7);
    expect(imageSize(last)).toEqual({ width: IMAGE_WIDTH, height: 1200 });
    expect(pixel(last, 600, 1150)).toEqual([0, 0, 255]);
  });

  it("treats SVG without a viewBox as one part", () => {
    expect(pageParts('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="100"/>')).toBe(1);
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

  it("fits a smaller budget when asked", () => {
    expect(imageForClaude(big, "image/png", 100_000).data.length).toBeLessThanOrEqual(100_000);
  });
});
