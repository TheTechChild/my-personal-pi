# my-personal-pi

Personal extension bundle for [pi-coding-agent](https://github.com/badlogic/pi-mono).
Installs as a single [pi package](https://github.com/badlogic/pi-mono/blob/main/packages/pi-coding-agent/docs/packages.md)
that registers two extensions:

| Component | Purpose |
|---|---|
| [`extensions/mcp`](./extensions/mcp) | Connect pi to any [Model Context Protocol](https://modelcontextprotocol.io) server (stdio, HTTP, SSE) and expose its tools/resources/prompts to the LLM. |
| [`extensions/web-research`](./extensions/web-research) | Adds `web_search` and `web_fetch` tools (Brave or DuckDuckGo + Readability/Turndown extraction). |
| [`extensions/review-edits`](./extensions/review-edits) | Intercepts `edit`/`write` tool calls and shows them as a side-panel diff for accept/reject before they touch disk. |
| [`mcp-wrappers/`](./mcp-wrappers) | Helper scripts referenced from `mcp.json` (e.g. `unraid-docker-wrapper.py`). Not pi extensions, just co-located so one clone brings everything. |

## Install

```bash
# Make sure pi is installed
npm install -g @mariozechner/pi-coding-agent

# Install this bundle (global)
pi install git:github.com/TheTechChild/my-personal-pi

# ...or pin to a specific tag/commit
pi install git:github.com/TheTechChild/my-personal-pi@v0.1.0
```

This clones into `~/.pi/agent/git/github.com/TheTechChild/my-personal-pi/` and runs `npm install --omit=dev` automatically.

For project-local installs (writes to `.pi/settings.json`):

```bash
pi install git:github.com/TheTechChild/my-personal-pi -l
```

## Update

```bash
pi update                                          # update pi + all non-pinned packages
pi update git:github.com/TheTechChild/my-personal-pi  # update just this one
```

## Uninstall

```bash
pi remove git:github.com/TheTechChild/my-personal-pi
```

## Configure

### MCP servers

The `mcp` extension reads server definitions from:

- `~/.pi/agent/mcp.json` (global)
- `.mcp.json` in the cwd or any parent directory (project-local; multiple files merge)

Example: see [`docs/mcp-config-example.json`](./docs/mcp-config-example.json) and [`extensions/mcp/README.md`](./extensions/mcp/README.md).

### Web research

`web-research` works with no config (DuckDuckGo HTML fallback). For Brave Search, set `BRAVE_API_KEY`. See [`extensions/web-research/README.md`](./extensions/web-research/README.md).

## Development

Clone and link locally to iterate:

```bash
git clone https://github.com/TheTechChild/my-personal-pi
cd my-personal-pi
npm install
pi install $(pwd)         # absolute path = local install, no copy
```

After editing `extensions/*/index.ts`, run `/reload` inside pi.

### Toolchain

This package uses **TypeScript** (type-check only — pi loads `.ts` sources directly via
jiti at runtime, so we never emit JS) and **Biome** for formatting + linting.

```bash
npm run typecheck         # tsc --noEmit
npm run typecheck:watch   # incremental, run while editing
npm run lint              # biome lint .
npm run lint:fix          # biome lint --write .
npm run format            # biome format --write .
npm run check             # biome check . (lint + format + organize imports)
npm run check:fix         # auto-fix everything biome considers safe
npm run verify            # tsc + biome check; run before committing
```

Config lives in [`tsconfig.json`](./tsconfig.json) and [`biome.json`](./biome.json).
The TS config uses `module: "ESNext"` + `moduleResolution: "Bundler"` to match how
jiti resolves imports, with `strict: true` and `noUncheckedIndexedAccess: true` enabled.

### CI

GitHub Actions runs `npm run verify` on every push to `main` and on every pull
request, against Node 20 and 22 (matching pi's `engines` range). See
[`.github/workflows/verify.yml`](./.github/workflows/verify.yml). The workflow
can also be triggered manually from the Actions tab via `workflow_dispatch`.

## Layout

```
my-personal-pi/
├── package.json               # pi manifest + dependencies
├── extensions/
│   ├── mcp/
│   │   ├── index.ts
│   │   └── README.md
│   ├── web-research/
│   │   ├── index.ts
│   │   └── README.md
│   └── review-edits/
│       ├── index.ts
│       └── README.md
├── mcp-wrappers/
│   ├── unraid-docker-wrapper.py
│   └── README.md
└── docs/
    └── mcp-config-example.json
```

## License

MIT
