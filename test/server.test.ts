import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { Catalog } from "../src/catalog.js";
import { imageSize } from "../src/images.js";
import { createServer, TOOL_NAMES } from "../src/server.js";
import { exportsFolderSource } from "../src/sources/exportsFolder.js";
import { windowsAppSource } from "../src/sources/windowsApp.js";
import { fixtureBytes, fixturePath, tempDir, withoutDates } from "./helpers.js";
import { BLUE_SQUARE_PAGE, makePdf, TEXT_PAGE } from "./pdfFixture.js";
import { makeLocalState } from "./windowsFixture.js";

type Block = { type: string; text?: string; data?: string; mimeType?: string };
const PHOTO = "0@paste_260914_153237_553.png";
const MAX_API_EDGE = 2000;
let client: Client;

async function connect(catalog: Catalog): Promise<Client> {
  const connected = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([createServer(catalog).connect(serverTransport), connected.connect(clientTransport)]);
  return connected;
}

async function call(name: string, args: Record<string, unknown> = {}, from: Client = client) {
  const result = (await from.callTool({ name, arguments: args })) as { content: Block[]; isError?: boolean };
  const size = result.content.reduce((sum, block) => sum + (block.data?.length ?? 0) + Buffer.byteLength(block.text ?? ""), 0);
  expect(size).toBeLessThan(1_000_000);
  for (const block of result.content.filter((b) => b.type === "image")) {
    const dimensions = imageSize(Buffer.from(block.data!, "base64"));
    expect(dimensions).toBeDefined();
    expect(Math.max(dimensions!.width, dimensions!.height)).toBeLessThanOrEqual(MAX_API_EDGE);
  }
  return { ...result, text: result.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") };
}

beforeAll(async () => {
  const root = tempDir("sn-server");
  mkdirSync(join(root, "Invoices"));
  const receipt = { ...unzipSync(fixtureBytes("03-image-placement.sdocx")), "media/7@invoice.pdf": makePdf([TEXT_PAGE, BLUE_SQUARE_PAGE]) };
  writeFileSync(join(root, "Invoices", "Receipt.sdocx"), zipSync(receipt));
  copyFileSync(fixturePath("01-basic-formatting.sdocx"), join(root, "basic.sdocx"));
  copyFileSync(fixturePath("04-marker4-highlighter.sdocx"), join(root, "marker.sdocx"));

  client = await connect(new Catalog(() => ({ sources: [exportsFolderSource(root)], problems: [] })));
});

describe("tools/list", () => {
  it("offers five read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });
});

describe("instructions", () => {
  it("tell the agent when to use every tool", () => {
    const instructions = client.getInstructions() ?? "";
    for (const name of TOOL_NAMES) expect(instructions).toContain(name);
  });
});

describe("notes_overview", () => {
  it("summarises the library", async () => {
    const { text } = await call("notes_overview");
    expect(text).toContain("Exported notes");
    expect(text).toContain("Invoices: 1");
    expect(text).toContain("3 notes");
  });
});

describe("list_notes", () => {
  const idsOf = (data: { notes: { id: string }[] }) => data.notes.map((n) => n.id).sort();

  it("searches and returns JSON with snippets", async () => {
    const data = JSON.parse((await call("list_notes", { query: "project atlas" })).text);
    expect(data.total).toBe(1);
    expect(data.notes[0]).toMatchObject({ id: "file:basic.sdocx", title: "01-basic-test", folder: "(no folder)" });
    expect(data.notes[0].snippet).toContain("Project Atlas");
  });

  it("filters by folder and lists attachment names", async () => {
    const data = JSON.parse((await call("list_notes", { folder: "Invoices" })).text);
    expect(data.notes[0].attachments).toEqual([PHOTO, "7@invoice.pdf"]);
  });

  it("filters by attachments", async () => {
    const withFiles = JSON.parse((await call("list_notes", { has_attachments: true })).text);
    const without = JSON.parse((await call("list_notes", { has_attachments: false })).text);
    expect(idsOf(withFiles)).toEqual(["file:Invoices/Receipt.sdocx"]);
    expect(idsOf(without)).toEqual(["file:basic.sdocx", "file:marker.sdocx"]);
  });

  it("finds notes with handwriting and names their pages", async () => {
    const data = JSON.parse((await call("list_notes", { has_handwriting: true })).text);
    expect(data.notes.map((n: { id: string }) => n.id)).toEqual(["file:marker.sdocx"]);
    expect(data.notes[0].handwriting_pages).toBe("1");
  });

  it("counts both dates as whole days", async () => {
    const found = JSON.parse((await call("list_notes", { query: "project atlas" })).text);
    const day: string = found.notes[0].modified;
    const sameDay = JSON.parse((await call("list_notes", { modified_after: day, modified_before: day })).text);
    expect(idsOf(sameDay)).toContain("file:basic.sdocx");
    const earlier = JSON.parse((await call("list_notes", { modified_before: "2000-01-01" })).text);
    expect(earlier.total).toBe(0);
  });

  it("pages through results with next_offset", async () => {
    const first = JSON.parse((await call("list_notes", { limit: 2 })).text);
    expect(first).toMatchObject({ total: 3, offset: 0, next_offset: 2 });
    expect(first.notes).toHaveLength(2);
    const last = JSON.parse((await call("list_notes", { limit: 2, offset: first.next_offset })).text);
    expect(last.notes).toHaveLength(1);
    expect(last.next_offset).toBeUndefined();
  });

  it("explains an empty result", async () => {
    const data = JSON.parse((await call("list_notes", { modified_after: "2099-01-01" })).text);
    expect(data.total).toBe(0);
    expect(data.hint).toMatch(/Handwriting isn't searchable/);
  });

  it("sends an empty library to notes_overview instead of blaming the filters", async () => {
    const empty = await connect(new Catalog(() => ({ sources: [], problems: [] })));
    const data = JSON.parse((await call("list_notes", { query: "invoice" }, empty)).text);
    expect(data.total).toBe(0);
    expect(data.hint).toBe("No notes are available yet. Call notes_overview: it says where notes come from and how to set them up.");
  });

  it("rejects impossible dates", async () => {
    const result = await call("list_notes", { modified_after: "2026-02-30" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not a real date/);
  });
});

describe("list_notes with notes that have no known date", () => {
  let undated: Client;
  const list = async (args: Record<string, unknown>) => JSON.parse((await call("list_notes", args, undated)).text);
  const idsOf = (data: { notes: { id: string }[] }) => data.notes.map((n) => n.id);

  beforeAll(async () => {
    const root = tempDir("sn-server-undated");
    writeFileSync(join(root, "basic.sdocx"), fixtureBytes("01-basic-formatting.sdocx"));
    writeFileSync(join(root, "marker.sdocx"), fixtureBytes("04-marker4-highlighter.sdocx"));
    writeFileSync(join(root, "undated.sdocx"), withoutDates("01-basic-formatting.sdocx"));
    writeFileSync(join(root, "undated-marker.sdocx"), withoutDates("04-marker4-highlighter.sdocx"));
    undated = await connect(new Catalog(() => ({ sources: [exportsFolderSource(root)], problems: [] })));
  });

  it("shows their date as unknown and says nothing more without a date filter", async () => {
    const data = await list({});
    expect(data.total).toBe(4);
    expect(data.notes.filter((n: { modified: string }) => n.modified === "unknown")).toHaveLength(2);
    expect(data.undated_included).toBeUndefined();
    expect(data.hint).toBeUndefined();
  });

  it("includes them under modified_after and sorts them last", async () => {
    const data = await list({ modified_after: "2026-09-01" });
    expect(idsOf(data)).toEqual(["file:marker.sdocx", "file:undated.sdocx", "file:undated-marker.sdocx"]);
    expect(data.notes.map((n: { modified: string }) => n.modified === "unknown")).toEqual([false, true, true]);
  });

  it("includes them under modified_before", async () => {
    const data = await list({ modified_before: "2026-09-01" });
    expect(idsOf(data)).toEqual(["file:basic.sdocx", "file:undated.sdocx", "file:undated-marker.sdocx"]);
  });

  it("says how many it included", async () => {
    const data = await list({ modified_after: "2026-09-01" });
    expect(data.undated_included).toBe(2);
    expect(data.hint).toBe("2 notes have no known date and are included; check their content for dates.");
  });

  it("says it in the singular for one note", async () => {
    const data = await list({ modified_after: "2026-09-01", query: "atlas" });
    expect(idsOf(data)).toEqual(["file:undated.sdocx"]);
    expect(data.undated_included).toBe(1);
    expect(data.hint).toBe("1 note has no known date and is included; check its content for dates.");
  });
});

describe("read_note", () => {
  it("returns header, attachments and text with tables", async () => {
    const { text } = await call("read_note", { id: "file:basic.sdocx" });
    expect(text).toContain("# 01-basic-test");
    expect(text).toContain("Pages: 5");
    expect(text).toContain("| Column A | Column B |");
  });

  it("points to attachments", async () => {
    const { text } = await call("read_note", { id: "file:Invoices/Receipt.sdocx" });
    expect(text).toContain("7@invoice.pdf (application/pdf");
    expect(text).toContain(`[image: ${PHOTO}]`);
  });

  it("points to pages with handwriting", async () => {
    const { text } = await call("read_note", { id: "file:marker.sdocx" });
    expect(text).toContain("Handwriting or drawings on page 1:");
  });

  it("explains unknown ids", async () => {
    const result = await call("read_note", { id: "nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Use list_notes/);
  });
});

describe("get_page_image", () => {
  it("returns a PNG of the page", async () => {
    const { content, text } = await call("get_page_image", { id: "file:marker.sdocx", page: 1 });
    const image = content.find((b) => b.type === "image")!;
    expect(image.mimeType).toBe("image/png");
    expect([...Buffer.from(image.data!, "base64").slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(text).toContain("Page 1 of 1");
  });

  it("explains a page out of range", async () => {
    const result = await call("get_page_image", { id: "file:marker.sdocx", page: 4 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("has 1 page");
  });

  it("explains a part out of range", async () => {
    const result = await call("get_page_image", { id: "file:marker.sdocx", page: 1, part: 2 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("has 1 part");
  });
});

describe("get_attachment", () => {
  it("returns a photo as an image", async () => {
    const { content } = await call("get_attachment", { id: "file:Invoices/Receipt.sdocx", file: PHOTO });
    expect(content.find((b) => b.type === "image")?.mimeType).toBe("image/png");
  });

  it("returns PDF text, and images for pages without text", async () => {
    const { content, text } = await call("get_attachment", { id: "file:Invoices/Receipt.sdocx", file: "7@invoice.pdf" });
    expect(text).toContain("Invoice 42 ACME");
    expect(text).toContain("2 pages");
    expect(content.filter((b) => b.type === "image")).toHaveLength(1);
  });

  it("reads the PDF pages asked for and says how to get the rest", async () => {
    const { content, text } = await call("get_attachment", { id: "file:Invoices/Receipt.sdocx", file: "7@invoice.pdf", pages: [1] });
    expect(text).toContain("Showing 1. Call again with pages=[2, …] for more.");
    expect(content.filter((b) => b.type === "image")).toHaveLength(0);
  });

  it("sends images of pages with text when asked", async () => {
    const { content } = await call("get_attachment", { id: "file:Invoices/Receipt.sdocx", file: "7@invoice.pdf", as_images: true });
    const images = content.filter((b) => b.type === "image");
    expect(images).toHaveLength(2);
    expect(images.every((b) => b.mimeType === "image/jpeg")).toBe(true);
  });

  it("lists the note's attachments when the file is unknown", async () => {
    const result = await call("get_attachment", { id: "file:Invoices/Receipt.sdocx", file: "nope.jpg" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("7@invoice.pdf");
  });

  it("says a locked note is locked instead of claiming the file is missing", async () => {
    const localState = await makeLocalState(
      tempDir("sn-server-win"),
      [{ uuid: "lock", fixture: "03-image-placement.sdocx", locked: true, title: "Bank" }],
      [],
    );
    const windows = await connect(new Catalog(() => ({ sources: [windowsAppSource(localState)], problems: [] })));
    const result = await call("get_attachment", { id: "lock", file: PHOTO }, windows);
    expect(result.isError).toBe(true);
    expect(result.text).toBe("“Bank”: This note is locked in Samsung Notes. Unlock it there to read it here.");
  });

  describe("on a note whose text can't be read", () => {
    let unreadable: Client;

    beforeAll(async () => {
      const root = tempDir("sn-server-bad");
      const photo = unzipSync(fixtureBytes("03-image-placement.sdocx"))[`media/${PHOTO}`]!;
      writeFileSync(join(root, "Scan.sdocx"), zipSync({ [`media/${PHOTO}`]: photo, "media/memo.txt": new TextEncoder().encode("hello") }));
      unreadable = await connect(new Catalog(() => ({ sources: [exportsFolderSource(root)], problems: [] })));
    });

    it("still opens its photos", async () => {
      expect((await call("read_note", { id: "file:Scan.sdocx" }, unreadable)).text).toContain("Couldn't read this note");
      const { content } = await call("get_attachment", { id: "file:Scan.sdocx", file: PHOTO }, unreadable);
      expect(content.find((b) => b.type === "image")?.mimeType).toBe("image/png");
    });

    it("says which file types it can open", async () => {
      const result = await call("get_attachment", { id: "file:Scan.sdocx", file: "memo.txt" }, unreadable);
      expect(result.isError).toBe(true);
      expect(result.text).toContain("Photos (JPEG, PNG, GIF, WebP) and PDFs are supported.");
    });
  });
});
