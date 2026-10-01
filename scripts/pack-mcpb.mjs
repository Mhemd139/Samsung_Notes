// Builds samsung-notes-mcp-<version>.mcpb with native resvg binaries for every Claude Desktop platform.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

const RESVG_PLATFORMS = ["win32-x64-msvc", "win32-arm64-msvc", "darwin-x64", "darwin-arm64"];
const STAGE = "build/mcpb";
const NATIVE = "build/native";

const run = (command, cwd = ".") => execSync(command, { cwd, stdio: "inherit" });
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const resvgVersion = JSON.parse(readFileSync("node_modules/@resvg/resvg-js/package.json", "utf8")).version;

run("npm run build");
rmSync("build", { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const path of ["dist", "package.json", "package-lock.json", "manifest.json", "README.md", "LICENSE"]) {
  cpSync(path, `${STAGE}/${path}`, { recursive: true });
}
writeFileSync(`${STAGE}/icon.png`, new Resvg(readFileSync("assets/icon.svg", "utf8"), { fitTo: { mode: "width", value: 512 } }).render().asPng());
run("npm ci --omit=dev --omit=optional --ignore-scripts", STAGE);
// npm skips other platforms' binaries inside the stage even with --force, so fetch them in a scratch folder and copy them in.
run(`npm install --prefix ${NATIVE} --no-save --force --ignore-scripts ${RESVG_PLATFORMS.map((p) => `@resvg/resvg-js-${p}@${resvgVersion}`).join(" ")}`);
cpSync(`${NATIVE}/node_modules/@resvg`, `${STAGE}/node_modules/@resvg`, { recursive: true });
run("npx --yes @anthropic-ai/mcpb@2.1.2 validate manifest.json", STAGE);
run(`npx --yes @anthropic-ai/mcpb@2.1.2 pack . ../../samsung-notes-mcp-${pkg.version}.mcpb`, STAGE);
