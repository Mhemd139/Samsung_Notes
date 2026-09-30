import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const fixturePath = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export const fixtureBytes = (name: string): Uint8Array => readFileSync(fixturePath(name));

export const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), `${prefix}-`));
