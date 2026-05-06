/**
 * Phase 1 actions invoked by the `/mcp` panel.
 *
 * These functions operate on the shared state in `state.ts` plus the live
 * `pi: ExtensionAPI` for tool-registration calls. They do NOT touch disk —
 * that's Phase 2's job. Persisted toggles, edits, adds, and removes will
 * land alongside the disk-write infrastructure in `persist.ts`.
 *
 * Cancellation semantics for actions that trigger a reconnect: the SDK's
 * `client.close()` rejects any in-flight `callTool()` requests, which
 * surfaces to pi as a tool error. The LLM's tool result is the SDK's error
 * message. Per spec §8 N2 — "cancel in-flight tool calls when their server
 * reconnects" — this is the desired behavior, even though we don't reach
 * for an explicit `AbortController` to do it.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { defaultUserMcpFile, parseMcpFile, removeServerFromFile, replaceServerInFile } from "./persist.js";
import {
  type ConnectedServer,
  type ServerConfig,
  type ServerDiagnostic,
  type ServerSourceInfo,
  notifyServerStateChange,
  servers,
  toolBindings,
} from "./state.js";

// ---------------------------------------------------------------------------
// Hooks back into index.ts
// ---------------------------------------------------------------------------
//
// We don't import these directly because that would create a tight coupling
// between `index.ts` (which still owns the SDK plumbing) and this module.
// Instead, `index.ts` registers them at extension init and we hold the
// references here. If a hook isn't registered, the matching action is a
// no-op — keeps unit tests trivial.

export interface ActionHooks {
  /**
   * Connect (or reconnect) a server with the given name and config. On
   * success, the new ConnectedServer is placed into the `servers` map and
   * its tools are registered with pi. On failure, the placeholder gets an
   * `error` field set. Returns when the connection attempt finishes
   * (success or failure); does not throw.
   */
  reconnectServer(name: string, config: ServerConfig, source: ServerSourceInfo): Promise<void>;

  /**
   * Tear down a server's SDK client and remove its bindings from the pi
   * tool registry. Does NOT remove the entry from `servers` — callers
   * decide whether to keep a placeholder or fully delete.
   */
  discardServer(name: string, server: ConnectedServer | undefined, reason: string): Promise<void>;

  /** Re-walk `.mcp.json` files; returns the merged config + per-server origin map. */
  loadConfigFromDisk(): {
    config: { mcpServers?: Record<string, ServerConfig> };
    origin: Map<string, string>;
    files: string[];
    errors: string[];
  };

  /** Compute static diagnostics from a server config (env vars, paths, etc.). */
  validateServerConfig(name: string, config: ServerConfig): ServerDiagnostic[];

  /** Resolve the `gitIgnored` flag for a source file. May shell out to `git`. */
  isGitIgnored(file: string): Promise<boolean>;

  /** The pi-tool name produced by `piToolName(serverName, toolName)`. */
  piToolName(serverName: string, toolName: string): string;
}

let hooks: ActionHooks | undefined;

export function registerActionHooks(h: ActionHooks): void {
  hooks = h;
}

// ---------------------------------------------------------------------------
// Active-tools overlay
// ---------------------------------------------------------------------------

/**
 * Recompute pi's active-tools set from the current state of `servers` and
 * `toolBindings`. Honors:
 *  - `server.config.disabled` (persisted server-level disable)
 *  - `server.sessionDisabled` (in-memory server-level disable)
 *  - `server.config.disabledTools` (persisted tool-level disable)
 *  - `server.sessionDisabledTools` (in-memory tool-level disable)
 *
 * Does not affect non-MCP tools — we read pi.getActiveTools(), strip out the
 * MCP-bound names that should be off, and put back the MCP-bound names that
 * should be on. Other extensions' toggles are preserved.
 */
export function applyToolOverlay(pi: ExtensionAPI): void {
  if (!hooks) return;
  const allActive = new Set(pi.getActiveTools());

  for (const [piName, binding] of toolBindings.entries()) {
    const server = binding.server;
    const serverDisabled = server.sessionDisabled || server.config.disabled === true;
    const toolDisabled =
      server.sessionDisabledTools.has(binding.originalName) ||
      (server.config.disabledTools ?? []).includes(binding.originalName);
    const enabled = !serverDisabled && !toolDisabled;
    if (enabled) allActive.add(piName);
    else allActive.delete(piName);
  }

  pi.setActiveTools([...allActive]);
}

// ---------------------------------------------------------------------------
// Server-level toggles (session only in Phase 1)
// ---------------------------------------------------------------------------

/** Flip `sessionDisabled` on the named server. Returns the new value. */
export function toggleServerSession(pi: ExtensionAPI, name: string): boolean {
  const server = servers.get(name);
  if (!server) return false;
  // Don't allow toggling a server that's persisted-disabled — user must
  // edit `.mcp.json` (Phase 2) or remove the disk flag.
  if (server.config.disabled) return false;
  server.sessionDisabled = !server.sessionDisabled;
  applyToolOverlay(pi);
  notifyServerStateChange();
  return server.sessionDisabled;
}

// ---------------------------------------------------------------------------
// Tool-level toggles (session only in Phase 1)
// ---------------------------------------------------------------------------

/** Flip a single tool's session-disabled state. Returns the new disabled value. */
export function toggleToolSession(pi: ExtensionAPI, serverName: string, toolName: string): boolean {
  const server = servers.get(serverName);
  if (!server) return false;
  if (server.sessionDisabledTools.has(toolName)) {
    server.sessionDisabledTools.delete(toolName);
  } else {
    server.sessionDisabledTools.add(toolName);
  }
  applyToolOverlay(pi);
  notifyServerStateChange();
  return server.sessionDisabledTools.has(toolName);
}

// ---------------------------------------------------------------------------
// Persisted toggles / add / edit / remove (Phase 2)
// ---------------------------------------------------------------------------

/** Files available as write targets for add-server. */
export function getConfigFileChoices(): string[] {
  const files = hooks?.loadConfigFromDisk().files ?? [];
  const global = defaultUserMcpFile();
  return [...new Set([...files, global])].sort();
}

/** Persist the selected server's current session-disabled state to disk. */
export async function persistServerDisabled(
  pi: ExtensionAPI,
  name: string,
): Promise<{ ok: boolean; message?: string }> {
  if (!hooks) return { ok: false, message: "actions not initialized" };
  const server = servers.get(name);
  if (!server) return { ok: false, message: `unknown server: ${name}` };
  const next: ServerConfig = { ...server.config };
  if (server.sessionDisabled) next.disabled = true;
  else next.disabled = undefined;

  const result = replaceServerInFile(server.source.file, name, next, { gitIgnored: server.source.gitIgnored });
  if (!result.ok) return { ok: false, message: formatPersistError(result.message, result.blockedSecrets) };

  server.config = next;
  server.sessionDisabled = false;
  applyToolOverlay(pi);
  notifyServerStateChange();
  return { ok: true, message: `${name}: persisted ${next.disabled ? "disabled" : "enabled"}` };
}

/** Toggle one tool in config.disabledTools and persist it to disk. */
export async function persistToolToggle(
  pi: ExtensionAPI,
  serverName: string,
  toolName: string,
): Promise<{ ok: boolean; disabled?: boolean; message?: string }> {
  if (!hooks) return { ok: false, message: "actions not initialized" };
  const server = servers.get(serverName);
  if (!server) return { ok: false, message: `unknown server: ${serverName}` };
  const disabled = new Set(server.config.disabledTools ?? []);
  const nextDisabled = !disabled.has(toolName);
  if (nextDisabled) disabled.add(toolName);
  else disabled.delete(toolName);

  const next: ServerConfig = { ...server.config };
  if (disabled.size > 0) next.disabledTools = [...disabled].sort();
  else next.disabledTools = undefined;

  const result = replaceServerInFile(server.source.file, serverName, next, { gitIgnored: server.source.gitIgnored });
  if (!result.ok) return { ok: false, message: formatPersistError(result.message, result.blockedSecrets) };

  server.config = next;
  // If this tool had a matching session overlay, drop it: disk now owns the state.
  server.sessionDisabledTools.delete(toolName);
  applyToolOverlay(pi);
  notifyServerStateChange();
  return {
    ok: true,
    disabled: nextDisabled,
    message: `${serverName}/${toolName}: persisted ${nextDisabled ? "disabled" : "enabled"}`,
  };
}

/** Replace a server's config on disk, then reconnect it from disk. */
export async function editServerConfig(
  pi: ExtensionAPI,
  name: string,
  nextConfig: ServerConfig,
): Promise<{ ok: boolean; message?: string }> {
  if (!hooks) return { ok: false, message: "actions not initialized" };
  const server = servers.get(name);
  if (!server) return { ok: false, message: `unknown server: ${name}` };

  const result = replaceServerInFile(server.source.file, name, nextConfig, { gitIgnored: server.source.gitIgnored });
  if (!result.ok) return { ok: false, message: formatPersistError(result.message, result.blockedSecrets) };
  return reconnectOne(pi, name);
}

/** Add a new server entry to a target .mcp.json, then smart-reload configs. */
export async function addServerConfig(
  pi: ExtensionAPI,
  file: string,
  name: string,
  config: ServerConfig,
): Promise<{ ok: boolean; message?: string }> {
  if (!hooks) return { ok: false, message: "actions not initialized" };
  const parsed = parseMcpFile(file);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  if (parsed.value.mcpServers?.[name]) return { ok: false, message: `${name} already exists in ${file}` };
  const gitIgnored = await hooks.isGitIgnored(file);
  const result = replaceServerInFile(file, name, config, { gitIgnored });
  if (!result.ok) return { ok: false, message: formatPersistError(result.message, result.blockedSecrets) };
  const reload = await reloadAll(pi);
  if (reload.errors.length)
    return { ok: false, message: `added ${name}, but reload had errors: ${reload.errors.join("; ")}` };
  return { ok: true, message: `added ${name}` };
}

/** Remove a server from disk and live state. */
export async function removeServerConfig(pi: ExtensionAPI, name: string): Promise<{ ok: boolean; message?: string }> {
  if (!hooks) return { ok: false, message: "actions not initialized" };
  const server = servers.get(name);
  if (!server) return { ok: false, message: `unknown server: ${name}` };
  const result = removeServerFromFile(server.source.file, name);
  if (!result.ok) return { ok: false, message: result.message };

  await hooks.discardServer(name, server, "removed via /mcp");
  for (const [piName, binding] of toolBindings.entries()) {
    if (binding.server.name === name) toolBindings.delete(piName);
  }
  servers.delete(name);
  applyToolOverlay(pi);
  notifyServerStateChange();
  return { ok: true, message: `removed ${name}` };
}

function formatPersistError(message: string, findings?: { path: string; suggestedEnv: string }[]): string {
  if (!findings?.length) return message;
  return `${message} ${findings.map((f) => `${f.path} → \${${f.suggestedEnv}}`).join("; ")}`;
}

// ---------------------------------------------------------------------------
// Reconnect single server
// ---------------------------------------------------------------------------

/**
 * Reconnect one server. Re-reads the config from its source file (so
 * out-of-band edits to `.mcp.json` get picked up), tears down the existing
 * client, and reconnects. Used by the panel's `r` keybinding.
 */
export async function reconnectOne(pi: ExtensionAPI, name: string): Promise<{ ok: boolean; message?: string }> {
  if (!hooks) return { ok: false, message: "actions not initialized" };
  const existing = servers.get(name);
  if (!existing) return { ok: false, message: `unknown server: ${name}` };

  const sourceFile = existing.source.file;
  if (!sourceFile || !existsSync(sourceFile)) {
    return { ok: false, message: `source file not found: ${sourceFile}` };
  }

  // Re-read just this file as strict JSON. `.mcp.json` is JSON, not JSONC.
  let parsed: { mcpServers?: Record<string, ServerConfig> };
  try {
    parsed = JSON.parse(readFileSync(sourceFile, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `failed to re-read ${sourceFile}: ${msg}` };
  }

  const newCfg = parsed.mcpServers?.[name];
  if (!newCfg) {
    return { ok: false, message: `server '${name}' is no longer in ${sourceFile}; press Shift+R to reload all` };
  }

  const staticDiagnostics = hooks.validateServerConfig(name, newCfg);
  const gitIgnored = await hooks.isGitIgnored(sourceFile);
  const newSource: ServerSourceInfo = { file: sourceFile, gitIgnored };

  // Tear down the old client. The SDK rejects any in-flight callTool
  // requests; the LLM gets a tool error and recovers.
  await hooks.discardServer(name, existing, "reconnect requested");

  // Drop bindings for this server's tools so registerServerTools sees a
  // clean slate.
  for (const [piName, binding] of toolBindings.entries()) {
    if (binding.server.name === name) toolBindings.delete(piName);
  }

  // Replace the placeholder while we wait. Preserve the user's session
  // overlays so a reconnect doesn't silently re-enable tools they disabled.
  const placeholder: ConnectedServer = {
    name,
    config: newCfg,
    client: undefined,
    transport: undefined,
    tools: new Map(),
    resources: [],
    prompts: [],
    source: newSource,
    diagnostics: [...staticDiagnostics],
    sessionDisabled: existing.sessionDisabled,
    sessionDisabledTools: new Set(existing.sessionDisabledTools),
    error: "connecting",
  };
  servers.set(name, placeholder);
  notifyServerStateChange();

  if (placeholder.sessionDisabled || placeholder.config.disabled) {
    placeholder.error = undefined;
    notifyServerStateChange();
    return { ok: true, message: `${name}: skipped reconnect (server is disabled)` };
  }

  await hooks.reconnectServer(name, newCfg, newSource);
  applyToolOverlay(pi);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Reload all configs from disk (Shift+R)
// ---------------------------------------------------------------------------

/**
 * Re-walk `.mcp.json` files and reconcile against current `servers`.
 *
 * - New servers: connect.
 * - Removed servers: discard + remove.
 * - Servers whose config changed: discard + reconnect with new config.
 * - Servers whose config matches what's in memory: leave alone.
 */
export async function reloadAll(pi: ExtensionAPI): Promise<{
  added: string[];
  removed: string[];
  reconnected: string[];
  unchanged: string[];
  errors: string[];
}> {
  const added: string[] = [];
  const removed: string[] = [];
  const reconnected: string[] = [];
  const unchanged: string[] = [];
  const errors: string[] = [];

  if (!hooks) {
    errors.push("actions not initialized");
    return { added, removed, reconnected, unchanged, errors };
  }

  const { config, origin, errors: parseErrors } = hooks.loadConfigFromDisk();
  errors.push(...parseErrors);
  const onDisk = new Map(Object.entries(config.mcpServers ?? {}));
  const inMemory = new Set(servers.keys());

  // Servers in memory that are no longer on disk → remove.
  for (const name of inMemory) {
    if (!onDisk.has(name)) {
      const existing = servers.get(name);
      await hooks.discardServer(name, existing, "removed from disk");
      for (const [piName, binding] of toolBindings.entries()) {
        if (binding.server.name === name) toolBindings.delete(piName);
      }
      servers.delete(name);
      removed.push(name);
    }
  }

  for (const [name, newCfg] of onDisk.entries()) {
    const existing = servers.get(name);
    const sourceFile = origin.get(name) ?? "<unknown>";
    const gitIgnored = await hooks.isGitIgnored(sourceFile);
    const newSource: ServerSourceInfo = { file: sourceFile, gitIgnored };

    if (!existing) {
      const staticDiagnostics = hooks.validateServerConfig(name, newCfg);
      const placeholder: ConnectedServer = {
        name,
        config: newCfg,
        client: undefined,
        transport: undefined,
        tools: new Map(),
        resources: [],
        prompts: [],
        source: newSource,
        diagnostics: [...staticDiagnostics],
        sessionDisabled: false,
        sessionDisabledTools: new Set(),
        error: "connecting",
      };
      servers.set(name, placeholder);
      added.push(name);
      if (newCfg.disabled) {
        placeholder.error = undefined;
        continue;
      }
      void hooks.reconnectServer(name, newCfg, newSource);
      continue;
    }

    if (configsEqual(existing.config, newCfg) && existing.source.file === sourceFile) {
      unchanged.push(name);
      continue;
    }

    const staticDiagnostics = hooks.validateServerConfig(name, newCfg);
    await hooks.discardServer(name, existing, "config changed on disk");
    for (const [piName, binding] of toolBindings.entries()) {
      if (binding.server.name === name) toolBindings.delete(piName);
    }
    const placeholder: ConnectedServer = {
      name,
      config: newCfg,
      client: undefined,
      transport: undefined,
      tools: new Map(),
      resources: [],
      prompts: [],
      source: newSource,
      diagnostics: [...staticDiagnostics],
      sessionDisabled: existing.sessionDisabled,
      sessionDisabledTools: new Set(existing.sessionDisabledTools),
      error: "connecting",
    };
    servers.set(name, placeholder);
    reconnected.push(name);
    if (newCfg.disabled) {
      placeholder.error = undefined;
      continue;
    }
    void hooks.reconnectServer(name, newCfg, newSource);
  }

  notifyServerStateChange();
  applyToolOverlay(pi);
  return { added, removed, reconnected, unchanged, errors };
}

/** Deep-equal compare of two ServerConfig objects. */
function configsEqual(a: ServerConfig, b: ServerConfig): boolean {
  return JSON.stringify(canonicalizeConfig(a)) === JSON.stringify(canonicalizeConfig(b));
}

/**
 * Sort keys + drop our `disabledTools` field from the comparison so a tool
 * toggle (which we ignore at the server-config level) doesn't trigger a
 * full reconnect.
 */
function canonicalizeConfig(cfg: ServerConfig): unknown {
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(cfg)
    .filter((k) => k !== "disabledTools")
    .sort();
  for (const k of keys) {
    const v = (cfg as Record<string, unknown>)[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const inner: Record<string, unknown> = {};
      for (const ik of Object.keys(v as Record<string, unknown>).sort()) {
        inner[ik] = (v as Record<string, unknown>)[ik];
      }
      sorted[k] = inner;
    } else {
      sorted[k] = v;
    }
  }
  return sorted;
}
