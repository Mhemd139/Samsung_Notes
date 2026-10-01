#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Catalog } from "./catalog.js";
import { resolveSaveRoot, resolveSources } from "./config.js";
import { createServer } from "./server.js";

console.log = console.info = console.debug = console.error;

const args = process.argv.slice(2);
const catalog = new Catalog(() => resolveSources(process.env, args));
let saveRoot: string | undefined;
await createServer(catalog, () => (saveRoot ??= resolveSaveRoot(process.env, args))).connect(new StdioServerTransport());
console.error("samsung-notes-mcp ready");
catalog.refresh().catch((err: unknown) => console.error("samsung-notes-mcp: first load failed:", err));
