# lamsa

lamsa (لمسة, "a touch") is an open-source, local-first design tool for developers and design engineers. Designs are plain JSON files in your app's repo, reviewed in pull requests. Your own coding agent does the bulk of the work through the `lamsa` CLI; you add the touch in a desktop editor.

- **Files are the product.** `*.lamsa.json`, a flat node map with a published JSON Schema.
- **The CLI never calls an LLM.** Bring any agent. Nothing is metered, no login.
- **Spec, not codegen.** Your agent reads the design and implements it with your components.
- **Tokens come from your code.** shadcn / Tailwind v4 `globals.css` is read directly.
- **Agent-complete.** Init, design, validate, render and review all run headless.

```sh
npx lamsa init --agent claude --yes   # config, agent skill, AGENTS.md section
lamsa tokens                          # what your app's CSS defines
lamsa add --file designs/home.lamsa.json --tree '{"type":"frame","name":"Home","style":{"width":390,"height":844}}'
lamsa validate                        # errors name the node ID and a fix
lamsa render Home                     # PNGs in .lamsa/render/
```

See [SPEC.md](SPEC.md) for the design and `examples/shadcn-app` for a working project.

## Development

```sh
pnpm install
pnpm build
pnpm test
```

MIT licensed.

## Packages

| Path | What |
|---|---|
| `packages/schema` | `@lamsa/schema`: types and the JSON Schema |
| `packages/core` | `@lamsa/core`: load, validate, fmt, edit, diff, token adapters |
| `packages/renderer` | `@lamsa/renderer`: design JSON → DOM/CSS (editor and exports) |
| `packages/cli` | `lamsa`: the CLI and the agent skill |
| `apps/desktop` | Electron editor (`pnpm desktop`, or `lamsa open` with `lamsa-desktop` on PATH / `LAMSA_DESKTOP_BIN`) |
| `action` | GitHub Action for PR previews |

`pnpm test` builds everything and runs unit, CLI and desktop end-to-end tests (the editor runs offscreen, no display needed).
