#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Catalog } from "./catalog.js";
import { resolveSources } from "./config.js";
import { createServer } from "./server.js";

console.log = console.info = console.debug = console.error;

const catalog = new Catalog(() => resolveSources(process.env, process.argv.slice(2)));
await createServer(catalog).connect(new StdioServerTransport());
console.error("samsung-notes-mcp ready");
catalog.refresh().catch((err: unknown) => console.error("samsung-notes-mcp: first load failed:", err));
