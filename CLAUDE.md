# Battle Map

A local, single-user tool: a tactical map of a codebase (files are buildings, folders are districts), with open PRs standing on the files they change and Jira tickets hanging off the PRs. Node 20+, a zero-dependency server, a Three.js UI. README.md is the user-facing doc; this file is for working on the code.

## Commands

```
npm test                 # unit, server and scene-wiring tests. Fast. No browser.
npm run e2e              # real Chrome against a real server: Jira flows, PR tracking, filters and sorting, notifications and alerts
npm start | npm run mock # sample repo and PRs | the same plus a fake Jira
SHOTS_DIR=docs/screenshots node e2e/shot2.mjs readme   # regenerate every README screenshot
```

Tests and e2e write scratch files to the system temp dir. Set `TMPDIR` if you want them somewhere specific. Never leave a server running after a test run; the e2e scripts clean up after themselves.

## Where things live

`deploy/` has the systemd units and installer; `test/deploy.test.js` renders them into a temp dir, so nothing there touches your systemd.

```
bin/battlemap.js          CLI: server, --prs feed file, --repo, --rescan, --mock-jira
bin/battlemap-sync.js     CLI: writes the feed file from a code host (cron / systemd timer). Replaces the file atomically, never on failure
server/server.js          HTTP API + SSE. All state lives in `app`; every write goes through a handler that checks the X-Battlemap header
server/snapshot.js        joins repo files, tracked PRs and Jira into the one object the browser renders; drift "insights"
server/providers/         code-host adapters for the sync: a PURE mapper (normalisePR) plus a runner that takes an injectable `exec`. github.js today; GitLab would be a sibling
server/feedwatch.js       watches the feed's DIRECTORY, because a watch on the file dies when sync renames a new file over it
server/notify.js          notifications: PURE detection (`detectEvents`, `shouldNotify`, `eventsFor`) plus a file-backed store for the inbox, policy and silenced alerts
server/watch.js           which PRs are tracked (picks, author and path rules, ended PRs). PURE matching + a small file-backed store
server/config.js          config file (0600), Jira settings validation, token redaction
web/layout.js spires.js sigil.js building.js sites.js    PURE geometry and identity (sites.js: the construction-site look of the diff layer, Buildings style, plus the focus views File belts, Crates and Facade (plus the classic Hunks stack), which every style can use for a focused PR; layering rules below; building.js: hash-derived colour, silhouette, windows, index code, roofs; planSpires takes a `roofs` map so toppers stand on them). No DOM, no three. Unit tested
web/filters.js            PURE filter and sort model ("needs attention first" is a tiered comparator; see `attentionTier`) for the PR tray and the map (one model: search, authors, status, age, needs-me, epic). Takes `now` as an argument
web/scene.js              Three.js glue: instanced meshes, camera, SVG/HTML overlay. Only checked by a smoke test with a stand-in three
web/main.js               panels, dialogs, settings. All feed data goes in through h()/fill() as text nodes, never HTML
```

## Invariants (break these and something real breaks)

- **No untrusted HTML.** PR titles, authors, branch names and rule values come from outside. Build DOM with `h()` and `fill()` (text nodes). Never `innerHTML` with feed data. `e2e/ui.mjs` has an XSS test; keep it passing.
- **The token never reaches the browser.** `redact()` strips it. Don't add a field to `/api/config` or the snapshot without checking it.
- **Writes need `X-Battlemap: 1` and a same-origin Origin; the Host header is checked.** There is no login: it binds to 127.0.0.1 and must never be bound publicly. Single-user, local by design.
- **Pure modules stay pure.** `layout.js`, `spires.js`, `sigil.js`, `building.js`, `sites.js`, `filters.js`, `notify.js` (the detection and policy functions), the matching functions in `watch.js` and the provider mappers take data and return data. If you need the clock, a file or the network, pass it in.
- **The feed is the full set of open PRs.** `server/watch.js` treats a tracked PR that disappears from the feed as ended (closed), so a partial feed ends PRs. Sync scripts must write the whole set, or nothing.
- **Tracking is opt-in; muting wins.** A stopped (muted) PR stays off even when a rule matches. Finished PRs are only kept if they were open and tracked, or picked. See the tests in `test/watch.test.js` before changing any of it.
- **Notifications are events between two states of a tracked PR, computed in `reconcile()`.** First sight and ended PRs announce nothing, and the previous state survives a restart (it is the watch store's "was open" memory), so a change while the server was down is announced and an unchanged restart is silent. Policy is two layers and one rule for every PR, yours included: a global switch per kind, and an optional per-PR override per kind (on or off) that beats it in both directions; unset follows the global switch as it is now. A global change never rewrites a PR's overrides, and events that happen while a kind is off are dropped, never saved up. `test/notify.test.js` states the rules as a truth table and a round-trip scenario: change them only on purpose. Alert ids are built from everything an alert is about, so silencing one can never hide another.
- **The built-in sample is never persisted** (no tracking state, no "was open" memory), and `--mock-jira` writes nothing to disk.
- **"Click outside closes" must read `e.composedPath()`, not `e.target.closest()`.** Chips and buttons re-render their list on click, so by the time the click reaches the document the target is detached and looks like it was outside.
- **Layering: nothing may share a plane. This is the rule behind every flicker bug we have had (windows, belts, scaffolding).** Two surfaces in one plane z-fight, and which one wins changes with the camera and the frame. So:
  - **Order of layers, always:** the building's base colour, then the wall texture, then windows, painted in that order inside one shader, never as overlapping meshes. For geometry added over a building the order is wall < added structure < deletions: a red (deleted) belt or rail stands proud of a green (added) one, which stands proud of the wall.
  - **Geometry:** no two boxes may have faces that point the same way, lie in the same plane (within 0.08 units) and overlap. Give every layer its own thickness or outset (0.1 or more), butt the corners of rings instead of overlapping them, start a stack above the pad it stands on, stop posts below the rail that caps them, and pack things that could overlap (belts) top to bottom with a gap. `test/coplanar.js` finds these; `test/sites.test.js` runs it over every focus view and every building shape, so a new shape or view must pass it.
  - **Shaders:** per-instance data goes through `flat` varyings and is rounded before it becomes an integer (an interpolated 12345.0 can arrive as 12344.99998 and `uint()` truncates it: per-pixel noise). Compute every `fwidth()` before any branch, never inside one. Anti-alias edges and fade to an average colour when a feature is under about three pixels, so nothing shimmers.
- **A copy of the pure modules is loaded by the browser as-is** (no bundler). Use plain ES modules, no Node-only imports under `web/`.

## Conventions

- Plain JS ES modules, dense but readable, comments say *why*. No dependencies beyond `three` at runtime; `playwright` is dev-only.
- New behaviour comes with a test: a unit test if it can be pure, otherwise a server test through `createApp`, and an e2e step for anything a user clicks. Prefer a failing test first.
- Persisted state sits next to the config as `<config>.<name>.json`, mode 0600, loaded defensively (a corrupt file is ignored, not fatal), written only when it changes.
- UI text is plain and short. Every new control needs an `aria-label` or visible label and must work at 420px wide.

## Workflow

This repo uses Jujutsu (`jj`). One commit per feature, stacked; fix-ups go into the commit they belong to with `jj squash --into <rev> <paths>`. Each commit must pass `npm ci && npm test` on its own. Don't push without being asked. Regenerate screenshots when the header or a panel changes, in the same commit.

## Feed

`battlemap --prs prs.json` reloads when the file changes. `battlemap-sync github` writes it from `gh`; the format is in the README. Fields the UI relies on beyond the basics: `updatedAt` and `createdAt` (age filters, sorting, flag height), `waitingSince` (how long a PR has waited on us, for "needs attention first"; sync computes it, and a feed without it falls back to `updatedAt`), `headSha` (so notifications can tell a push exactly; without it they fall back to file sizes), and `mine` (set by sync from the logged-in user). Sync tests use a stand-in `gh` script, never the network or a real account: keep it that way.
