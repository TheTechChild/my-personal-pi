/**
 * review-edits
 *
 * Stage 1 of "shared editor in pi". Intercepts the agent's `edit` and `write`
 * tool calls, queues them for human review, and renders the queue as an
 * overlay diff panel anchored to the right side of the terminal.
 *
 * Implementation strategy: tool override (see tool-override.ts in pi examples).
 * We register tools with the same names as the built-ins (`edit`, `write`),
 * which shadow them. Inside our implementation we:
 *   1. Compute a unified diff between current file content and the proposed
 *      content.
 *   2. Push a PendingReview onto a queue.
 *   3. Open the overlay if it isn't already open.
 *   4. Await the user's accept/reject decision (resolved by a Promise stored
 *      on the PendingReview).
 *   5. On accept: perform the actual fs write, return a normal success result.
 *   6. On reject: return a structured "user rejected" result so the agent can
 *      adapt instead of retrying.
 *
 * Auto-mode (`/review-auto on`) bypasses the queue entirely for the rest of
 * the session.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { type TUI, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { createTwoFilesPatch } from "diff";
import { Type } from "typebox";

// ─── Types ──────────────────────────────────────────────────────────────────

type PendingKind = "edit" | "write";

interface PendingReview {
  id: number;
  kind: PendingKind;
  absolutePath: string;
  displayPath: string; // path relative to cwd if possible, else absolute
  /** Existing file content (empty string for new files via `write`). */
  beforeText: string;
  /** Proposed new file content. */
  afterText: string;
  /** Was the file new (didn't previously exist)? */
  isNewFile: boolean;
  /** Resolves when the user accepts/rejects. */
  resolve: (decision: ReviewDecision) => void;
}

type ReviewDecision = { type: "accept" } | { type: "reject"; reason?: string };

// ─── State ──────────────────────────────────────────────────────────────────

const queue: PendingReview[] = [];
let autoApprove = false;
let nextId = 1;

/**
 * Live overlay handles. Captured when we mount the panel so we can:
 *   - `closePanel()`  — resolve the overlay's `done` callback (closes it)
 *   - `tui.requestRender()` — repaint after external state changes
 *
 * Both are null when the panel is not currently shown.
 */
let closePanel: (() => void) | null = null;
let panelTui: TUI | null = null;

/**
 * The currently mounted panel component. We keep a reference so the tool
 * override can poke it (`refresh()`) when new items arrive while the panel
 * is already open.
 */
let activePanel: ReviewPanel | null = null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function toDisplayPath(cwd: string, absolutePath: string): string {
  const rel = relative(cwd, absolutePath);
  // If the relative path doesn't escape cwd, prefer it; otherwise show absolute.
  if (rel && !rel.startsWith("..")) return rel;
  return absolutePath;
}

function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

/**
 * Apply a single `edit` operation: locate `oldText` (must be unique) in
 * `beforeText`, replace with `newText`, return the result. Throws on miss /
 * non-uniqueness, exactly like pi's built-in.
 */
function applyEdit(beforeText: string, oldText: string, newText: string): string {
  if (oldText === newText) {
    throw new Error("oldText and newText are identical");
  }
  if (oldText.length === 0) {
    throw new Error("oldText must be a non-empty string");
  }
  const first = beforeText.indexOf(oldText);
  if (first === -1) {
    throw new Error("oldText not found in file");
  }
  const second = beforeText.indexOf(oldText, first + 1);
  if (second !== -1) {
    throw new Error("oldText is not unique in the file; provide a longer, distinguishing snippet");
  }
  return beforeText.slice(0, first) + newText + beforeText.slice(first + oldText.length);
}

/**
 * Build a unified-diff string. We render this ourselves rather than letting
 * `createPatch` produce a header, because we want clean colored output.
 *
 * Returns an array of typed lines for the renderer.
 */
type DiffLine =
  | { kind: "header"; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "context"; text: string }
  | { kind: "add"; text: string }
  | { kind: "remove"; text: string };

function buildDiffLines(beforeText: string, afterText: string, displayPath: string): DiffLine[] {
  // 3 lines of context is the conventional default and keeps panels short.
  const patch = createTwoFilesPatch(displayPath, displayPath, beforeText, afterText, "", "", {
    context: 3,
  });
  const out: DiffLine[] = [];
  const lines = patch.split("\n");
  for (const line of lines) {
    if (line.startsWith("===") || line.startsWith("Index:")) continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      // Skip the createTwoFilesPatch file headers — we render our own.
      continue;
    }
    if (line.startsWith("@@")) {
      out.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      out.push({ kind: "add", text: line });
    } else if (line.startsWith("-")) {
      out.push({ kind: "remove", text: line });
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — show as context.
      out.push({ kind: "context", text: line });
    } else if (line.length !== 0) {
      // Context line — preserve a single leading space marker so columns line up.
      // (Empty lines are trailing blanks from the patch generator; skip them.)
      out.push({ kind: "context", text: line });
    }
  }
  if (out.length === 0) {
    out.push({ kind: "header", text: "(no textual changes)" });
  }
  return out;
}

function summary(): string {
  if (queue.length === 0) return "";
  return `● review: ${queue.length} pending`;
}

function refreshStatus(ctx: ExtensionContext) {
  const text = summary();
  ctx.ui.setStatus("review-edits", text ? ctx.ui.theme.fg("accent", text) : undefined);
}

// ─── Overlay component ──────────────────────────────────────────────────────

class ReviewPanel {
  focused = false;

  /** Index into `queue`. Clamped on each render. */
  private cursor = 0;
  /** Vertical scroll offset within the current diff. */
  private scroll = 0;

  constructor(
    private theme: Theme,
    private done: () => void,
    private onDecision: (id: number, decision: ReviewDecision) => void,
  ) {}

  /** Called externally when queue changes. */
  refresh(): void {
    if (this.cursor >= queue.length) this.cursor = Math.max(0, queue.length - 1);
  }

  private current(): PendingReview | undefined {
    return queue[this.cursor];
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.done();
      return;
    }

    const cur = this.current();

    // Navigation between pending items
    if (data === "n" || matchesKey(data, "right")) {
      if (this.cursor < queue.length - 1) {
        this.cursor++;
        this.scroll = 0;
      }
      return;
    }
    if (data === "p" || matchesKey(data, "left")) {
      if (this.cursor > 0) {
        this.cursor--;
        this.scroll = 0;
      }
      return;
    }

    // Vertical scroll within the current diff
    if (matchesKey(data, "down") || data === "j") {
      this.scroll++;
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.scroll = Math.max(0, this.scroll - 1);
      return;
    }
    if (data === " ") {
      // page down
      this.scroll += 10;
      return;
    }

    if (!cur) return;

    if (data === "a") {
      this.onDecision(cur.id, { type: "accept" });
      return;
    }
    if (data === "r") {
      this.onDecision(cur.id, { type: "reject" });
      return;
    }
  }

  render(width: number): string[] {
    const th = this.theme;
    // Overlay width is constrained by overlayOptions; render to whatever we get.
    const innerW = Math.max(20, width - 2);
    const lines: string[] = [];

    const top = th.fg("border", `╭${"─".repeat(innerW)}╮`);
    const bot = th.fg("border", `╰${"─".repeat(innerW)}╯`);
    const pad = (s: string) => s + " ".repeat(Math.max(0, innerW - visibleWidth(s)));
    const row = (s: string) => th.fg("border", "│") + pad(s) + th.fg("border", "│");

    lines.push(top);

    if (queue.length === 0) {
      lines.push(row(` ${th.fg("muted", "no pending edits")}`));
      lines.push(row(""));
      lines.push(row(` ${th.fg("dim", "esc/q close • /review reopen later")}`));
      lines.push(bot);
      return lines;
    }

    const cur = this.current()!;
    const heading =
      ` ${th.fg("accent", th.bold(cur.displayPath))}` +
      ` ${th.fg("muted", `[${this.cursor + 1}/${queue.length}]`)}` +
      ` ${th.fg("dim", cur.kind === "write" ? (cur.isNewFile ? "(new)" : "(overwrite)") : "(edit)")}`;
    lines.push(row(truncateToWidth(heading, innerW, "")));
    lines.push(row(th.fg("border", `├${"─".repeat(innerW - 2)}┤`).slice(visibleWidth(th.fg("border", "│"))) || ""));
    // ^ if the bordered-mid-rule rendering is fiddly, fall back to a plain dim dashed line:
    lines.pop();
    lines.push(row(` ${th.fg("dim", "─".repeat(Math.max(0, innerW - 2)))}`));

    // Diff body, scrolled.
    const diff = buildDiffLines(cur.beforeText, cur.afterText, cur.displayPath);
    const bodyHeight = Math.max(5, 20); // soft cap; overlayOptions.maxHeight will clip if needed
    const maxScroll = Math.max(0, diff.length - bodyHeight);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const slice = diff.slice(this.scroll, this.scroll + bodyHeight);

    for (const dl of slice) {
      let styled: string;
      switch (dl.kind) {
        case "hunk":
          styled = th.fg("muted", dl.text);
          break;
        case "add":
          styled = th.fg("toolDiffAdded", dl.text);
          break;
        case "remove":
          styled = th.fg("toolDiffRemoved", dl.text);
          break;
        case "context":
          styled = th.fg("toolDiffContext", dl.text);
          break;
        case "header":
          styled = th.fg("muted", dl.text);
          break;
      }
      lines.push(row(` ${truncateToWidth(styled, innerW - 2, "")}`));
    }

    if (diff.length > bodyHeight) {
      lines.push(
        row(
          ` ${th.fg("dim", `… ${this.scroll + 1}-${Math.min(diff.length, this.scroll + bodyHeight)} of ${diff.length}`)}`,
        ),
      );
    }

    lines.push(row(""));
    lines.push(row(` ${th.fg("dim", "[a]ccept  [r]eject  [n]ext  [p]rev  [j/k] scroll  [q] close")}`));
    lines.push(bot);
    return lines;
  }

  invalidate(): void {}
}

// ─── Overlay management ─────────────────────────────────────────────────────

function openOverlay(ctx: ExtensionContext): void {
  if (closePanel) {
    panelTui?.requestRender();
    return;
  }

  ctx.ui
    .custom<void>(
      (tui, theme, _kb, done) => {
        panelTui = tui;
        closePanel = () => done();
        const panel = new ReviewPanel(
          theme,
          () => done(),
          (id, decision) => {
            // Resolve the matching pending review, then drop it from the queue.
            const idx = queue.findIndex((p) => p.id === id);
            if (idx === -1) return;
            const [removed] = queue.splice(idx, 1);
            removed!.resolve(decision);
            panel.refresh();
            refreshStatus(ctx);
            if (queue.length === 0) {
              // Auto-close when nothing left.
              done();
            } else {
              tui.requestRender();
            }
          },
        );
        activePanel = panel;
        return panel;
      },
      {
        overlay: true,
        overlayOptions: {
          anchor: "right-center",
          width: "50%",
          minWidth: 50,
          maxHeight: "90%",
          margin: 1,
          // Hide on very narrow terminals; user can still /review later.
          visible: (w) => w >= 100,
        },
      },
    )
    .finally(() => {
      closePanel = null;
      panelTui = null;
      activePanel = null;
    });
}

// ─── Tool overrides ─────────────────────────────────────────────────────────

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  oldText: Type.String({ description: "Exact text to replace (must be unique in file)" }),
  newText: Type.String({ description: "Replacement text" }),
});

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Full file content" }),
});

async function enqueueAndAwait(review: Omit<PendingReview, "id" | "resolve">): Promise<ReviewDecision> {
  return new Promise<ReviewDecision>((resolve) => {
    const full: PendingReview = { ...review, id: nextId++, resolve };
    queue.push(full);
  });
}

function rejectionResult(displayPath: string, reason?: string) {
  const note = reason ? ` Reason: ${reason}` : "";
  return {
    content: [
      {
        type: "text",
        text: `User reviewed and rejected this change to ${displayPath}.${note} Do not retry the same change. Ask the user what they would prefer, or propose a different approach.`,
      } as TextContent,
    ],
    details: { rejected: true, path: displayPath },
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: "text", text: message } as TextContent],
    details: { error: true },
    isError: true,
  };
}

export default function (pi: ExtensionAPI) {
  // ── /review-auto on|off ───────────────────────────────────────────────────
  pi.registerCommand("review-auto", {
    description: "Toggle review gate. Usage: /review-auto on|off|status",
    handler: async (args, ctx) => {
      const arg = (args || "").trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        autoApprove = arg === "on";
        ctx.ui.notify(`review-edits: gate ${autoApprove ? "OFF (auto-approve)" : "ON (manual review)"}`, "info");
        return;
      }
      ctx.ui.notify(
        `review-edits: ${autoApprove ? "auto-approving" : "manual review"} • ${queue.length} pending`,
        "info",
      );
    },
  });

  // ── /review (open panel) ──────────────────────────────────────────────────
  pi.registerCommand("review", {
    description: "Open the edit-review panel",
    handler: async (_args, ctx) => {
      openOverlay(ctx);
    },
  });

  // ── edit override ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "edit",
    label: "edit (review)",
    description:
      "Edit a file using exact text replacement. Replaces the unique occurrence of oldText with newText. " +
      "Changes are queued for human review unless review-auto is off.",
    parameters: editSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolvePath(ctx.cwd, params.path);
      const displayPath = toDisplayPath(ctx.cwd, absolutePath);

      let beforeText: string;
      try {
        beforeText = await readFile(absolutePath, "utf-8");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Cannot edit ${displayPath}: ${msg}`);
      }

      let afterText: string;
      try {
        afterText = applyEdit(beforeText, params.oldText, params.newText);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`edit failed for ${displayPath}: ${msg}`);
      }

      if (autoApprove) {
        await writeFile(absolutePath, afterText, "utf-8");
        return {
          content: [{ type: "text", text: `Edited ${displayPath} (auto-approved).` } as TextContent],
          details: { path: displayPath, autoApproved: true },
        };
      }

      const decision = await (async () => {
        const promise = enqueueAndAwait({
          kind: "edit",
          absolutePath,
          displayPath,
          beforeText,
          afterText,
          isNewFile: false,
        });
        refreshStatus(ctx);
        openOverlay(ctx);
        activePanel?.refresh();
        panelTui?.requestRender();
        return promise;
      })();

      refreshStatus(ctx);

      if (decision.type === "reject") {
        return rejectionResult(displayPath, decision.reason);
      }

      try {
        await writeFile(absolutePath, afterText, "utf-8");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Accepted but failed to write ${displayPath}: ${msg}`);
      }

      return {
        content: [{ type: "text", text: `Edited ${displayPath}.` } as TextContent],
        details: { path: displayPath, accepted: true },
      };
    },
  });

  // ── write override ────────────────────────────────────────────────────────
  pi.registerTool({
    name: "write",
    label: "write (review)",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. " +
      "Changes are queued for human review unless review-auto is off.",
    parameters: writeSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const absolutePath = resolvePath(ctx.cwd, params.path);
      const displayPath = toDisplayPath(ctx.cwd, absolutePath);

      const isNewFile = !existsSync(absolutePath);
      let beforeText = "";
      if (!isNewFile) {
        try {
          beforeText = await readFile(absolutePath, "utf-8");
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          return errorResult(`Cannot read existing ${displayPath} before overwrite: ${msg}`);
        }
      }
      const afterText = params.content;

      if (autoApprove) {
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, afterText, "utf-8");
        return {
          content: [
            {
              type: "text",
              text: `${isNewFile ? "Created" : "Overwrote"} ${displayPath} (auto-approved).`,
            } as TextContent,
          ],
          details: { path: displayPath, autoApproved: true, isNewFile },
        };
      }

      const decision = await (async () => {
        const promise = enqueueAndAwait({
          kind: "write",
          absolutePath,
          displayPath,
          beforeText,
          afterText,
          isNewFile,
        });
        refreshStatus(ctx);
        openOverlay(ctx);
        activePanel?.refresh();
        panelTui?.requestRender();
        return promise;
      })();

      refreshStatus(ctx);

      if (decision.type === "reject") {
        return rejectionResult(displayPath, decision.reason);
      }

      try {
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, afterText, "utf-8");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`Accepted but failed to write ${displayPath}: ${msg}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `${isNewFile ? "Created" : "Overwrote"} ${displayPath}.`,
          } as TextContent,
        ],
        details: { path: displayPath, accepted: true, isNewFile },
      };
    },
  });

  // ── On session end, resolve any in-flight reviews so we don't leak Promises ──
  pi.on("session_shutdown", async () => {
    while (queue.length > 0) {
      const p = queue.shift()!;
      p.resolve({ type: "reject", reason: "session ended before review" });
    }
    closePanel?.();
    closePanel = null;
    panelTui = null;
    activePanel = null;
  });
}
