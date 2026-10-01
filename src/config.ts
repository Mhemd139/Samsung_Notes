import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { exportsFolderSource } from "./sources/exportsFolder.js";
import type { NoteSource } from "./sources/types.js";
import { windowsAppSource } from "./sources/windowsApp.js";

export interface SourceSetup {
  sources: NoteSource[];
  problems: string[];
}

const APP_PACKAGE = /^SAMSUNGELECTRONICSCoLtd\.SamsungNotes_/i;
const DOCUMENTS_COMMAND = "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath('MyDocuments')";

export const NO_SOURCES_HELP = [
  "No Samsung Notes found.",
  "• Samsung Notes for Windows: open it once and sign in so your notes sync, then try again.",
  "• Any other computer: in the Samsung Notes phone app, select notes → Share → Samsung Notes file, save the .sdocx files into one folder on this computer, and choose that folder as “Exported notes folder” in the extension settings (or start the server with --exports <folder>).",
].join("\n");

export function resolveSources(
  env: NodeJS.ProcessEnv,
  argv: string[],
  platform: NodeJS.Platform = process.platform,
): SourceSetup {
  const sources: NoteSource[] = [];
  const appDir = setting(env.SAMSUNG_NOTES_APP_DIR) ?? (platform === "win32" ? findWindowsApp(env.LOCALAPPDATA) : undefined);
  if (appDir) sources.push(windowsAppSource(appDir));
  const exportsDir = setting(flagValue(argv, "--exports")) ?? setting(env.SAMSUNG_NOTES_EXPORTS_DIR);
  if (exportsDir) sources.push(exportsFolderSource(exportsDir));
  return { sources, problems: sources.length === 0 ? [NO_SOURCES_HELP] : [] };
}

export function resolveSaveRoot(env: NodeJS.ProcessEnv, argv: string[], platform: NodeJS.Platform = process.platform): string {
  return (
    setting(flagValue(argv, "--save-dir")) ??
    setting(env.SAMSUNG_NOTES_SAVE_DIR) ??
    join(documentsFolder(platform), "Samsung Notes")
  );
}

// Windows' real Documents folder, which OneDrive may have moved. reg.exe would garble non-ASCII paths (OEM code page).
function documentsFolder(platform: NodeJS.Platform): string {
  if (platform === "win32") {
    try {
      const folder = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", DOCUMENTS_COMMAND], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
      }).trim();
      if (!folder) throw new Error("PowerShell returned no folder");
      return folder;
    } catch (err) {
      console.error("samsung-notes-mcp: couldn't find the Documents folder; using ~/Documents:", err);
    }
  }
  return join(homedir(), "Documents");
}

function setting(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith("${")) return undefined;
  return resolve(trimmed.replace(/^~(?=$|[\\/])/, homedir()));
}

function flagValue(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

function findWindowsApp(localAppData: string | undefined): string | undefined {
  if (!localAppData) return undefined;
  const packages = join(localAppData, "Packages");
  if (!existsSync(packages)) return undefined;
  const match = readdirSync(packages).find((name) => APP_PACKAGE.test(name));
  return match ? join(packages, match, "LocalState") : undefined;
}
