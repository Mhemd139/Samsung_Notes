# Contributing

Thanks for helping. Translations, bug reports with a public sample note, and fixes are all welcome.

## Project layout

```text
src/              samsung-notes-mcp, the MCP server (Node)
  core/           pure note, SVG, text, zip, Markdown and PDF code, shared with Inkport (no Node APIs)
  sources/        where notes come from: Samsung Notes for Windows, an exports folder
web/              Inkport, the web app (Vite, deployed to GitHub Pages)
  src/locales/    one file per language
test/             server and core tests, with 4 public test notes in fixtures/
web/test/         web app tests
skills/           the agent skill shipped with the Claude Code plugin
scripts/          .mcpb packing, a local smoke check, icon generation
.claude-plugin/   Claude Code plugin and marketplace
manifest.json     Claude Desktop extension (.mcpb)
server.json       official MCP Registry entry
```

## Develop

Node 20.12 or newer.

```bash
npm install
npm test            # server, core and web app
npm run typecheck   # three configs: root, web/, web/test/
npm run web:dev     # Inkport on http://localhost:5173
npm run build       # the server into dist/
npm run pack:mcpb   # the Claude Desktop bundle
```

## Rules

- **Read-only.** Nothing may ever write to a note or to Samsung Notes' folders.
- **No real notes in tests or issues.** Use the public notes in `test/fixtures/` or synthetic data. When you start the server by hand, point `LOCALAPPDATA` at an empty folder so it can't find your own Samsung Notes library.
- **Inkport stays private.** It must not contact any other site; its Content Security Policy enforces that, so don't loosen it.
- **Version bumps** change `package.json`, `manifest.json`, `.claude-plugin/plugin.json` and `server.json` together; a test checks it.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:` …), and CI must pass on Windows, macOS and Linux.

## Translations

Each language is one file in [`web/src/locales`](web/src/locales). Edit it in a pull request, or describe the fix in a [translation issue](https://github.com/Mhemd139/Samsung_Notes/issues/new?template=translation.yml). Keep placeholders such as `{count}` exactly as they are; the tests check them.

By contributing you agree that your work is licensed under [GPL-3.0-only](LICENSE).
