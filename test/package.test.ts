import { execSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeAll, describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/server.js";
import { fixturePath, tempDir } from "./helpers.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(root, file), "utf8")) as T;
const pkg = readJson<{ version: string; license: string }>("package.json");
const manifest = readJson<{
  version: string;
  license: string;
  tools: { name: string }[];
  server: { mcp_config: { args: string[] } };
}>("manifest.json");

beforeAll(() => {
  execSync("npm run build --silent", { cwd: root, stdio: "inherit" });
}, 120_000);

describe("manifest.json", () => {
  it("matches package.json and the server's tools", () => {
    expect(manifest.version).toBe(pkg.version);
    expect(manifest.license).toBe(pkg.license);
    expect(manifest.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES]);
    expect(manifest.server.mcp_config.args).toEqual(["${__dirname}/dist/index.js"]);
  });
});

describe("listings", () => {
  // A release publishes all of these at once, so a missed version bump would ship a mismatched listing.
  it("carry package.json's version and name", () => {
    const server = readJson<{ name: string; version: string; packages: { identifier: string; version: string }[] }>("server.json");
    const plugin = readJson<{ version: string }>(".claude-plugin/plugin.json");
    const { mcpName, name } = readJson<{ mcpName: string; name: string }>("package.json");
    expect([server.version, server.packages[0]!.version, plugin.version]).toEqual([pkg.version, pkg.version, pkg.version]);
    expect([server.name, server.packages[0]!.identifier]).toEqual([mcpName, name]);
  });
});

describe("built server over stdio", () => {
  it("starts, lists tools and reads an exported note", async () => {
    const noSamsungApp = tempDir("sn-package");
    const env: NodeJS.ProcessEnv = { ...process.env, LOCALAPPDATA: noSamsungApp };
    delete env.SAMSUNG_NOTES_APP_DIR;
    delete env.SAMSUNG_NOTES_EXPORTS_DIR;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist", "index.js"), "--exports", fixturePath("")],
      env: env as Record<string, string>,
      stderr: "pipe",
    });
    let serverLog = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      serverLog += chunk;
    });
    const client = new Client({ name: "stdio-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(TOOL_NAMES.length);
      const total = async (args: Record<string, unknown>): Promise<number> => {
        const result = (await client.callTool({ name: "list_notes", arguments: args })) as { content: { text: string }[] };
        return JSON.parse(result.content[0].text).total;
      };
      expect(await total({ query: "atlas" })).toBe(1);
      expect(await total({})).toBe(4);
    } catch (err) {
      console.error(`Server log:\n${serverLog}`);
      throw err;
    } finally {
      await client.close();
      rmSync(noSamsungApp, { recursive: true, force: true });
    }
  });
});
