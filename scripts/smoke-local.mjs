// Local-only: checks the built server against YOUR notes and prints counts, never content.
import { Catalog } from "../dist/catalog.js";
import { resolveSources } from "../dist/config.js";
import { renderPageSvg } from "../dist/sdocx.js";
import { renderPage } from "../dist/images.js";

const started = performance.now();
const catalog = new Catalog(() => resolveSources(process.env, process.argv.slice(2)));
await catalog.refresh();
const overview = catalog.overview();
console.log("sources:", overview.sources.map((s) => `${s.name}: ${s.notes}`).join("; ") || "none");
console.log("totals:", overview.totals, `| folders: ${overview.folders.length}`);
console.log(`first load: ${Math.round(performance.now() - started)} ms`);
console.log("problems:", overview.problems.length);
const { notes } = catalog.list({ limit: overview.totals.notes, offset: 0 });
console.log("readable notes without a date:", notes.filter((n) => !n.problem && n.modifiedMs === null).length);
const withPages = notes.find((n) => n.pageCount > 0 && !n.problem);
if (withPages) {
  const t = performance.now();
  const png = renderPage(renderPageSvg(await catalog.ref(withPages.id).fullBytes(), 0), 1);
  console.log(`page render: ${png.length} bytes in ${Math.round(performance.now() - t)} ms`);
}
