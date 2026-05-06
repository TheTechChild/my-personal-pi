/**
 * Per-panel message bus.
 *
 * The `/mcp` panel renders a single status line between its header and the
 * filter input. This module owns the state for that line:
 *
 *  - **Pending actions**: keyed by server name. Auto-clears when the named
 *    server's `error` field leaves `"connecting"` (success or failure).
 *    When more than one is pending, the line shows a count instead of a
 *    server-specific message.
 *  - **Toasts**: transient one-shot messages (e.g. "Coming in Phase 2",
 *    Shift+R summary). Successes auto-clear after 3 s; failures stick
 *    until the next event displaces them.
 *
 * The current "displayed line" is computed from these two slots. Subscribers
 * are notified whenever the visible line changes; the panel re-renders.
 *
 * NOTE: this module deliberately doesn't import from `state.ts` to avoid a
 * cycle. The panel's existing state subscription drives the auto-clear by
 * calling `prunePendingActions(serversIterable)` on every state tick.
 */

const PENDING_ACTION_VERBS = ["Reconnecting", "Reloading"] as const;
type PendingActionVerb = (typeof PENDING_ACTION_VERBS)[number];

export interface PendingAction {
  /** "server name" or `"*"` to indicate a global action like Shift+R reload. */
  serverName: string;
  verb: PendingActionVerb;
}

export type ToastTone = "info" | "warning" | "error";

interface Toast {
  text: string;
  tone: ToastTone;
  /** When this toast should auto-clear (ms since epoch). undefined = sticky. */
  clearAt?: number;
}

interface ToolToggleAggregate {
  serverName: string;
  disabled: boolean;
  toolNames: Set<string>;
}

interface MessageStateInternal {
  pending: Map<string, PendingAction>;
  toast?: Toast;
  toolToggle?: ToolToggleAggregate;
}

const state: MessageStateInternal = {
  pending: new Map(),
  toast: undefined,
  toolToggle: undefined,
};

const listeners = new Set<() => void>();
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const SUCCESS_TOAST_MS = 3_000;

/** Subscribe to "the displayed message changed." Returns an unsubscribe. */
export function subscribeToMessages(handler: () => void): () => void {
  listeners.add(handler);
  return () => {
    listeners.delete(handler);
  };
}

function emit(): void {
  for (const handler of listeners) {
    try {
      handler();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Pending actions (per-server reconnect, global reload)
// ---------------------------------------------------------------------------

/**
 * Mark a server (or `"*"` for global) as having an in-flight action. The
 * panel's state subscription will auto-clear it once the relevant server's
 * `error` field leaves `"connecting"`. Global pending (`"*"`) is cleared
 * explicitly by the action itself; see `clearPendingAction("*")`.
 */
export function setPendingAction(serverName: string, verb: PendingActionVerb): void {
  state.pending.set(serverName, { serverName, verb });
  // Pending actions take precedence over toasts; clear any active toast.
  setToast(undefined);
  emit();
}

/** Explicitly clear a pending action (e.g. when its async resolves). */
export function clearPendingAction(serverName: string): void {
  if (state.pending.delete(serverName)) emit();
}

/**
 * Walk the current servers and clear pending entries for any server whose
 * `error` field is no longer `"connecting"`. Called from the panel's state
 * subscription. The passed-in iterable yields `{ name, error }` shapes; we
 * only need those two fields.
 */
export function prunePendingActions(servers: Iterable<{ name: string; error?: string }>): void {
  const stillConnecting = new Set<string>();
  for (const s of servers) if (s.error === "connecting") stillConnecting.add(s.name);

  let changed = false;
  for (const name of state.pending.keys()) {
    if (name === "*") continue; // global pendings are cleared explicitly
    if (!stillConnecting.has(name)) {
      state.pending.delete(name);
      changed = true;
    }
  }
  if (changed) emit();
}

// ---------------------------------------------------------------------------
// Toasts (transient one-shot messages)
// ---------------------------------------------------------------------------

/**
 * Show an info/warning/error toast. Successes (`info`) auto-clear after
 * `SUCCESS_TOAST_MS`; failures (`warning` / `error`) stick until the next
 * event displaces them.
 */
export function showToast(text: string, tone: ToastTone): void {
  state.toolToggle = undefined;
  const sticky = tone !== "info";
  setToast({ text, tone, clearAt: sticky ? undefined : Date.now() + SUCCESS_TOAST_MS });
  if (!sticky) {
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      // Only clear if the currently-displayed toast is still us. (A newer
      // toast may have been set in the interim.)
      if (state.toast?.clearAt && Date.now() >= state.toast.clearAt) {
        setToast(undefined);
      }
    }, SUCCESS_TOAST_MS + 50);
  }
  emit();
}

/**
 * Show a tool-toggle message. Consecutive toggles for the same server and
 * same direction are rolled up into "N tools disabled/enabled" for the
 * duration of the transient info window.
 */
export function showToolToggleToast(serverName: string, toolName: string, disabled: boolean): void {
  const existing = state.toolToggle;
  if (existing && existing.serverName === serverName && existing.disabled === disabled) {
    existing.toolNames.add(toolName);
  } else {
    state.toolToggle = { serverName, disabled, toolNames: new Set([toolName]) };
  }

  const aggregate = state.toolToggle;
  const count = aggregate?.toolNames.size ?? 1;
  const action = disabled ? "disabled (session)" : "enabled";
  const text = count === 1 ? `${serverName}/${toolName}: ${action}` : `${serverName}: ${count} tools ${action}`;
  setToast({ text, tone: "info", clearAt: Date.now() + SUCCESS_TOAST_MS });

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (state.toast?.clearAt && Date.now() >= state.toast.clearAt) {
      setToast(undefined);
    }
  }, SUCCESS_TOAST_MS + 50);
  emit();
}

function setToast(t: Toast | undefined): void {
  state.toast = t;
  if (!t) state.toolToggle = undefined;
  if (!t && toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = undefined;
  }
}

/** Drop everything. Called on session shutdown. */
export function clearAllMessages(): void {
  state.pending.clear();
  setToast(undefined);
  state.toolToggle = undefined;
  listeners.clear();
}

// ---------------------------------------------------------------------------
// Computed displayed line
// ---------------------------------------------------------------------------

export interface DisplayedMessage {
  text: string;
  tone: ToastTone;
}

/**
 * What should the message line currently show?
 *
 * Priority:
 *   1. Pending actions, if any (per-server-name when one, "N servers"
 *      when multiple, or "Reloading…" for the `"*"` global slot).
 *   2. Toast (transient or sticky failure), if no pending actions.
 *   3. `undefined` — line is empty.
 */
export function getDisplayedMessage(): DisplayedMessage | undefined {
  if (state.pending.size > 0) {
    // Global pending shows by itself with priority.
    const global = state.pending.get("*");
    if (global) return { text: `${global.verb} all servers\u2026`, tone: "info" };

    if (state.pending.size === 1) {
      const only = [...state.pending.values()][0]!;
      return { text: `${only.verb} ${only.serverName}\u2026`, tone: "info" };
    }
    // Multiple per-server pendings: show a count.
    // Use the verb of the first entry; in practice they're all "Reconnecting".
    const first = [...state.pending.values()][0]!;
    return { text: `${first.verb} ${state.pending.size} servers\u2026`, tone: "info" };
  }
  if (state.toast) return { text: state.toast.text, tone: state.toast.tone };
  return undefined;
}
