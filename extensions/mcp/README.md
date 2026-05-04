# pi mcp extension

Connects pi to any [Model Context Protocol](https://modelcontextprotocol.io) server.
For each configured server, it auto-registers all of its tools, plus the meta tools
`mcp_list_servers`, `mcp_read_resource`, and `mcp_get_prompt`.

Supported transports:

- **stdio** — local process via `command` + `args`
- **streamable HTTP** — `url` (with optional `bearerToken`)
- **legacy SSE fallback** — automatic when streamable HTTP fails (disable with `PI_MCP_LEGACY_SSE_FALLBACK=0`)

## Configuration

Servers are defined in JSON files merged in this order (later overrides earlier):

1. `~/.pi/agent/mcp.json` (global)
2. `.mcp.json` walked from the current working directory up to the filesystem root (closer files override farther files)

### Schema

```jsonc
{
  "mcpServers": {
    "<server-name>": {
      // stdio
      "command": "uvx",
      "args": ["--from", "some-pkg", "some-bin"],
      "cwd": "~/work",                    // optional, ~ expansion supported
      "env": { "FOO": "bar" },            // optional

      // OR HTTP / SSE
      "url": "https://example.com/mcp",
      "bearerToken": "${MY_TOKEN}",       // optional, ${VAR} expansion
      "headers": { "X-Custom": "value" }, // optional

      "timeoutMs": 120000                 // optional, default 120s
    }
  }
}
```

`${ENV_VAR}` placeholders inside string values are expanded from `process.env` at connect time.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PI_MCP_TOOL_TIMEOUT_MS` | `120000` | Default per-tool timeout |
| `PI_MCP_LEGACY_SSE_FALLBACK` | `1` | Set to `0` to disable SSE fallback for HTTP servers |
| `PI_MCP_SHOW_STDERR` | unset | Set to `1` to forward stdio MCP server stderr to pi's console |

## Tools registered by this extension

For every connected MCP server, each remote tool is exposed as `mcp__<server>__<tool>`.

Three meta tools are also registered:

- `mcp_list_servers` — list configured servers and their tools/resources/prompts
- `mcp_read_resource` — read a resource by URI from a named server
- `mcp_get_prompt` — fetch a prompt template (with arguments) from a named server

## Example: Unraid management

```jsonc
// ~/.pi/agent/mcp.json
{
  "mcpServers": {
    "unraid-docker": {
      "command": "uvx",
      "args": ["--from", "mcp-server-docker", "python", "/path/to/my-personal-pi/mcp-wrappers/unraid-docker-wrapper.py"],
      "env": { "DOCKER_HOST": "ssh://root@192.168.1.152" }
    },
    "unraid": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/TheTechChild/unraid-mcp", "unraid-mcp"],
      "env": {
        "UNRAID_API_URL": "http://192.168.1.152/graphql",
        "UNRAID_API_KEY": "${UNRAID_API_KEY}",
        "UNRAID_VERIFY_SSL": "false",
        "UNRAID_MCP_TRANSPORT": "stdio"
      }
    }
  }
}
```

See [`../../docs/mcp-config-example.json`](../../docs/mcp-config-example.json) for a copy-pasteable template.
