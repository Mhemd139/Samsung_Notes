import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));

// The privacy promise, enforced by the browser: the page may load only its own files and can send data nowhere.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace("<!-- csp -->", `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`),
  };
}

// Only for link previews on other sites; the app never shows it.
const NOT_PRECACHED = new Set(["og.png"]);

// Precaches every built file so the app opens offline. The version hashes the file list, the page and the public
// files' contents, so any deploy that changes what users get installs a new worker.
function serviceWorker(): Plugin {
  return {
    name: "service-worker",
    apply: "build",
    generateBundle(_, bundle) {
      const publicFiles = readdirSync(`${root}public`, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !NOT_PRECACHED.has(entry.name))
        .map((entry) => entry.name);
      const built = Object.keys(bundle).filter((file) => file !== "index.html");
      const files = ["./", ...[...built, ...publicFiles].map((file) => `./${file}`)];
      const hash = createHash("sha256").update(files.join("\n"));
      const page = bundle["index.html"];
      if (page?.type === "asset") hash.update(page.source);
      for (const name of publicFiles) hash.update(readFileSync(`${root}public/${name}`));
      const source = readFileSync(`${root}sw.js`, "utf8")
        .replace("__VERSION__", hash.digest("hex").slice(0, 12))
        .replace("__FILES__", JSON.stringify(files));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  root,
  base: "./",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", assetsInlineLimit: 0 },
  server: { fs: { allow: [`${root}..`] } },
  plugins: [contentSecurityPolicy(), serviceWorker()],
});
