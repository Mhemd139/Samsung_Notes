// Renders the web app's icons and social card from assets/icon.svg. Run after changing the icon: node scripts/web-icons.mjs
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const OUT = "web/public";
const BLUE = "#2343C2";
const icon = readFileSync("assets/icon.svg", "utf8");
const artwork = icon.replace(/<svg[^>]*>|<\/svg>|<rect x="32"[^>]*\/>/g, "");

// Maskable and Apple icons need a full-bleed background with the artwork inside the central safe zone.
const fullBleed = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="${BLUE}"/><g transform="translate(256 256) scale(0.8) translate(-256 -256)">${artwork}</g></svg>`;

const socialCard = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs><linearGradient id="sky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16287a"/><stop offset="1" stop-color="#2f56e6"/></linearGradient></defs>
  <rect width="1200" height="630" fill="url(#sky)"/>
  <g transform="translate(70 125) scale(0.74)">${icon.replace(/<svg[^>]*>|<\/svg>/g, "")}</g>
  <g font-family="Segoe UI, Helvetica, Arial, sans-serif" fill="#ffffff">
    <text x="510" y="262" font-size="104" font-weight="700" letter-spacing="-2">Inkport</text>
    <text x="514" y="336" font-size="44" font-weight="600" fill-opacity="0.95">Your Samsung Notes, anywhere.</text>
    <text x="514" y="404" font-size="29" fill-opacity="0.8">Open .sdocx on any device · Markdown and PDF</text>
    <text x="514" y="446" font-size="29" fill-opacity="0.8">Share with any AI · Private, nothing is uploaded</text>
  </g>
</svg>`;

const render = (svg, width) =>
  new Resvg(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: true } }).render().asPng();

copyFileSync("assets/icon.svg", `${OUT}/icon.svg`);
writeFileSync(`${OUT}/icon-192.png`, render(icon, 192));
writeFileSync(`${OUT}/icon-512.png`, render(icon, 512));
writeFileSync(`${OUT}/icon-maskable-512.png`, render(fullBleed, 512));
writeFileSync(`${OUT}/apple-touch-icon.png`, render(fullBleed, 180));
writeFileSync(`${OUT}/og.png`, render(socialCard, 1200));
