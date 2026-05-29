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
| [`skills/`](./skills) | Agent skills (slash-command behaviors) mirrored from [mattpocock/skills](https://github.com/mattpocock/skills). See [Skills](#skills) below. |

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

## Skills

This package bundles agent skills under [`skills/`](./skills), declared in the
`pi.skills` manifest. Pi recursively discovers every `SKILL.md` folder, so they
are available as slash commands as soon as the package is installed. Use
`pi config` to enable/disable individual skills.

The `engineering/`, `productivity/`, and `misc/` buckets are **mirrored from
[mattpocock/skills](https://github.com/mattpocock/skills)** — see [Syncing
upstream skills](#syncing-upstream-skills).

### Engineering

- **[diagnose](./skills/engineering/diagnose/SKILL.md)** — Disciplined diagnosis loop for hard bugs and performance regressions.
- **[grill-with-docs](./skills/engineering/grill-with-docs/SKILL.md)** — Grilling session that challenges your plan against the domain model and updates `CONTEXT.md`/ADRs.
- **[triage](./skills/engineering/triage/SKILL.md)** — Triage issues through a state machine of triage roles.
- **[improve-codebase-architecture](./skills/engineering/improve-codebase-architecture/SKILL.md)** — Find deepening opportunities in a codebase, informed by `CONTEXT.md` and `docs/adr/`.
- **[configure-project-for-skills](./skills/engineering/configure-project-for-skills/SKILL.md)** — Scaffold the per-repo config the other engineering skills consume.
- **[tdd](./skills/engineering/tdd/SKILL.md)** — Test-driven development with a red-green-refactor loop.
- **[to-issues](./skills/engineering/to-issues/SKILL.md)** — Break a plan/spec/PRD into independently-grabbable GitHub issues.
- **[to-prd](./skills/engineering/to-prd/SKILL.md)** — Turn the current conversation into a PRD and submit it as a GitHub issue.
- **[zoom-out](./skills/engineering/zoom-out/SKILL.md)** — Get broader, higher-level context on an unfamiliar section of code.

### Productivity

- **[caveman](./skills/productivity/caveman/SKILL.md)** — Ultra-compressed communication mode.
- **[grill-me](./skills/productivity/grill-me/SKILL.md)** — Get relentlessly interviewed about a plan or design.
- **[write-a-skill](./skills/productivity/write-a-skill/SKILL.md)** — Create new skills with proper structure and progressive disclosure.

### Misc

- **[git-guardrails-claude-code](./skills/misc/git-guardrails-claude-code/SKILL.md)** — Hooks to block dangerous git commands before they execute.
- **[migrate-to-shoehorn](./skills/misc/migrate-to-shoehorn/SKILL.md)** — Migrate a project to the Shoehorn pattern.
- **[scaffold-exercises](./skills/misc/scaffold-exercises/SKILL.md)** — Scaffold coding exercises.
- **[setup-pre-commit](./skills/misc/setup-pre-commit/SKILL.md)** — Set up pre-commit hooks.

### Syncing upstream skills

The three buckets above are mirrored from upstream by
[`scripts/sync-mattpocock-skills.sh`](./scripts/sync-mattpocock-skills.sh) and
the [`sync-skills`](./.github/workflows/sync-skills.yml) GitHub Action, which
runs weekly (and on demand via the Actions tab) and opens a **pull request**
with any upstream changes for review.

```bash
scripts/sync-mattpocock-skills.sh                 # sync from upstream main
UPSTREAM_REF=v1.2.3 scripts/sync-mattpocock-skills.sh   # sync a specific ref
scripts/list-skills.sh                            # list all bundled skills
```

> **Heads up:** synced buckets are overwritten wholesale on each sync, so any
> local edits inside `engineering/`, `productivity/`, or `misc/` will be lost.
> To customize a skill, copy it into a bucket that the sync script does not
> touch (`BUCKETS` in the sync script controls which buckets are mirrored).

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
├── skills/                    # bundled agent skills (mirrored from upstream)
│   ├── engineering/
│   ├── productivity/
│   └── misc/
├── scripts/
│   ├── sync-mattpocock-skills.sh
│   └── list-skills.sh
└── docs/
    └── mcp-config-example.json
```

## License

MIT
