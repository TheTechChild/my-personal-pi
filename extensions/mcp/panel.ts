/**
 * The `/mcp` modal panel.
 *
 * Architecture:
 *   - Top-level view: a FilterableList with the configured servers. Filter
 *     input lives at the top (like fzf / command palettes), the list
 *     below. Focus toggles between input and list with up/down arrows.
 *     Letter-key actions (`r`, `t`, etc.) only fire when the list is
 *     focused, so they don't conflict with filter input.
 *   - Detail view: a plain SettingsList (no filter) opened via a row's
 *     submenu callback. Owns its own state subscription so it stays live.
 *   - Tools submenu (inside detail): another FilterableList with per-tool
 *     toggle controls.
 *
 * Reactive design: each level subscribes to the module-local emitter once
 * on open and calls `tui.requestRender()` from the callback. Subscriptions
 * are torn down via `dispose` (top-level) or via wrapped close callbacks
 * (submenus, since SettingsList doesn't call `dispose` on submenu
 * components).
 *
 * See `docs/tui.md` Pattern 6 ("custom footer") for the documented
 * `dispose: source.onChange(() => tui.requestRender())` pattern this
 * mirrors.
 */

import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getSettingsListTheme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, type SettingItem, SettingsList, matchesKey } from "@mariozechner/pi-tui";
import {
  addServerConfig,
  editServerConfig,
  getConfigFileChoices,
  persistServerDisabled,
  persistToolToggle,
  reconnectOne,
  reloadAll,
  removeServerConfig,
  toggleServerSession,
  toggleToolSession,
} from "./actions.js";
import { FilterableList } from "./filter-list.js";
import {
  clearPendingAction,
  getDisplayedMessage,
  setPendingAction,
  showToast,
  showToolToggleToast,
  subscribeToMessages,
} from "./messages.js";
import {
  type ConnectedServer,
  type ServerConfig,
  getServersSnapshot,
  getStatusSummary,
  servers,
  subscribe,
} from "./state.js";

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Status icon for a server. See spec §4.1. */
function statusIcon(server: ConnectedServer): string {
  if (server.error === "connecting") return "\u23f3"; // hourglass
  if (server.error) return "\u2717"; // cross
  if (server.sessionDisabled || server.config.disabled) return "\u2298"; // circled slash
  if (server.diagnostics.some((d) => d.level === "warning" || d.level === "error")) return "\u26a0"; // warning sign
  return "\u2713"; // check
}

/** Transport label — stdio / http / sse. */
function transportLabel(server: ConnectedServer): string {
  if (server.config.url) return "http";
  if (server.config.command) return "stdio";
  return "?";
}

/** Compress a long absolute path for the panel row. `~/...` shorthand + middle ellipsis. */
function formatPath(file: string, maxWidth: number): string {
  let s = file;
  const home = homedir();
  if (s.startsWith(`${home}/`)) s = `~${s.slice(home.length)}`;
  if (s.length <= maxWidth) return s;
  const keepEnd = Math.max(8, Math.floor((maxWidth - 1) * 0.66));
  const keepStart = maxWidth - keepEnd - 1;
  if (keepStart < 4) return `\u2026${s.slice(s.length - (maxWidth - 1))}`;
  return `${s.slice(0, keepStart)}\u2026${s.slice(s.length - keepEnd)}`;
}

/** Truncate inline error preview to `maxChars` with trailing ellipsis. */
function truncateInline(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}\u2026`;
}

/** Build the right-side summary string for a server row. */
function summaryText(server: ConnectedServer): string {
  if (server.error === "connecting") return "connecting\u2026";
  if (server.error) return truncateInline(server.error.replace(/\s+/g, " "), 60);
  if (server.sessionDisabled) return "disabled (session)";
  if (server.config.disabled) return "disabled";
  const counts: string[] = [];
  if (server.tools.size) counts.push(`${server.tools.size} tools`);
  if (server.resources.length) counts.push(`${server.resources.length} resources`);
  if (server.prompts.length) counts.push(`${server.prompts.length} prompts`);
  const warnings = server.diagnostics.filter((d) => d.level !== "info").length;
  if (warnings > 0) counts.push(`\u26a0 ${warnings}`);
  return counts.join("  ") || "no tools";
}

/** Build the row label string. Format: "{icon} {name}  {transport}  {source}". */
function rowLabel(server: ConnectedServer, width: number): string {
  const icon = statusIcon(server);
  const name = server.name.padEnd(28).slice(0, 28);
  const transport = transportLabel(server).padEnd(6);
  const consumed = 1 + 1 + 28 + 2 + 6 + 2;
  const sourceWidth = Math.max(10, Math.min(60, width - consumed));
  const source = formatPath(server.source.file || "<unknown>", sourceWidth);
  return `${icon} ${name}  ${transport}  ${source}`;
}

function buildServerItems(
  serverList: ConnectedServer[],
  width: number,
  theme: import("@mariozechner/pi-coding-agent").Theme,
  openSubmenu: (serverName: string, close: () => void) => Component,
): SettingItem[] {
  return serverList.map((s) => {
    const isFailed = Boolean(s.error && s.error !== "connecting");
    const label = rowLabel(s, width);
    const value = summaryText(s);
    return {
      id: s.name,
      label: isFailed ? theme.fg("error", label) : label,
      currentValue: isFailed ? theme.fg("error", value) : value,
      description: s.diagnostics
        .filter((d) => d.level !== "info")
        .slice(0, 2)
        .map((d) => `${d.level === "error" ? "\u2717" : "\u26a0"} ${d.message}`)
        .join("  \u2022  "),
      submenu: (_currentValue, doneSubmenu) => openSubmenu(s.name, () => doneSubmenu(undefined)),
    };
  });
}

function buildHeader(width: number): string {
  const { configured, connected, failed, pending } = getStatusSummary();
  const parts = [`${configured} configured`, `${connected} connected`];
  if (failed > 0) parts.push(`${failed} failed`);
  if (pending > 0) parts.push(`${pending} connecting`);
  const text = `MCP servers \u2014 ${parts.join(", ")}`;
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}\u2026` : text;
}

// ---------------------------------------------------------------------------
// Detail view helpers
// ---------------------------------------------------------------------------

function transportDetail(server: ConnectedServer): string {
  if (server.config.url) return `http  ${server.config.url}`;
  if (server.config.command) {
    const args = (server.config.args ?? []).join(" ");
    return `stdio  ${server.config.command}${args ? ` ${args}` : ""}`;
  }
  return "<unknown>";
}

function serverInfoLine(server: ConnectedServer): string {
  const v = server.client?.getServerVersion?.();
  if (!v) return "\u2014";
  const name = v.name ?? server.name;
  const version = v.version ?? "?";
  return `${name} v${version}`;
}

function capabilitiesLine(server: ConnectedServer): string {
  const caps = server.client?.getServerCapabilities?.();
  if (!caps) return "\u2014";
  const flags: string[] = [];
  if (caps.tools) flags.push("tools");
  if (caps.resources) flags.push("resources");
  if (caps.prompts) flags.push("prompts");
  if (caps.sampling) flags.push("sampling");
  if (caps.elicitation) flags.push("elicitation");
  if (caps.logging) flags.push("logging");
  if (caps.completions) flags.push("completions");
  return flags.join("  ") || "(none)";
}

function diagnosticsLine(server: ConnectedServer): string {
  if (server.diagnostics.length === 0) return "none";
  const errors = server.diagnostics.filter((d) => d.level === "error").length;
  const warnings = server.diagnostics.filter((d) => d.level === "warning").length;
  const infos = server.diagnostics.filter((d) => d.level === "info").length;
  const parts: string[] = [];
  if (errors > 0) parts.push(`\u2717 ${errors}`);
  if (warnings > 0) parts.push(`\u26a0 ${warnings}`);
  if (infos > 0) parts.push(`i ${infos}`);
  return parts.join("  ");
}

function buildDetailItems(server: ConnectedServer, openToolsSubmenu: (close: () => void) => Component): SettingItem[] {
  const items: SettingItem[] = [];

  let statusValue = "\u2014";
  if (server.error === "connecting") statusValue = "\u23f3 connecting\u2026";
  else if (server.error) statusValue = `\u2717 ${truncateInline(server.error.replace(/\s+/g, " "), 100)}`;
  else if (server.sessionDisabled) statusValue = "\u2298 disabled (session)";
  else if (server.config.disabled) statusValue = "\u2298 disabled (persisted)";
  else statusValue = "\u2713 connected";
  items.push({ id: "_status", label: "Status", currentValue: statusValue });

  items.push({ id: "_transport", label: "Transport", currentValue: transportDetail(server) });
  items.push({ id: "_source", label: "Source", currentValue: collapseHomePath(server.source.file) });
  items.push({ id: "_serverInfo", label: "Server info", currentValue: serverInfoLine(server) });
  items.push({ id: "_capabilities", label: "Capabilities", currentValue: capabilitiesLine(server) });
  items.push({ id: "_diagnostics", label: "Diagnostics", currentValue: diagnosticsLine(server) });

  for (const [i, diag] of server.diagnostics.entries()) {
    const icon = diag.level === "error" ? "\u2717" : diag.level === "warning" ? "\u26a0" : "i";
    items.push({
      id: `_diag${i}`,
      label: `  ${icon} ${diag.level}`,
      currentValue: truncateInline(diag.message, 80),
      description: diag.message,
    });
  }

  const sessionDisabledCount = server.sessionDisabledTools.size;
  const persistedDisabledCount = (server.config.disabledTools ?? []).length;
  const toolsSummary =
    server.tools.size === 0
      ? "\u2014"
      : sessionDisabledCount + persistedDisabledCount > 0
        ? `${server.tools.size} (\u2298 ${sessionDisabledCount + persistedDisabledCount})  enter to manage`
        : `${server.tools.size}  enter to manage`;
  items.push({
    id: "_tools",
    label: `Tools (${server.tools.size})`,
    currentValue: toolsSummary,
    description: previewNames([...server.tools.keys()], 5),
    submenu:
      server.tools.size === 0
        ? undefined
        : (_currentValue, doneSubmenu) => openToolsSubmenu(() => doneSubmenu(undefined)),
  });
  items.push({
    id: "_resources",
    label: `Resources (${server.resources.length})`,
    currentValue: server.resources.length === 0 ? "\u2014" : `${server.resources.length}`,
    description: previewNames(
      server.resources.map((r: { uri?: string; name?: string }) => r.name ?? r.uri ?? "?"),
      5,
    ),
  });
  items.push({
    id: "_prompts",
    label: `Prompts (${server.prompts.length})`,
    currentValue: server.prompts.length === 0 ? "\u2014" : `${server.prompts.length}`,
    description: previewNames(
      server.prompts.map((p: { name?: string }) => p.name ?? "?"),
      5,
    ),
  });

  if (server.instructions) {
    items.push({
      id: "_instructions",
      label: "Instructions",
      currentValue: truncateInline(server.instructions.replace(/\s+/g, " "), 80),
      description: server.instructions,
    });
  }

  return items;
}

function previewNames(names: string[], max: number): string {
  if (names.length === 0) return "";
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")}, +${names.length - max} more`;
}

function collapseHomePath(file: string): string {
  const home = homedir();
  return file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file;
}

// ---------------------------------------------------------------------------
// Footer hint component
// ---------------------------------------------------------------------------

function makeHintFooter(getHint: () => string, theme: { fg(color: "dim", text: string): string }): Component {
  return {
    render(width: number): string[] {
      const hint = getHint();
      const truncated = hint.length > width ? `${hint.slice(0, Math.max(0, width - 1))}\u2026` : hint;
      return ["", theme.fg("dim", truncated)];
    },
    invalidate() {},
  };
}

// ---------------------------------------------------------------------------
// SettingsList private-state helpers (for the detail view, which doesn't
// use FilterableList)
// ---------------------------------------------------------------------------

function getDetailSelectedId(list: SettingsList): string | undefined {
  const internal = list as unknown as {
    selectedIndex?: number;
    items?: SettingItem[];
  };
  const idx = internal.selectedIndex;
  const arr = internal.items;
  if (typeof idx !== "number" || !arr) return undefined;
  return arr[idx]?.id;
}

function setDetailSelectedId(list: SettingsList, id: string): void {
  const internal = list as unknown as {
    selectedIndex?: number;
    items?: SettingItem[];
  };
  if (!internal.items) return;
  const idx = internal.items.findIndex((it) => it.id === id);
  if (idx >= 0) internal.selectedIndex = idx;
}

function detailHasOpenSubmenu(list: SettingsList): boolean {
  return Boolean((list as unknown as { submenuComponent?: unknown }).submenuComponent);
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

/**
 * Open the `/mcp` modal panel. Resolves when the user closes it.
 *
 * Phase 1 keys (when the list is focused):
 *   r            reconnect selected server (re-reads its source file)
 *   Shift+R      reload ALL .mcp.json files; reconcile new/removed/changed
 *   t            toggle session-disabled on selected server (or tool, in tool submenu)
 *   p,a,e,Shift+D  notify "Coming in Phase 2"
 *
 * When the filter input is focused, all printable keys go to the input;
 * Esc clears the filter (or closes if already empty); Down arrow moves to
 * the list. From the list, Up arrow at row 0 moves back to the input.
 */
type McpPanelRestore = { selectedServer?: string; filter?: string };

export async function openMcpPanel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  restore: McpPanelRestore = {},
): Promise<void> {
  await ctx.ui.custom<void>((tui, theme, _kb, done) => {
    let assumedWidth = 100;

    const container = new Container();

    // Header — reads getStatusSummary() on every render.
    const header = {
      render(width: number) {
        return [theme.fg("accent", theme.bold(buildHeader(width))), ""];
      },
      invalidate() {},
    };
    container.addChild(header);

    const listHint = makeHintFooter(
      () =>
        "\u2191\u2193 navigate / focus  Enter detail  r reconnect  Shift+R reload all  t toggle  Esc clear/close   \u00b7  p/a/e/Shift+D \u2192 Phase 2",
      theme,
    );

    // In-panel message line. Sits between the header and the filter input;
    // shows pending-action and toast messages so panel feedback stays
    // contained inside the panel rather than leaking to pi's main scrollback
    // via ctx.ui.notify.
    const messageLine: Component = {
      render(width: number): string[] {
        const msg = getDisplayedMessage();
        if (!msg) return [""]; // reserved single line; empty when nothing to show
        const truncated = msg.text.length > width ? `${msg.text.slice(0, Math.max(0, width - 1))}\u2026` : msg.text;
        const colorKey: "accent" | "warning" | "error" =
          msg.tone === "error" ? "error" : msg.tone === "warning" ? "warning" : "accent";
        return [theme.fg(colorKey, truncated)];
      },
      invalidate() {},
    };
    container.addChild(messageLine);
    container.addChild({ render: () => [""], invalidate() {} }); // visual gap

    const unsubscribeMessages = subscribeToMessages(() => tui.requestRender());

    // Build the main FilterableList. Item construction is delegated to
    // buildServerItems; we re-call setItems on every refresh.
    let topList: FilterableList | null = null;

    const buildDetailComponent = (serverName: string, closeFromParent: () => void): Component =>
      makeDetailComponent(pi, ctx, tui, theme, serverName, closeFromParent, () => done());

    const refresh = () => {
      const snapshot = getServersSnapshot();
      const items = buildServerItems(snapshot, assumedWidth, theme, buildDetailComponent);
      if (topList === null) {
        topList = new FilterableList({
          items,
          theme,
          filterPlaceholder: "Filter servers (type to search)",
          maxVisible: Math.min(Math.max(snapshot.length + 2, 8), 24),
          onCancel: () => done(),
        });
        if (restore.filter) topList.setFilter(restore.filter);
        if (restore.selectedServer) topList.setSelectedId(restore.selectedServer);
        container.addChild(topList);
        container.addChild(listHint);
      } else {
        topList.setItems(items);
      }
    };

    refresh();
    const unsubscribe = subscribe(() => {
      refresh();
      tui.requestRender();
    });

    return {
      render(width: number) {
        if (width !== assumedWidth) {
          assumedWidth = width;
          // Rebuild rows so labels reflect new width truncation.
          if (topList) {
            const snapshot = getServersSnapshot();
            topList.setItems(buildServerItems(snapshot, assumedWidth, theme, buildDetailComponent));
          }
        }
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        const list = topList;
        if (!list) return;

        // While a submenu is open (the detail view), forward everything.
        if (list.hasOpenSubmenu()) {
          list.handleInput(data);
          tui.requestRender();
          return;
        }

        // When the LIST zone is focused, intercept action keys before they
        // reach SettingsList. When the INPUT zone is focused, FilterableList
        // routes everything to the input — we don't intercept anything,
        // letters go into the filter unimpeded.
        if (list.getZone() === "list") {
          if (
            handleListLevelKey(
              pi,
              ctx,
              list,
              data,
              () => done(),
              () => ({
                selectedServer: list.getSelectedId(),
                filter: list.getFilter(),
              }),
            )
          ) {
            tui.requestRender();
            return;
          }
        }

        list.handleInput(data);
        tui.requestRender();
      },
      // Propagate focus into the FilterableList so the hardware cursor lands
      // inside the filter input box when the input zone is active. pi's TUI
      // calls these setters when the overlay gains/loses focus.
      get focused(): boolean {
        return topList?.focused ?? false;
      },
      set focused(value: boolean) {
        if (topList) topList.focused = value;
      },
      dispose() {
        unsubscribe();
        unsubscribeMessages();
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Top-level key handler (LIST zone only)
// ---------------------------------------------------------------------------

function handleListLevelKey(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  list: FilterableList,
  data: string,
  closePanel: () => void,
  getRestore: () => McpPanelRestore,
): boolean {
  if (matchesKey(data, "shift+r")) {
    void runReloadAll(pi);
    return true;
  }
  const selected = list.getSelectedId();
  if (!selected) return false;

  if (matchesKey(data, "r")) {
    void runReconnectOne(pi, selected);
    return true;
  }
  if (matchesKey(data, "t")) {
    runToggleServer(pi, selected);
    return true;
  }
  if (matchesKey(data, "p")) {
    void runPersistServer(pi, selected);
    return true;
  }
  if (matchesKey(data, "a")) {
    runAfterPanelClose(
      closePanel,
      () => runAddServer(pi, ctx),
      () => openMcpPanel(pi, ctx, getRestore()),
    );
    return true;
  }
  if (matchesKey(data, "e")) {
    runAfterPanelClose(
      closePanel,
      () => runEditServer(pi, ctx, selected),
      () => openMcpPanel(pi, ctx, getRestore()),
    );
    return true;
  }
  if (matchesKey(data, "shift+d")) {
    runAfterPanelClose(
      closePanel,
      () => runRemoveServer(pi, ctx, selected),
      () => openMcpPanel(pi, ctx, getRestore()),
    );
    return true;
  }
  return false;
}

async function runReconnectOne(pi: ExtensionAPI, name: string): Promise<void> {
  setPendingAction(name, "Reconnecting");
  const result = await reconnectOne(pi, name);
  clearPendingAction(name);
  if (!result.ok) {
    showToast(`Reconnect failed for ${name}: ${result.message ?? "unknown error"}`, "warning");
  } else if (result.message) {
    showToast(result.message, "info");
  }
}

async function runReloadAll(pi: ExtensionAPI): Promise<void> {
  setPendingAction("*", "Reloading");
  const result = await reloadAll(pi);
  // Reload-all is a synchronous reconcile; any per-server connects it
  // triggered are tracked by the existing connecting-icon UI on each row.
  // Clear the global pending entry now and surface a summary toast.
  clearPendingAction("*");

  const summary: string[] = [];
  if (result.added.length) summary.push(`+${result.added.length} added (${result.added.join(", ")})`);
  if (result.removed.length) summary.push(`-${result.removed.length} removed (${result.removed.join(", ")})`);
  if (result.reconnected.length)
    summary.push(`~${result.reconnected.length} changed (${result.reconnected.join(", ")})`);
  const tone = result.errors.length ? "warning" : "info";
  if (summary.length === 0) {
    const msg = `Reload: ${result.unchanged.length} unchanged \u2014 nothing on disk has changed since last load. Use \`r\` to force-reconnect a single server.`;
    showToast(result.errors.length ? `${msg} (errors: ${result.errors.join("; ")})` : msg, tone);
    return;
  }
  if (result.unchanged.length) summary.push(`${result.unchanged.length} unchanged`);
  const message = `Reload: ${summary.join("  \u00b7  ")}`;
  showToast(result.errors.length ? `${message} (errors: ${result.errors.join("; ")})` : message, tone);
}

function runToggleServer(pi: ExtensionAPI, name: string): void {
  const server = servers.get(name);
  if (!server) return;
  if (server.config.disabled) {
    showToast(`${name} is disabled on disk; use \`e\` to edit or remove disabled from .mcp.json.`, "warning");
    return;
  }
  const newDisabled = toggleServerSession(pi, name);
  showToast(`${name}: ${newDisabled ? "disabled (session)" : "enabled"}`, "info");
}

function runAfterPanelClose(closePanel: () => void, action: () => Promise<void>, after?: () => Promise<void>): void {
  closePanel();
  setTimeout(() => {
    void (async () => {
      await action();
      await after?.();
    })();
  }, 0);
}

function notifyPostPanel(ctx: ExtensionContext, message: string, tone: "info" | "warning" | "error"): void {
  ctx.ui.notify(message, tone);
}

async function runPersistServer(pi: ExtensionAPI, name: string): Promise<void> {
  const result = await persistServerDisabled(pi, name);
  showToast(
    result.message ?? (result.ok ? `${name}: persisted` : `${name}: persist failed`),
    result.ok ? "info" : "warning",
  );
}

async function runPersistTool(pi: ExtensionAPI, serverName: string, toolName: string): Promise<void> {
  const result = await persistToolToggle(pi, serverName, toolName);
  if (!result.ok) {
    showToast(result.message ?? `${serverName}/${toolName}: persist failed`, "warning");
    return;
  }
  showToast(result.message ?? `${serverName}/${toolName}: persisted`, "info");
}

async function runEditServer(pi: ExtensionAPI, ctx: ExtensionContext, name: string): Promise<void> {
  const server = servers.get(name);
  if (!server) return;
  const before = JSON.stringify(server.config, null, 2);
  const edited = await ctx.ui.editor(`Edit MCP server: ${name}`, before);
  if (edited === undefined || edited.trim() === before.trim()) {
    notifyPostPanel(ctx, `${name}: edit cancelled`, "info");
    return;
  }

  let nextConfig: ServerConfig;
  try {
    nextConfig = JSON.parse(edited) as ServerConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notifyPostPanel(ctx, `${name}: invalid JSON: ${msg}`, "warning");
    return;
  }

  const result = await editServerConfig(pi, name, nextConfig);
  notifyPostPanel(
    ctx,
    result.message ?? (result.ok ? `${name}: edited` : `${name}: edit failed`),
    result.ok ? "info" : "warning",
  );
}

async function runAddServer(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const file = await ctx.ui.select("Add MCP server — choose .mcp.json", getConfigFileChoices());
  if (!file) {
    notifyPostPanel(ctx, "Add server cancelled", "info");
    return;
  }
  const name = (await ctx.ui.input("Add MCP server — name", "my-server"))?.trim();
  if (!name) {
    notifyPostPanel(ctx, "Add server cancelled", "info");
    return;
  }
  if (servers.has(name)) {
    notifyPostPanel(ctx, `${name}: server already exists`, "warning");
    return;
  }
  const transport = await ctx.ui.select("Add MCP server — template", [
    "stdio: local command",
    "stdio: npx package",
    "stdio: remote via mcp-remote",
    "http: streamable HTTP",
    "sse: server-sent events",
    "disabled test server",
  ]);
  if (!transport) {
    notifyPostPanel(ctx, "Add server cancelled", "info");
    return;
  }

  const template: ServerConfig = makeAddTemplate(transport);
  const edited = await ctx.ui.editor(`Add MCP server: ${name}`, JSON.stringify(template, null, 2));
  if (!edited) {
    notifyPostPanel(ctx, "Add server cancelled", "info");
    return;
  }
  let config: ServerConfig;
  try {
    config = JSON.parse(edited) as ServerConfig;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notifyPostPanel(ctx, `Add ${name}: invalid JSON: ${msg}`, "warning");
    return;
  }
  const result = await addServerConfig(pi, file, name, config);
  notifyPostPanel(
    ctx,
    result.message ?? (result.ok ? `added ${name}` : `failed to add ${name}`),
    result.ok ? "info" : "warning",
  );
}

function makeAddTemplate(template: string): ServerConfig {
  switch (template) {
    case "stdio: local command":
      return {
        command: "/absolute/path/to/server",
        args: [],
        env: { EXAMPLE_ENV: "${EXAMPLE_ENV}" },
      };
    case "stdio: npx package":
      return {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-example"],
        env: { EXAMPLE_API_KEY: "${EXAMPLE_API_KEY}" },
      };
    case "stdio: remote via mcp-remote":
      return {
        command: "npx",
        args: ["-y", "mcp-remote", "https://example.com/mcp"],
      };
    case "http: streamable HTTP":
      return {
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
      };
    case "sse: server-sent events":
      return {
        url: "https://example.com/sse",
        headers: { Authorization: "Bearer ${EXAMPLE_TOKEN}" },
      };
    default:
      return {
        command: "node",
        args: ["/tmp/nonexistent-mcp-server.js"],
        disabled: true,
      };
  }
}

async function runRemoveServer(pi: ExtensionAPI, ctx: ExtensionContext, name: string): Promise<void> {
  const server = servers.get(name);
  if (!server) return;
  const ok = await ctx.ui.confirm("Remove MCP server?", `Remove ${name} from ${collapseHomePath(server.source.file)}?`);
  if (!ok) {
    notifyPostPanel(ctx, `${name}: remove cancelled`, "info");
    return;
  }
  const result = await removeServerConfig(pi, name);
  notifyPostPanel(
    ctx,
    result.message ?? (result.ok ? `removed ${name}` : `failed to remove ${name}`),
    result.ok ? "info" : "warning",
  );
}

// ---------------------------------------------------------------------------
// Detail view (plain SettingsList; no filter)
// ---------------------------------------------------------------------------

function makeDetailComponent(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  tui: { requestRender(): void },
  theme: import("@mariozechner/pi-coding-agent").Theme,
  serverName: string,
  closeFromParent: () => void,
  closePanel: () => void,
): Component {
  const detailContainer = new Container();

  const detailHeader = {
    render(width: number): string[] {
      const title = `\u2190 ${serverName}`;
      const truncated = title.length > width ? `${title.slice(0, Math.max(0, width - 1))}\u2026` : title;
      return [theme.fg("accent", theme.bold(truncated)), ""];
    },
    invalidate() {},
  };
  detailContainer.addChild(detailHeader);

  let detailList: SettingsList | null = null;
  let unsubscribeDetail: (() => void) | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribeDetail?.();
    unsubscribeDetail = null;
    closeFromParent();
  };

  // Tools submenu factory. Built fresh each time SettingsList opens it,
  // because each invocation needs its own subscription/teardown lifecycle.
  const buildToolsSubmenu = (closeFromDetail: () => void): Component =>
    makeToolsSubmenu(pi, tui, theme, serverName, closeFromDetail);

  const detailHint = makeHintFooter(
    () =>
      "\u2191\u2193 navigate  Enter \u2192 manage tools  r reconnect  t toggle server  Esc back   \u00b7  p/a/e/Shift+D \u2192 Phase 2",
    theme,
  );

  const refreshDetail = () => {
    const server = servers.get(serverName);
    if (!server) {
      close();
      return;
    }

    // Don't rebuild while the Tools submenu is open — that would destroy
    // its `submenuComponent` reference.
    if (detailList && detailHasOpenSubmenu(detailList)) return;

    const items = buildDetailItems(server, buildToolsSubmenu);
    const previouslySelected = detailList ? getDetailSelectedId(detailList) : undefined;
    if (detailList) {
      detailContainer.removeChild(detailList);
      detailContainer.removeChild(detailHint);
    }
    detailList = new SettingsList(
      items,
      Math.min(Math.max(items.length + 2, 10), 28),
      getSettingsListTheme(),
      (_id, _newValue) => {},
      () => close(),
      { enableSearch: false },
    );
    detailContainer.addChild(detailList);
    detailContainer.addChild(detailHint);
    if (previouslySelected) setDetailSelectedId(detailList, previouslySelected);
  };

  refreshDetail();
  unsubscribeDetail = subscribe(() => {
    refreshDetail();
    tui.requestRender();
  });

  return {
    render(width: number): string[] {
      return detailContainer.render(width);
    },
    invalidate() {
      detailContainer.invalidate();
    },
    handleInput(data: string) {
      const list = detailList;
      if (list && !detailHasOpenSubmenu(list)) {
        if (matchesKey(data, "r")) {
          void runReconnectOne(pi, serverName);
          tui.requestRender();
          return;
        }
        if (matchesKey(data, "t")) {
          runToggleServer(pi, serverName);
          tui.requestRender();
          return;
        }
        if (
          matchesKey(data, "p") ||
          matchesKey(data, "a") ||
          matchesKey(data, "e") ||
          matchesKey(data, "shift+d") ||
          matchesKey(data, "shift+r")
        ) {
          if (matchesKey(data, "p")) void runPersistServer(pi, serverName);
          else if (matchesKey(data, "e"))
            runAfterPanelClose(
              closePanel,
              () => runEditServer(pi, ctx, serverName),
              () => openMcpPanel(pi, ctx, { selectedServer: serverName }),
            );
          else if (matchesKey(data, "shift+d"))
            runAfterPanelClose(
              closePanel,
              () => runRemoveServer(pi, ctx, serverName),
              () => openMcpPanel(pi, ctx, { selectedServer: serverName }),
            );
          else if (matchesKey(data, "a"))
            runAfterPanelClose(
              closePanel,
              () => runAddServer(pi, ctx),
              () => openMcpPanel(pi, ctx, { selectedServer: serverName }),
            );
          else showToast("Use Shift+R from the top-level list.", "info");
          tui.requestRender();
          return;
        }
      }
      list?.handleInput(data);
      tui.requestRender();
    },
  };
}

// ---------------------------------------------------------------------------
// Tools submenu (FilterableList of per-tool toggles)
// ---------------------------------------------------------------------------

function makeToolsSubmenu(
  pi: ExtensionAPI,
  tui: { requestRender(): void },
  theme: import("@mariozechner/pi-coding-agent").Theme,
  serverName: string,
  closeFromDetail: () => void,
): Component {
  const toolsContainer = new Container();

  const toolsHeader = {
    render(width: number): string[] {
      const title = `\u2190 ${serverName} \u2014 tools`;
      const truncated = title.length > width ? `${title.slice(0, Math.max(0, width - 1))}\u2026` : title;
      return [theme.fg("accent", theme.bold(truncated)), ""];
    },
    invalidate() {},
  };
  toolsContainer.addChild(toolsHeader);

  let toolsList: FilterableList | null = null;
  let toolsUnsub: (() => void) | null = null;
  let toolsClosed = false;

  const closeTools = () => {
    if (toolsClosed) return;
    toolsClosed = true;
    toolsUnsub?.();
    toolsUnsub = null;
    closeFromDetail();
  };

  const buildItems = (): SettingItem[] => {
    const server = servers.get(serverName);
    if (!server) return [];
    const persistedDisabled = new Set(server.config.disabledTools ?? []);
    return [...server.tools.keys()].sort().map((toolName) => {
      const isPersistedDisabled = persistedDisabled.has(toolName);
      const isSessionDisabled = server.sessionDisabledTools.has(toolName);
      let value: string;
      if (isPersistedDisabled) value = "\u2717 persisted (edit .mcp.json to re-enable)";
      else if (isSessionDisabled) value = "\u2298 session";
      else value = "\u2713 enabled";
      const isDisabled = isPersistedDisabled || isSessionDisabled;
      return {
        id: toolName,
        label: isDisabled ? theme.fg("error", toolName) : toolName,
        currentValue: isDisabled ? theme.fg("error", value) : value,
        description: server.tools.get(toolName)?.description ?? "",
      };
    });
  };

  const toolsHint = makeHintFooter(
    () => "\u2191\u2193 navigate / focus  t toggle session  Esc clear/back   \u00b7  p (persist) \u2192 Phase 2",
    theme,
  );

  const refresh = () => {
    const items = buildItems();
    if (items.length === 0) {
      // Server was removed.
      closeTools();
      return;
    }
    if (toolsList === null) {
      toolsList = new FilterableList({
        items,
        theme,
        filterPlaceholder: `Filter ${serverName} tools (type to search)`,
        maxVisible: Math.min(Math.max(items.length + 2, 10), 28),
        onCancel: () => closeTools(),
      });
      toolsContainer.addChild(toolsList);
      toolsContainer.addChild(toolsHint);
    } else {
      toolsList.setItems(items);
    }
  };

  refresh();
  toolsUnsub = subscribe(() => {
    refresh();
    tui.requestRender();
  });

  return {
    render(width: number): string[] {
      return toolsContainer.render(width);
    },
    invalidate() {
      toolsContainer.invalidate();
    },
    handleInput(data: string) {
      const list = toolsList;
      if (!list) return;
      if (list.hasOpenSubmenu()) {
        list.handleInput(data);
        tui.requestRender();
        return;
      }
      if (list.getZone() === "list") {
        const id = list.getSelectedId();
        if (id && matchesKey(data, "t")) {
          const server = servers.get(serverName);
          if (server && (server.config.disabledTools ?? []).includes(id)) {
            showToast(`${id} is disabled on disk; edit .mcp.json to re-enable.`, "warning");
          } else {
            const nowDisabled = toggleToolSession(pi, serverName, id);
            showToolToggleToast(serverName, id, nowDisabled);
          }
          tui.requestRender();
          return;
        }
        if (id && matchesKey(data, "p")) {
          void runPersistTool(pi, serverName, id);
          tui.requestRender();
          return;
        }
      }
      list.handleInput(data);
      tui.requestRender();
    },
    // Propagate focus into the FilterableList so the hardware cursor lands
    // in the filter input when the input zone is active.
    get focused(): boolean {
      return toolsList?.focused ?? false;
    },
    set focused(value: boolean) {
      if (toolsList) toolsList.focused = value;
    },
  } as Component;
}
