# Security

## Reporting a problem

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/Mhemd139/Samsung_Notes/security/advisories/new), not in a public issue.

Never attach your real notes; describe the problem or use a public sample note.

## What counts

- **samsung-notes-mcp** reading or writing anything outside the note sources it was given, or changing a note.
- **Inkport** sending note content anywhere, or loading code from another site.
- A crafted `.sdocx` file that runs code, or escapes the folder in `save_attachments` or Inkport's exports.

Only the latest release of the connector and the live Inkport site receive fixes.
