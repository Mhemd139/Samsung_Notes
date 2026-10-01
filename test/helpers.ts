import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, zipSync } from "fflate";

export const fixturePath = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

export const fixtureBytes = (name: string): Uint8Array => readFileSync(fixturePath(name));

export const rezipFixture = (name: string, change: (files: Record<string, Uint8Array>) => void): Uint8Array => {
  const files = unzipSync(fixtureBytes(name));
  change(files);
  return zipSync(files);
};

export const withoutDates = (name: string): Uint8Array =>
  rezipFixture(name, (files) => {
    delete files["end_tag.bin"];
  });

export const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), `${prefix}-`));
