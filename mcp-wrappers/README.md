# mcp-wrappers

Small helper scripts referenced by entries in `mcp.json`. They are not pi extensions
themselves, but they are co-located here so a single `git clone` brings everything
needed to make the configured MCP servers work.

## `unraid-docker-wrapper.py`

Wraps [`mcp-server-docker`](https://pypi.org/project/mcp-server-docker/) and patches
its JSON schema generator to emit `items` for every `type: "array"` field. Without
this patch, some LLM clients reject the schema as invalid.

### Usage

Referenced from `mcp.json` (or `~/.pi/agent/mcp.json`) like so:

```jsonc
{
  "mcpServers": {
    "unraid-docker": {
      "command": "uvx",
      "args": [
        "--from", "mcp-server-docker",
        "python", "/absolute/path/to/my-personal-pi/mcp-wrappers/unraid-docker-wrapper.py"
      ],
      "env": {
        "DOCKER_HOST": "ssh://root@<your-unraid-host>"
      }
    }
  }
}
```

### Requirements

- [`uv`](https://docs.astral.sh/uv/) installed (`curl -LsSf https://astral.sh/uv/install.sh | sh`)
- SSH key configured for the Unraid host so `DOCKER_HOST=ssh://...` works without prompts
- `uvx --from mcp-server-docker python ...` resolves the `docker` and `mcp_server_docker` Python deps automatically on first run

### Sanity check

```bash
uvx --from mcp-server-docker python ./mcp-wrappers/unraid-docker-wrapper.py --print-schema | head
```

Should print the JSON schema for `CreateContainerInput`.
