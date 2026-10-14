# Changelog

The connector (`samsung-notes-mcp`) follows [semantic versioning](https://semver.org). Inkport, the web app, ships continuously from `main` to https://mhemd139.github.io/Samsung_Notes/.

## Unreleased

### Inkport

- Notes made from a PDF (a PDF imported into Samsung Notes, or one written on) show their PDF pages with the handwriting on top, in the page view, the library and the PDF export. They used to come out blank.
- **Send to AI:** one tap shares a note, or every note shown in the library, with Claude, ChatGPT or Gemini. The AI gets one text file with all the typed text and dates, images of the handwritten pages, and the attached photos and PDFs, within 10 files per message. On a computer the files download instead.
- English note titles no longer scramble in Hebrew, Arabic or Persian.
- **Try the samples** opens Inkport with four public test notes.
- First release of Inkport: opens `.sdocx` files, folders and zips on any device, with a library, page view, text and files tabs, a PDF per note, and **Export all** to Markdown + PDF + attachments. It works offline, installs as an app, receives notes from Android's share menu, and comes in 21 languages. Nothing is uploaded.

### Connector 0.1.5 (14 Oct 2026)

- `get_page_image` shows the PDF pages of notes made from a PDF, with the handwriting on top. They used to come out blank.
- Parser updated to `@twango/sdocx` 1.1.0, which loads in Node without a hand-written WASM loader.

### Connector 0.1.4 (9 Oct 2026)

- Install as a Claude Code plugin: `/plugin install samsung-notes --marketplace Mhemd139/Samsung_Notes`. The plugin includes a skill that tells the agent which tool fits which task.
- Ready for the official MCP Registry as `io.github.Mhemd139/samsung-notes`; the release workflow publishes it there and to npm.
- Shared note, SVG and file-name code moved to `src/core/` for reuse by Inkport. Tool behaviour is unchanged.

## 0.1.3 (1 Oct 2026)

- Finds the Windows Documents folder with `reg export` instead of PowerShell.

## 0.1.2 (1 Oct 2026)

- Reads page 1 of a PDF first when only its date, vendor or total is needed.

## 0.1.1 (1 Oct 2026)

- New tool `save_attachments`: saves renamed copies of a note's photos and PDFs into a folder you choose. Notes are never changed.

## 0.1.0 (1 Oct 2026)

- First release: five read-only tools (`notes_overview`, `list_notes`, `read_note`, `get_page_image`, `get_attachment`).
- Reads Samsung Notes for Windows with no setup, or a folder of exported `.sdocx` files.
- Typed text and tables as text, handwriting as page images (tall pages in parts), attached photos, and PDFs as text plus page images.
- One-click `.mcpb` bundle for Claude Desktop, with build provenance.
