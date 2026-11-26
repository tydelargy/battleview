# Battle Map

A local, single-user tool: a tactical map of a codebase (files are buildings, folders are districts), with open PRs standing on the files they change and Jira tickets hanging off the PRs. Node 20+, a zero-dependency server, a Three.js UI. README.md is the user-facing doc; this file is for working on the code.

## Commands

```
npm test                 # unit, server and scene-wiring tests. Fast. No browser.
npm run e2e              # real Chrome against a real server: Jira flows, then PR tracking
npm start | npm run mock # sample repo and PRs | the same plus a fake Jira
SHOTS_DIR=docs/screenshots node e2e/shot2.mjs ...   # regenerate README screenshots (see the README)
```

Tests and e2e write scratch files to the system temp dir. Set `TMPDIR` if you want them somewhere specific. Never leave a server running after a test run; the e2e scripts clean up after themselves.

## Where things live

```
bin/battlemap.js          CLI: server, --prs feed file, --repo, --mock-jira
server/server.js          HTTP API + SSE. All state lives in `app`; every write goes through a handler that checks the X-Battlemap header
server/snapshot.js        joins repo files, tracked PRs and Jira into the one object the browser renders; drift "insights"
server/watch.js           which PRs are tracked (picks, author and path rules, ended PRs). PURE matching + a small file-backed store
server/config.js          config file (0600), Jira settings validation, token redaction
web/layout.js spires.js sigil.js    PURE geometry and identity. No DOM, no three. Unit tested
web/scene.js              Three.js glue: instanced meshes, camera, SVG/HTML overlay. Only checked by a smoke test with a stand-in three
web/main.js               panels, dialogs, settings. All feed data goes in through h()/fill() as text nodes, never HTML
```

## Invariants (break these and something real breaks)

- **No untrusted HTML.** PR titles, authors, branch names and rule values come from outside. Build DOM with `h()` and `fill()` (text nodes). Never `innerHTML` with feed data. `e2e/ui.mjs` has an XSS test; keep it passing.
- **The token never reaches the browser.** `redact()` strips it. Don't add a field to `/api/config` or the snapshot without checking it.
- **Writes need `X-Battlemap: 1` and a same-origin Origin; the Host header is checked.** There is no login: it binds to 127.0.0.1 and must never be bound publicly. Single-user, local by design.
- **Pure modules stay pure.** `layout.js`, `spires.js`, `sigil.js` and the matching functions in `watch.js` take data and return data. If you need the clock, a file or the network, pass it in.
- **The feed is the full set of open PRs.** `server/watch.js` treats a tracked PR that disappears from the feed as ended (closed), so a partial feed ends PRs. Sync scripts must write the whole set, or nothing.
- **Tracking is opt-in; muting wins.** A stopped (muted) PR stays off even when a rule matches. Finished PRs are only kept if they were open and tracked, or picked. See the tests in `test/watch.test.js` before changing any of it.
- **The built-in sample is never persisted** (no tracking state, no "was open" memory), and `--mock-jira` writes nothing to disk.
- **A copy of the pure modules is loaded by the browser as-is** (no bundler). Use plain ES modules, no Node-only imports under `web/`.

## Conventions

- Plain JS ES modules, dense but readable, comments say *why*. No dependencies beyond `three` at runtime; `playwright` is dev-only.
- New behaviour comes with a test: a unit test if it can be pure, otherwise a server test through `createApp`, and an e2e step for anything a user clicks. Prefer a failing test first.
- Persisted state sits next to the config as `<config>.<name>.json`, mode 0600, loaded defensively (a corrupt file is ignored, not fatal), written only when it changes.
- UI text is plain and short. Every new control needs an `aria-label` or visible label and must work at 420px wide.

## Workflow

This repo uses Jujutsu (`jj`). One commit per feature, stacked; fix-ups go into the commit they belong to with `jj squash --into <rev> <paths>`. Each commit must pass `npm ci && npm test` on its own. Don't push without being asked. Regenerate screenshots when the header or a panel changes, in the same commit.

## Feed

`battlemap --prs prs.json` reloads when the file changes. The format is in the README. Fields the UI relies on beyond the basics: `updatedAt`, and `mine` when the feed knows who the viewer is.
