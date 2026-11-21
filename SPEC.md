# lamsa — spec

**lamsa** (لمسة, "a touch") is an open-source, local-first design tool for developers and design engineers. Designs are plain JSON files in your app's own git repo, reviewed in pull requests. Your own coding agent does the bulk of the work through a CLI; you add the touch in a desktop editor.

License: MIT. The business, if any, is hosting later; the format, CLI, and desktop app are never gated.

## Principles

1. **Files are the product.** Designs live in the app repo as plain, documented JSON with a published JSON Schema. No account, no login, no lock-in.
2. **The CLI never calls an LLM.** lamsa is a tool your agent uses, not an agent. Bring any agent; lamsa never meters or wraps it.
3. **Spec, not codegen.** A design is a spec. Your agent reads the design JSON and a PNG render, then implements it in the repo's own framework and components.
4. **If CSS can't express it, it isn't in the schema.** The renderer is DOM/CSS, so what you see is what the browser can build.
5. **App code owns the tokens.** lamsa reads design tokens from your code; it never becomes a second source of truth.
6. **No daemon.** Files are the only bus. The CLI and the desktop app work independently of each other.
7. **Agent-complete.** An agent can run the whole loop alone: set up, design, render, verify, and show the result, without a person opening, clicking, or confirming anything. The desktop app is optional for viewing and touch-ups and is never a dependency.

### Agent-complete rules

- Every command is non-interactive. Nothing prompts; anything that would ask has a flag (`--yes`, `--force`) and a safe default. No login, ever.
- First-run setup is scriptable: `lamsa init --agent <name> --yes` writes config, skill, and `AGENTS.md`; `lamsa render` downloads Chromium without asking when no system Chrome exists (opt out with an env var).
- Everything the editor can show, the CLI can produce: PNG renders, `tree`, `diff`, `tokens`, `components`, validation with node IDs.
- `lamsa open [file] [--select <id>]` lets the agent show the user something. It launches the desktop app, or, if it's already running, forwards the request to the running instance (Electron single-instance handoff, not a daemon). Each project gets its own window: a project that's already open has its window brought forward and the file and selection applied there; any other project opens in a new window (or an empty one), and a window showing another project is never replaced. The same project never opens in two windows, including from the project menu, recent projects, or the folder picker, which use the current window only when it has no project. Each window has its own file watcher and agent chat, so closing or switching one leaves the others alone. Opening is always optional and never needed for any other command to work.
- The desktop app takes its file and selection from argv, so agents and scripts can launch it directly.
- **lamsa itself is agent-testable:** the CLI runs fully headless in CI; the desktop app is driven end to end with Playwright's Electron support, so a coding agent can build and verify the editor without a person checking screens.

## Positioning

See [Competitors](#competitors) at the end.

## Data model

### Files

- One file per page or board (`*.lamsa.json`), holding any number of screens and components. Users split and organise files freely.
- Each file has a top-level `version`. `lamsa migrate` upgrades files; the CLI refuses files newer than itself.
- Config (`lamsa.config.json`) holds globs for design files and components (monorepo friendly), the token adapter, `assetsDir`, and the agent command for the chat and terminal.

### Nodes

- Nodes are a **flat map** keyed by ID, with keys sorted. The CLI accepts nested input and normalises it to flat.
- IDs are random nanoids (~8 chars), never derived from names, so renames don't churn diffs or break references.
- IDs are global across the repo; cross-file references are by ID.
- Child order is `parentId` plus a fractional `index` string on each node (tldraw-style), not `children` arrays, so concurrent inserts merge cleanly in git.
- Top-level nodes carry canvas `x`/`y`.
- `hidden: true` hides a node and its subtree. `locked: true` is saved in the file so teammates and agents see it: the editor won't select or move a locked node from the canvas, and agents leave it alone unless asked.

### Node types

lamsa's own framework-agnostic primitives: `frame` (also used for rectangles and shapes), `text`, `image`, `icon`, `instance`. It does not render the app's real components.

**Icons** are a node type: `{ "type": "icon", "set": "lucide", "icon": "lock" }` (the field is `icon` because `name` is the layer name), sized and coloured with CSS (`width`, `color`). The renderer bundles a pinned lucide version. Other icon sets come later (adapter or plugin; reading the app's installed lucide version is a candidate). Custom icons are image nodes pointing at an SVG file.

In scope: flex/grid layout, absolute positioning, rotation, shadows, blur, blend modes, masks/clip, gradients, image fills.
Out of scope: pen tool, boolean operations, anything CSS can't render.

### Styles

- CSS-native property names everywhere, including the properties panel (`width: auto`, `flex: 1`, not "Hug"/"Fill").
- A subset of CSS: no selectors, no cascade, no `:hover`. Interactive states are component variants.
- Unitless numbers mean px.

### Text

v1: a plain `content` string per text node. Rich text runs come later, added without breaking v1 files.

### Tokens

- App code owns tokens. Pluggable **read-only adapters** parse them:
  - `shadcn-tailwind4` (first): reads `globals.css` `:root`, `.dark`, and `@theme`, including fonts. When the CSS imports Tailwind, Tailwind's default theme (`tailwindcss/theme.css`, the project's installed copy first) adds palette, text, font-weight, tracking, leading, radius, shadow, blur, ease and container tokens, marked built-in; the project's `@theme` overrides them and `--color-*: initial` style resets remove them.
  - `dtcg-json` (later).
- Tokens have modes (light/dark). The canvas, a frame, or an export picks the mode; frame overrides canvas, export flag overrides both.
- Designs store references as `"{token.path}"` (DTCG alias syntax). Raw values are allowed; `lamsa validate` warns when a raw value matches a token.
- **Font fallback:** fonts loaded in JS (e.g. `next/font`) appear in CSS only as variables, so the adapter can't find their files. A `fonts` entry in config maps a family to local files or a Google Fonts name for those cases.

### Components

- Components declare **props and variants**, like shadcn/cva: an enum prop maps each value to overrides on inner nodes.
- Instances set props, plus free overrides keyed by the component's inner node IDs.
- Every component in the repo is available in every file (config globs). `internal: true` hides helpers from pickers.
- Later: `codeRef` linking a component to its code; a copy-in shadcn kit (`lamsa add button`); external libraries.

### Assets

- Plain files referenced by repo-relative path, including the app's own files (e.g. `public/logo.svg`).
- Drag-and-drop in the editor copies into `assetsDir`. Git LFS is optional.
- Remote URLs get a lint warning.

## CLI (`lamsa`)

Distributed as the `lamsa` npm package with a `lamsa` binary.

**Agent interface:** no MCP. A documented CLI plus agent skills. `lamsa init` installs the skill and adds a section to `AGENTS.md`.

- Every command supports `--json`, uses meaningful exit codes, and reports errors naming the node ID with a suggested fix.
- Writes are atomic (temp file + rename).

Command surface (hybrid):

| Kind | Commands |
|---|---|
| Error-prone operations | `add --tree`, `move`, `delete`, `split` |
| Verification | `validate`, `fmt` (assigns missing IDs, sorts keys; `--fix` removes orphans), `render` |
| Read views | `tree`, `diff`, `components`, `tokens`, `selection` |
| Setup / upkeep | `init`, `migrate` |
| Show the user | `open` (optional; launches or focuses the desktop app) |
| Review | `report` (before/after PNGs of affected screens + markdown summary; the GitHub Action wraps it) |

Simple property tweaks are raw JSON edits; raw edits are first-class.

**Rendering:** all PNG export goes through the CLI renderer (playwright-core with system Chrome, or a one-time Chromium download) so output is identical everywhere.

**Selection:** the desktop app writes a gitignored `.lamsa/session.json` with the current selection; `lamsa selection` reads it if present. The CLI never requires the app to be open or closed.

## Desktop app

Electron app with a React frontend (the same frontend can later become a hosted editor).

**Why Electron, not Tauri:** Tauri uses the OS webview (WebKitGTK on Linux, WebKit on macOS), while PNG export, PR previews, and most browsers are Chromium. A design tool must render the canvas with the same engine as its exports. Electron also runs the TypeScript core directly in the main process and gives a proven terminal stack (`node-pty` + xterm.js). Accepted cost: bigger download and memory use.

### File sync

Agent edits appear live, with no reload and no "close without saving". This is a headline feature.

- Watches the design directories (not single files, so atomic rename writes are caught), debounced.
- On change: re-parse, diff per node against memory, apply only changed nodes. Selection, viewport, and undo stack survive.
- A half-written or invalid file keeps the last good state on screen with the "Invalid file" state; the editor never rewrites the agent's file.
- Autosaves, so unsaved local edits are near zero. On conflict with an external write, merges per node.
- Undo/redo is per session and in memory; each operation is one diff. External changes are not in the undo history; undo entries touching a node changed externally are dropped rather than overwriting the external change.

### v1 editing surface

- **Canvas:** pan/zoom, view across files/boards, token mode toggle.
- **Panels:** the layers sidebar and properties sidebar can each be collapsed for more canvas: `⌘\` toggles both, `⌘[` the layers sidebar, `⌘]` the properties sidebar.
- **Select:** click, shift-click, marquee; layers tree with drag to reorder/reparent, plus show/hide (`⌘⇧H`) and lock (`⌘⇧L`) per layer.
- **Direct manipulation:** move, resize, snapping and smart guides. Flex children drag to reorder, not to x/y.
- **Text:** inline edit.
- **Properties panel:** CSS properties for the selection, a token picker for every value, shared edits across multi-select.
- **Insert:** frame, text, rect, image (drag in), lucide icon (searchable picker), component instance.
- **Components:** switch instance props/variants, go to main component, detach.
- Copy/paste, duplicate, delete, group into frame.

Later: create component from selection, visual gradient/shadow/mask editors, rotation handles, comments, prototyping links, history UI (git is the history).

### In-app AI

An Agent tab in the editor chats with the user's own agent CLI (configurable command, default `claude`). lamsa runs it headless with structured output (`claude -p --output-format stream-json`, `--session-id` for the first turn, `--resume` after) in the project root and draws the stream as chat: messages, tool steps, and a card listing the layers that changed, each one selectable on the canvas. Selected layers go along as context without being shown in the message box. Pasting copied layers or layer ids into the message box turns them into inline layer pills, sent as `[Name](lamsa:id)` links and drawn as pills in the thread that select the layer. One small parser per agent turns its output into chat events; Claude is the first.

Past conversations are read from the agent's own session storage (for Claude Code, `~/.claude/projects/<project>/*.jsonl`), so lamsa keeps no conversation store; it only records which layers each chat turn changed, in `.lamsa/agent-sessions.json`.

"Continue in terminal" (`⌘J`) opens the user's own terminal (`$TERMINAL`, else the first one found) running `claude --resume <session>` in the project root. One session has one writer: while it's open there, the chat pauses and picks up afterwards with everything said in the terminal. Agents without structured output skip chat and open in the terminal. lamsa never touches the agent's credentials and ships no API-key flow.

Before launch: confirm with agent vendors' terms that driving their CLI headlessly on a subscription login (e.g. `claude -p` on a claude.ai plan) is allowed.

## Pull request review

An opt-in GitHub Action (`action/`) posts before/after PNGs and a semantic diff (nodes added/removed/changed) on PRs. It re-renders every screen that depends on a changed component. It is a thin wrapper over `lamsa report`, so the same review runs locally; images go to a separate `lamsa-previews` branch and the comment updates in place on each push.

## Stack

A pnpm monorepo, all TypeScript, so the CLI and the editor share one core and validate identically.

| Package | Role |
|---|---|
| `@lamsa/schema` | Types and the published JSON Schema |
| `@lamsa/core` | Parse, `fmt`, validate, tree/diff, fractional indexing, token adapters |
| `@lamsa/renderer` | Design JSON → DOM/CSS; used by the editor canvas and PNG export |
| `lamsa` | The CLI; playwright-core for rendering |
| `apps/desktop` | Electron + React + Vite editor |

## Build phases

1. **Agent-only.** Schema, core, renderer, CLI (`init`, `fmt`, `validate`, `render`, `tree`, `add --tree`, `tokens`), agent skill. Useful on day one: the agent designs, `lamsa render` makes PNGs, review happens in PRs. Proves the format before an editor depends on it.
2. **Read-only viewer.** Electron canvas with live reload, pan/zoom, layers tree, selection writing `session.json`, agent chat.
3. **Editing.** Properties panel, direct manipulation, undo, the rest of the v1 editing surface.
4. **GitHub Action** for PR previews.

## Later / out of scope for v1

- Plugin/mod system: three tiers (config, typed pure-function plugins, fork) with a workspace-trust security model (tracked as tsk T23).
- Built-in chat UI over the agent CLI's structured output (no API keys; blocked on vendor-terms check). Tracked in tsk.
- On-canvas comments pinned to node IDs, stored as files and readable by the agent (`lamsa comments --json`). Tracked in tsk.
- Team cloud service (hosted editor, multiplayer, hosted PR previews). Not designed yet.
- Rich text runs.
- Generic HTML/CSS export.
- `dtcg-json` adapter, component kit, external component libraries, `codeRef`.

## Competitors

Checked 2026-11.

**pen.dev.**
- Its `.pen` files are plain nested JSON on disk, despite docs that call them encrypted. Open JSON alone is therefore not a differentiator.
- Its CLI wraps pen.dev's own designer agent behind a login, with day-based metered pricing, even when you bring your own agent.
- Its MCP server depends on the desktop app being in a particular state.

**Open Design** (nexu-io/open-design).
- An Apache-2.0 "AI design agent workspace" with about 107k stars and very fast development.
- Architecture: Electron + Next.js, a local Node daemon with a REST API, SQLite for project state, and an MCP server.
- It detects about 26 agent CLIs, so it is also BYO agent, and adds a BYOK proxy.
- Output is agent-written HTML/CSS/JSX, which can be exported to React, Next or Vue.
- Design systems come from its own catalog of brand `DESIGN.md` packages.
- It is monetised through credit plans and a hosted model service, with always-on reliability telemetry.
- It ships for macOS and Windows; Linux means building from source.

**What lamsa claims instead.** "BYO agent" alone is no longer novel, so lamsa leads with the following:

| | lamsa | Open Design | pen.dev |
|---|---|---|---|
| Design format | Structured JSON, published schema, merge-friendly layout | Generated HTML + SQLite metadata | Nested JSON, no published schema |
| Output | Spec; your agent writes your code | Code/HTML to hand off or export | Spec + its own agent |
| Tokens | Read from your app code | Vendor brand catalog | In-file variables |
| Runtime | No daemon, no DB, no MCP; files only | Daemon + SQLite + MCP | Desktop app + MCP |
| Money | Nothing metered, no login | Credits, hosted models | Login, metered days |
| Linux | First-class builds | Build from source | AppImage |
| Agent edits in the open editor | Live, per-node | — | Reopen the file |

**Borrowed idea:** one-line agent onboarding. `lamsa init --agent <name>` installs the skill for that agent (Claude Code, Codex, Cursor, …).
