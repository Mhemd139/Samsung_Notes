---
name: samsung-notes
description: Read the user's Samsung Notes (typed text, tables, handwritten pages, and attached photos and PDFs such as invoices and receipts) through the samsung-notes-mcp server. Use when the user asks about their Samsung Notes or .sdocx files, wants receipts or invoices collected into a table or folder, or wants handwriting or scanned pages read. Never changes a note.
license: GPL-3.0-only
---

# Samsung Notes

Lets the agent read the user's Samsung Notes through the free, open-source [samsung-notes-mcp](https://github.com/Mhemd139/Samsung_Notes) server. It runs on the user's own computer, reads notes locally, and never changes a note.

## Setup (once)

If the `notes_overview` tool isn't available, install the server:

- **Claude Code:** `/plugin install samsung-notes --marketplace Mhemd139/Samsung_Notes` (the plugin includes this skill), or `claude mcp add --scope user samsung-notes -- npx -y samsung-notes-mcp`.
- **Claude Desktop:** download [samsung-notes-mcp.mcpb](https://github.com/Mhemd139/Samsung_Notes/releases/latest/download/samsung-notes-mcp.mcpb), open it, and click Install, then Install again.
- **Any other MCP client:** run `npx -y samsung-notes-mcp` as a stdio server (Node 20.12+).
- **Nothing can be installed** (a phone, a locked-down computer): send the user to [Inkport](https://mhemd139.github.io/Samsung_Notes/), a free web app that opens `.sdocx` files in the browser with nothing uploaded. Its **Send to AI** button hands you the typed text as a text file, the handwritten pages as images and the attached photos and PDFs; it also exports Markdown.

Where notes come from:

- **Samsung Notes for Windows** (signed in and synced): found automatically, nothing to set.
- **Any other computer:** in the phone app, select notes → Share → Samsung Notes file, save the `.sdocx` files into one folder, and add `--exports "/path/to/folder"` to the server command.

## Which tool, when

- Start of a task, or "what's in my notes?": `notes_overview` (sources, folders, totals, problems).
- Find notes by words, folder, dates, attachments or handwriting: `list_notes`. Words match titles and typed text only, never handwriting.
- Read a note: `read_note` (typed text, tables, attachments, and which pages hold handwriting).
- Handwriting, sketches or layout: `get_page_image`, one page at a time.
- Invoices, receipts, photos and PDFs: `list_notes` with `has_attachments=true`, then `get_attachment` for each file. When only a PDF's date, vendor or total is needed, ask for `pages=[1]` first.
- A note's date is its last edit, not the date printed on an invoice. Read the file for invoice dates, amounts and vendors.
- Going through everything ("put all my receipts in a spreadsheet"): repeat `list_notes` with `next_offset` until it stops returning one, open every file you need, then build the table yourself.
- Tall pages and photos come in overlapping parts: read every part, and count a repeated line once.
- Save copies of attachments into a folder only when the user asks: `save_attachments` with `check_only=true` first, then save. Name files `YYYY-MM-DD Vendor Total Currency`, and write `unknown` for any part you can't read. Never guess.
- A locked or unreadable note: tell the user (locked notes must be unlocked in Samsung Notes) and move on.
