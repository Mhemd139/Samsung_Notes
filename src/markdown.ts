export interface ExportedFile {
  name: string;
  path: string;
}

export interface MarkdownNote {
  title: string;
  heading?: string;
  text: string;
  createdMs: number | null;
  modifiedMs: number | null;
  pdf?: string;
  files: ExportedFile[];
}

const IMAGE_FILE = /\.(jpe?g|png|gif|webp|bmp|heic)$/i;
const IMAGE_MARKER = /\[image: ([^\]\n]+)\]/g;

// Front matter keeps the note's dates for Obsidian, Notion and other Markdown apps.
export function noteMarkdown(note: MarkdownNote): string {
  const linked = new Set<string>();
  const body = note.text.replace(IMAGE_MARKER, (marker, name: string) => {
    const file = note.files.find((candidate) => candidate.name === name);
    if (!file) return marker;
    linked.add(name);
    return `![](<${file.path}>)`;
  });
  const others = note.files
    .filter((file) => !linked.has(file.name))
    .map((file) => (IMAGE_FILE.test(file.path) ? `![](<${file.path}>)` : `- [${escapeLabel(file.name)}](<${file.path}>)`));
  return [
    "---",
    `title: ${JSON.stringify(note.title)}`,
    ...(note.createdMs === null ? [] : [`created: ${new Date(note.createdMs).toISOString()}`]),
    ...(note.modifiedMs === null ? [] : [`modified: ${new Date(note.modifiedMs).toISOString()}`]),
    "---",
    ...(note.heading ? ["", `# ${note.heading}`] : []),
    ...(body ? ["", body] : []),
    ...(note.pdf ? ["", `[${escapeLabel(note.pdf)}](<${note.pdf}>)`] : []),
    ...(others.length ? ["", ...others] : []),
    "",
  ].join("\n");
}

const escapeLabel = (label: string): string => label.replace(/[[\]\\]/g, "\\$&");
