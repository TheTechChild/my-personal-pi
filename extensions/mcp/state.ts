/**
 * Shared module-local state for the MCP extension.
 *
 * Owns:
 * - the `servers` and `toolBindings` maps
 * - a small reactive emitter so UI surfaces (the `/mcp` panel) can re-render
 *   when state changes, without polling
 *
 * Intentionally does NOT import from `@modelcontextprotocol/client` or any
 * other heavy module, so unit-testing or mocking against this surface is
 * cheap. Types involving the SDK use `any` here; the real types are
 * declared on the consumer side in `index.ts`.
 *
 * Reactive design rationale: see §4.6 of the panel spec on Desktop and the
 * pi-tui Pattern 6 ("custom footer", `docs/tui.md`) which establishes
 * `dispose: source.onChange(() => tui.requestRender())` as the documented
 * pattern for live-updating UI surfaces. We use a module-local emitter
 * (not `pi.events`, which is for cross-extension messaging).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerOAuthConfig = {
  enabled?: boolean;
  scopes?: string[];
  clientId?: string;
  clientSecret?: string;
  redirectUrl?: string;
};

export type ServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  bearerToken?: string;
  oauth?: ServerOAuthConfig;
  disabled?: boolean;
  /** Phase 2 schema extension: tool names that should NOT be registered with pi. */
  disabledTools?: string[];
  timeoutMs?: number;
};

/** Provenance: which `.mcp.json` file did this server's config come from? */
export type ServerSourceInfo = {
  /** Absolute path to the source file. */
  file: string;
  /**
   * True if `git check-ignore` says the file is ignored OR the file is
   * outside any git repo. False means the file is git-tracked, which
   * affects the secret-write rules in Phase 2.
   */
  gitIgnored: boolean;
};

export type DiagnosticLevel = "info" | "warning" | "error";

export type ServerDiagnostic = {
  level: DiagnosticLevel;
  message: string;
};

/**
 * A configured MCP server, possibly mid-connect, possibly errored.
 *
 * `client` and `transport` are typed as `any` here to keep this file free of
 * SDK imports; consumers cast to the real types where needed.
 */
export type ConnectedServer = {
  name: string;
  config: ServerConfig;
  client: any;
  transport: any;
  tools: Map<string, any>;
  resources: any[];
  prompts: any[];
  instructions?: string;
  error?: string;
  /** Where the config was loaded from. Set as soon as the server is registered. */
  source: ServerSourceInfo;
  /** Static diagnostics from config + dynamic ones from connection attempts. */
  diagnostics: ServerDiagnostic[];
  /** User toggled this server off via the panel; persists for the session only. */
  sessionDisabled: boolean;
  /** Tool names the user disabled via the panel; persists for the session only. */
  sessionDisabledTools: Set<string>;
};

export type ToolBinding = {
  server: ConnectedServer;
  originalName: string;
  tool: any;
};

// ---------------------------------------------------------------------------
// Maps (the actual mutable state)
// ---------------------------------------------------------------------------

/** Server name → ConnectedServer (or pending placeholder). */
export const servers = new Map<string, ConnectedServer>();

/** Pi tool name (e.g. `mcp__angel-content-data__get_content`) → binding metadata. */
export const toolBindings = new Map<string, ToolBinding>();

// ---------------------------------------------------------------------------
// Reactive emitter
// ---------------------------------------------------------------------------

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Subscribe to "something in state mutated." Returns the unsubscribe function
 * so consumers can use it as `dispose` on a `ctx.ui.custom()` component.
 *
 * The emitter is intentionally coarse: it does not pass which key changed, or
 * what the new value is. The panel re-renders the entire visible surface from
 * scratch. That's fine for our scale (~20 servers × ~30 tools each); if it
 * ever isn't, we can layer a finer-grained channel on top without breaking
 * the existing API.
 */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Notify all subscribers that something in `servers` or `toolBindings` may
 * have changed. Safe to call when nothing actually changed (subscribers are
 * expected to be idempotent re-render triggers).
 *
 * Wrapped in try/catch so a buggy listener can't take down the call site.
 */
export function notifyServerStateChange(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      if (process.env.PI_MCP_DEBUG === "1") {
        console.error("[pi-mcp] state listener threw:", err);
      }
    }
  }
}

/**
 * Drop all listeners. Called from the extension's `session_shutdown` handler
 * so a stale panel modal can't keep a closure alive across reloads.
 */
export function clearListeners(): void {
  listeners.clear();
}

// ---------------------------------------------------------------------------
// Convenience accessors for the panel
// ---------------------------------------------------------------------------

/** Snapshot of the current servers, sorted by name for deterministic UI ordering. */
export function getServersSnapshot(): ConnectedServer[] {
  return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Roll up status for the panel header. */
export function getStatusSummary(): { configured: number; connected: number; failed: number; pending: number } {
  let connected = 0;
  let failed = 0;
  let pending = 0;
  for (const s of servers.values()) {
    if (s.error === "connecting") pending++;
    else if (s.error) failed++;
    else connected++;
  }
  return { configured: servers.size, connected, failed, pending };
}
