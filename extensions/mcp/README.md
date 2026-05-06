# pi mcp extension

Connects pi to any [Model Context Protocol](https://modelcontextprotocol.io)
server. Each configured server's tools, resources, and prompts are auto-
registered with pi. The extension also adds a `/mcp` modal panel for managing
servers from inside pi.

Supported transports:

- **stdio** — local process via `command` + `args`
- **streamable HTTP** — `url` (with optional `bearerToken`)
- **legacy SSE fallback** — automatic when streamable HTTP fails (disable with `PI_MCP_LEGACY_SSE_FALLBACK=0`)

## What you get

- Auto-registered MCP tools as `mcp__<server>__<tool>` (callable by the LLM)
- Three meta tools: `mcp_list_servers`, `mcp_read_resource`, `mcp_get_prompt`
- A `/mcp` panel for viewing, reconnecting, toggling, editing, adding, and
  removing servers without leaving pi
- Per-session and persisted server / tool toggles
- Diagnostics for common config mistakes (unresolved `${VAR}`, no auth, etc.)
- Secret-detection guardrails that block writes of literal credentials to
  git-tracked `.mcp.json` files

## Documentation

| Topic | Doc |
|---|---|
| The `/mcp` panel: keybindings, layout, modal handoff | [`docs/panel.md`](./docs/panel.md) |
| `.mcp.json` schema, file resolution, env var interpolation | [`docs/configuration.md`](./docs/configuration.md) |
| Disk writes, secret guardrails, backups | [`docs/persistence.md`](./docs/persistence.md) |
| Debug envs, `--text` fallback, common failure modes | [`docs/troubleshooting.md`](./docs/troubleshooting.md) |
| Internal state model, modules, hooks (for contributors) | [`docs/architecture.md`](./docs/architecture.md) |

## Quick start

1. Drop server entries into a `.mcp.json` (see
   [`docs/configuration.md`](./docs/configuration.md) and
   [`../../docs/mcp-config-example.json`](../../docs/mcp-config-example.json)).
2. Launch pi.
3. Type `/mcp`. The panel opens. See [`docs/panel.md`](./docs/panel.md).
