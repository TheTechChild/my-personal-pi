# review-edits

A pi extension that intercepts the agent's `edit` and `write` tool calls and
shows them to you as a diff in a side panel **before** they touch disk. You
accept or reject each one. Rejections are returned to the agent as feedback so
it can adapt rather than blindly retry.

This is "Stage 1" of a longer-term goal: making pi's chat the place where you
review (and eventually author) code, instead of bouncing to VS Code.

## What it does

- Overrides the built-in `edit` and `write` tools.
- When the agent calls one of them, the proposed change is queued and a
  side-panel overlay opens on the right showing the unified diff.
- You decide:
  - `a` accept this change (writes to disk, returns success to the agent)
  - `r` reject this change (no write, returns a "user rejected" message to the
    agent so it knows)
  - `n` / `p` next / previous pending change
  - `enter` show full file diff vs current (default view is already this)
  - `q` / `esc` close the panel — pending changes stay queued
- `/review` reopens the panel.
- `/review-auto on|off` toggles the gate. When `off`, changes pass straight
  through (agent works at full speed, no review).
- A status indicator (`● review: N pending`) appears in the footer when there
  is anything queued.

## Why an override and not a `tool_call` block?

`tool_call` handlers can `block: true`, but the agent then sees the call as
failed and tends to retry it. By owning the tool implementation we can return a
truthful, structured result ("user rejected — reason: …") that the agent reads
as feedback instead of as a transient error.

See `docs/extensions.md` (`tool-override.ts` example) for the pattern.

## Status

Stage 1. Read-only diff review, single-hunk granularity per tool call (each
`edit` or `write` is one reviewable unit). Per-hunk accept/reject within a
single `edit` is a reasonable Stage-1.5.
