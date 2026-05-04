# pi web-research extension

Adds two generic internet research tools to pi:

- `web_search` — searches the web and returns ranked `{ title, url, snippet, source }` results.
- `web_fetch` — fetches a URL and returns readable extracted content plus metadata.

## Search providers

Default behavior:

- Uses Brave Search if `BRAVE_API_KEY` is set.
- Otherwise falls back to DuckDuckGo HTML search, which requires no API key.

Optional environment variables:

```bash
export WEB_SEARCH_PROVIDER=brave       # brave or duckduckgo
export BRAVE_API_KEY=...
export WEB_RESEARCH_TIMEOUT_MS=20000
export WEB_FETCH_MAX_BYTES=5000000
export WEB_FETCH_MAX_CHARS=30000
export WEB_RESEARCH_USER_AGENT='Mozilla/5.0 ...'
```

## Reload

Because this is installed under `~/.pi/agent/extensions/web-research/index.ts`, run `/reload` in pi or restart pi.
