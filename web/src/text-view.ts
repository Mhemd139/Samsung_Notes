const FENCE = "```";
const MEDIA_ID_PREFIX = /^\d+@/;
const IMAGE_LINE = /^\[image: ([^\]]+)\]$/;
const CELL_SPLIT = /(?<!\\)\|/;

// Turns the note's text (paragraphs, Markdown tables, code blocks, image markers) into safe DOM: no HTML from the note is ever parsed.
export function renderNoteText(text: string, imageUrl: (name: string) => string | undefined): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith(FENCE)) {
      const end = lines.indexOf(FENCE, i + 1);
      const stop = end === -1 ? lines.length : end;
      fragment.append(element("pre", element("code", lines.slice(i + 1, stop).join("\n"))));
      i = stop + 1;
    } else if (line.startsWith("|")) {
      const start = i;
      while (i < lines.length && lines[i]!.startsWith("|")) i++;
      fragment.append(table(lines.slice(start, i)));
    } else if (IMAGE_LINE.test(line)) {
      const name = IMAGE_LINE.exec(line)![1]!;
      const url = imageUrl(name);
      fragment.append(url ? element("figure", Object.assign(document.createElement("img"), { src: url, alt: displayName(name) })) : element("p", line));
      i++;
    } else if (line.trim()) {
      const start = i;
      while (i < lines.length && lines[i]!.trim() && !isBlockStart(lines[i]!)) i++;
      const paragraph = document.createElement("p");
      lines.slice(start, i).forEach((text, index) => paragraph.append(...(index ? [document.createElement("br"), text] : [text])));
      fragment.append(paragraph);
    } else {
      i++;
    }
  }
  return fragment;
}

// Samsung Notes prefixes attachment names with a media number, such as "0@scan.pdf".
export const displayName = (name: string): string => name.replace(MEDIA_ID_PREFIX, "");

const isBlockStart = (line: string): boolean => line.startsWith(FENCE) || line.startsWith("|") || IMAGE_LINE.test(line);

function table(rows: string[]): HTMLElement {
  const cells = rows
    .filter((row) => !/^\|(\s*:?-+:?\s*\|)+\s*$/.test(row))
    .map((row) => row.trim().replace(/^\||\|$/g, "").split(CELL_SPLIT).map((cell) => cell.trim().replaceAll("\\|", "|")));
  const [head = [], ...body] = cells;
  const wrap = element(
    "div",
    element(
      "table",
      element("thead", element("tr", ...head.map((cell) => element("th", cell)))),
      element("tbody", ...body.map((row) => element("tr", ...row.map((cell) => element("td", cell))))),
    ),
  );
  wrap.className = "table-wrap";
  return wrap;
}

function element(tag: string, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  node.append(...children);
  return node;
}
