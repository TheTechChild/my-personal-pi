# The `/mcp` panel

`/mcp` opens a blocking modal panel for managing MCP servers. Everything in
this doc applies to that panel.

## Layout

```
MCP servers — N configured, N connected[, N failed][, N connecting]

[in-panel message line]

╭─────────────────────────────────────────╮
│ Filter servers (type to search)         │
╰─────────────────────────────────────────╯

  ✓ angel-algolia          stdio   ~/angel-studios/.mcp.json    11 tools
  ✓ angel-content-data     stdio   ~/angel-studios/.mcp.json    32 tools
  ✗ angel-datadog          stdio   ~/angel-studios/.mcp.json    error: ...
  ⊘ angel-evolution        stdio   ~/angel-studios/.mcp.json    disabled
  ⏳ linear                 stdio   ~/angel-studios/.mcp.json    connecting…
  ...

  ↑↓ navigate / focus  Enter detail  r reconnect  Shift+R reload all
  t toggle  p persist  a add  e edit  Shift+D remove  Esc clear/close
```

### Status icons

| Icon | Meaning                                                         |
| ---- | --------------------------------------------------------------- |
| `✓`  | Connected, healthy                                              |
| `✗`  | Connection failed (red row) — full error in detail view         |
| `⏳` | Currently connecting                                            |
| `⊘`  | Disabled (session or persisted, see right column)               |
| `⚠`  | Connected but has warnings/errors in diagnostics                |

### Message line

A single line between the header and the filter input shows action feedback:

- `Reconnecting <name>…` while `r` is in flight (becomes `Reconnecting N
  servers…` if multiple are pending).
- `Reloading all servers…` while `Shift+R` is in flight.
- One-shot success messages (auto-clears after 3 seconds).
- Failures stick until the next event displaces them.

This avoids leaking action feedback into pi's main scrollback via
`ctx.ui.notify`.

## Keybindings (top-level list)

| Key             | Action                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `↑` / `↓`       | Move cursor; at top of list, `↑` moves focus to the filter input                                |
| `Enter`         | Drill into selected server (detail view)                                                        |
| `r`             | Reconnect selected server (re-reads its source `.mcp.json` first)                               |
| `Shift+R`       | Smart reload: reconcile added/removed/changed servers from disk; unchanged servers untouched    |
| `t`             | Toggle session-disabled for selected server                                                     |
| `p`             | Persist selected server's current `disabled` state to disk                                      |
| `a`             | Add a new server (closes panel → wizard → reopens)                                              |
| `e`             | Edit selected server's JSON (closes panel → editor → reopens with selection restored)           |
| `Shift+D`       | Remove selected server (closes panel → confirm → reopens)                                       |
| `Esc`           | Clear filter if non-empty; otherwise close the panel                                            |

`a`, `e`, and `Shift+D` use a "modal handoff" flow: the panel closes, the
sub-flow runs, and the panel reopens automatically with filter and selection
restored. See [Modal handoff](#modal-handoff) below.

## Filter zone vs. list zone

The filter input is always visible at the top. Focus toggles between two
zones:

- **Input zone**: typing fuzzy-filters the list. `↓` moves focus to the list.
  `Esc` clears a non-empty filter; on an empty filter, `Esc` closes the panel.
- **List zone**: `↑`/`↓` navigate. Letter keys are action shortcuts (`r`,
  `t`, `p`, etc.). At row 0, `↑` moves focus back to the filter input.

This is the fzf / command-palette model. There is no `/` to enter filter
mode — the input is always there.

The filter persists when you switch focus to the list, so you can type a
query, press `↓` to reach the list, and run actions on the filtered rows.

## Detail view

`Enter` on a row opens a non-filterable list of fields:

- Status, Transport, Source file, Server info, Capabilities, Diagnostics
- One row per diagnostic
- `Tools (N)` — `Enter` to drill into the tools submenu
- `Resources (N)`, `Prompts (N)`
- Server `Instructions` if the server returned any

### Detail view keybindings

| Key       | Action                                                          |
| --------- | --------------------------------------------------------------- |
| `↑` / `↓` | Move cursor                                                     |
| `Enter`   | On `Tools (N)`: open the tools submenu                          |
| `r`       | Reconnect this server                                           |
| `t`       | Toggle session-disabled on this server                          |
| `p`       | Persist disabled state to disk                                  |
| `e`       | Edit this server's JSON (handoff)                               |
| `Shift+D` | Remove this server (handoff)                                    |
| `a`       | Add a new server (handoff, returns to this server's detail)     |
| `Esc`     | Back to the top-level list                                      |

## Tools submenu

`Enter` on the `Tools (N)` line opens a filterable list of the server's
tools. Each tool shows one of three states:

- `✓ enabled` — registered with pi, callable by the LLM
- `⊘ session` — toggled off this session only (red text)
- `✗ persisted` — disabled in `.mcp.json` via `disabledTools[]` (red text)

### Tools submenu keybindings

| Key       | Action                                                                         |
| --------- | ------------------------------------------------------------------------------ |
| `↑` / `↓` | Navigate / move focus between filter input and list                            |
| `t`       | Toggle session-disabled for the selected tool                                  |
| `p`       | Persist the selected tool's state to `disabledTools[]` in the source `.mcp.json` |
| `Esc`     | Back to detail view (clears filter first if non-empty)                         |

The action feedback for tool toggles rolls up: toggling 5 tools rapidly on
the same server shows `<server>: 5 tools disabled (session)` instead of
five individual messages.

## Modal handoff

`a` (add server), `e` (edit server), and `Shift+D` (remove server) all use
the same pattern:

1. The `/mcp` panel closes.
2. Pi dialogs / pi's editor run the flow (`ctx.ui.select`, `ctx.ui.input`,
   `ctx.ui.editor`, `ctx.ui.confirm`).
3. The flow finishes (success, cancel, or error). A `ctx.ui.notify` posts
   the result to the main scrollback.
4. The `/mcp` panel reopens automatically. Filter text and selected row
   are restored.

Why handoff instead of nesting these flows inside the panel: nesting
`ctx.ui.editor` inside the active `ctx.ui.custom` panel wedged the focus
stack. Handoff-and-reopen is robust and feels like a single round trip
from the user's point of view.

## `/mcp --text` fallback

For non-TUI environments (`pi -p`, RPC mode, etc.), `/mcp --text` prints a
plain-text summary of configured servers and their state instead of opening
the modal. Use this when:

- The panel won't render (no TUI).
- Something is broken inside the panel and you want to see what's loaded
  without the UI getting in the way.
