---
name: lamsa
description: Design app screens and components as lamsa design files (*.lamsa.json) in this repo, render them to PNG, and implement them in code. Use when asked to design, mock up, or change a screen, page, or component, when a task mentions lamsa or .lamsa.json files, or before implementing UI that has a lamsa design.
---

# lamsa

lamsa designs are plain JSON files in this repo (`*.lamsa.json`, see `lamsa.config.json` for where). You edit them directly or with the `lamsa` CLI, check them with `lamsa validate`, and look at them with `lamsa render`. Nothing needs a person to open an app: every step below runs headless.

A design is a **spec**, not code. To build a designed screen, read its JSON and its PNG, then implement it with this repo's own framework, components, and tokens.

## The loop

1. `lamsa tokens` and `lamsa components` to see what exists. Use tokens and components instead of raw values.
2. Make the change: `lamsa add --tree` for new subtrees, `lamsa move` / `lamsa delete` for structure, direct JSON edits for property tweaks.
3. `lamsa validate` (exit 1 on errors; each error names the node ID and a fix).
4. `lamsa render <id|name|file>` and look at the PNG(s) it prints (`.lamsa/render/`). Fix what looks wrong and render again.
5. Optional: `lamsa open <file> --select <id>` shows the result to the user in the desktop editor. Never required.

Add `--json` to any command for machine-readable output. If the user has the editor open, `lamsa selection --json` tells you what they have selected; "this", "the selected button" etc. usually mean that.

## File format

```json
{
  "$schema": "https://lamsa.dev/schema/v1.json",
  "version": 1,
  "nodes": {
    "k3Xq9aZ1": { "type": "frame", "name": "Checkout · Default", "x": 0, "y": 0,
                  "style": { "width": 390, "height": 844, "display": "flex", "flex-direction": "column",
                             "gap": "{spacing.4}", "padding": "{spacing.6}", "background": "{color.background}" } },
    "Tt0aB12c": { "type": "text", "parentId": "k3Xq9aZ1", "index": "a0", "content": "Checkout",
                  "style": { "font-size": 24, "font-weight": 600 } }
  }
}
```

- `nodes` is a **flat map** keyed by ID. Children point at their parent with `parentId` and are ordered by `index` (a fractional string; `lamsa fmt` fills it in). Top-level nodes (no `parentId`) are screens or components on the canvas and carry `x`/`y`.
- IDs are random 8-char strings, global across the repo. Never derive them from names. Omit `id` in `add --tree` input and the CLI assigns them.
- Node types: `frame` (container; only frames have children), `text` (`content`), `image` (`src`, a repo-relative path), `icon` (`"set": "lucide"`, `"icon": "<lucide name>"`), `instance` (`componentId`, `props`, `overrides`).
- `style` is CSS with kebab-case property names. Unitless numbers are px. No selectors, no `:hover`: states are component variants. If CSS can't express it, lamsa can't either.
- Token references go in style values: `"{color.primary}"`, `"1px solid {color.border}"`. Tokens come from the app's own CSS; `lamsa tokens` lists them. Don't invent tokens and don't copy raw hex values that a token already covers (validate warns).
- A frame can set `"mode": "dark"` to render in dark mode; `lamsa render --mode dark` forces it.
- Layout uses normal CSS: `display: flex|grid`, `gap`, `padding`, `width: "100%"`, `flex: 1`, `position: absolute` with `top`/`left` inside a `position: relative` frame.

## Components

A component is a top-level frame with a `component` block:

```json
"Bt9xQ2mL": { "type": "frame", "name": "Button", "x": 0, "y": 0,
  "style": { "display": "inline-flex", "padding": "{spacing.2} {spacing.4}", "border-radius": "{radius.md}",
             "background": "{color.primary}", "color": "{color.primary-foreground}" },
  "component": { "props": {
    "variant": { "type": "enum", "options": ["default", "outline"], "default": "default",
                 "overrides": { "outline": { "Bt9xQ2mL": { "style": { "background": "transparent", "border": "1px solid {color.border}", "color": "{color.foreground}" } } } } },
    "label": { "type": "text", "default": "Button", "target": "Lb1Lb1Lb" } } } },
"Lb1Lb1Lb": { "type": "text", "parentId": "Bt9xQ2mL", "index": "a0", "content": "Button" }
```

Use it with `{ "type": "instance", "componentId": "Bt9xQ2mL", "props": { "variant": "outline", "label": "Cancel" } }`. `overrides` patch inner nodes by their ID: `{ "<innerId>": { "style": {...}, "content": "...", "hidden": true } }`. Every component in the repo is usable in every file; `"internal": true` hides helpers from `lamsa components`.

## Commands

| Command | Use |
|---|---|
| `lamsa tree [id\|file\|name] [--depth n]` | Structure with IDs |
| `lamsa tokens [--kind color]` | Available tokens |
| `lamsa components [--all]` | Components and their props |
| `lamsa add --tree <json\|file\|-> (--parent <frame> \| --file <path>) [--before\|--after <sibling>]` | Insert nested JSON (`children` arrays allowed); refuses input that would not validate |
| `lamsa move <id> (--parent <frame> \| --file <path> \| --before\|--after <sibling>)` | Reparent or reorder, keeping the subtree together |
| `lamsa delete <id...>` | Remove nodes and their subtrees |
| `lamsa split <id> --to <file>` | Move a top-level node into another file |
| `lamsa validate` / `lamsa fmt [--fix]` | Check; normalise (flatten nested input, fill indexes, sort keys; `--fix` drops orphans) |
| `lamsa render [targets] [--mode dark] [--scale 2] [--out dir]` | PNGs of top-level frames |
| `lamsa diff [ref]` | Semantic changes since a git ref and the screens they affect |
| `lamsa report [--base ref]` | Before/after PNGs of affected screens plus a markdown summary (`.lamsa/report/report.md`) |
| `lamsa selection` | What the user has selected in the editor |
| `lamsa open [file] [--select id]` | Show the user (optional) |

## Rules

- Prefer editing over recreating: keep IDs stable so diffs and references stay meaningful.
- One file per page or board; put shared components in their own file.
- After every change: `lamsa validate`, then `lamsa render` and look at the image before saying you're done.
- Never write to `.lamsa/` (editor session state) except via the CLI.
