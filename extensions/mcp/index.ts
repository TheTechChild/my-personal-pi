import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { completeSimple } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  Client,
  SSEClientTransport,
  StdioClientTransport,
  StreamableHTTPClientTransport,
  type Tool,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client";
import { Type } from "typebox";
import { applyToolOverlay, registerActionHooks } from "./actions.js";
import { clearAllMessages } from "./messages.js";
import { createOAuthProvider, getOAuthStatus, oauthEnabled } from "./oauth.js";
import { openMcpPanel } from "./panel.js";
import { cleanupOldMcpBackups } from "./persist.js";
import {
  type ConnectedServer,
  type ServerConfig,
  type ServerDiagnostic,
  type ServerSourceInfo,
  clearListeners,
  notifyServerStateChange,
  servers,
  toolBindings,
} from "./state.js";

const EXT_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = Number(process.env.PI_MCP_TOOL_TIMEOUT_MS ?? 120_000);
const ENABLE_LEGACY_SSE_FALLBACK = process.env.PI_MCP_LEGACY_SSE_FALLBACK !== "0";

type McpConfig = {
  mcpServers?: Record<string, ServerConfig>;
};

let activeCtx: ExtensionContext | undefined;
let activePi: ExtensionAPI | undefined;
let configFiles: string[] = [];
let configErrors: string[] = [];
let initialized = false;
let initializing: Promise<void> | undefined;
// Set to true once this extension load has been invalidated (session shutdown / replacement / reload).
// Any deferred async work (e.g. an MCP server that finishes connecting after replacement) must check
// this and bail out cleanly instead of touching the now-stale `pi` / `ctx`.
let runtimeStale = false;

function isStaleCtxError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return msg.includes("stale after session replacement");
}

function isAuthRequiredError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  return /unauthorized|authorization required|oauth authorization required|401/i.test(msg);
}

async function discardServer(name: string, server: ConnectedServer | undefined, reason: string) {
  if (!server) return;
  if (process.env.PI_MCP_DEBUG === "1") console.error(`[pi-mcp] discarding ${name} (${reason})`);
  try {
    if (server.transport?.terminateSession) await server.transport.terminateSession();
  } catch {}
  try {
    await server.client?.close?.();
  } catch {}
  try {
    await server.transport?.close?.();
  } catch {}
  // We're not removing this server from the `servers` map here — the caller
  // owns map lifecycle. discardServer only tears down the SDK-side resources.
  notifyServerStateChange();
}

function expandTilde(path: string) {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function findConfigFiles(cwd: string) {
  const files: string[] = [];
  const global = join(homedir(), ".pi/agent/mcp.json");
  if (existsSync(global)) files.push(global);

  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, ".mcp.json");
    if (existsSync(candidate)) files.push(candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return files;
}

type LoadedConfig = {
  config: McpConfig;
  files: string[];
  errors: string[];
  /** For each server name in the merged config, which file the winning entry came from. */
  origin: Map<string, string>;
};

function loadConfig(cwd: string): LoadedConfig {
  const files = findConfigFiles(cwd);
  const merged: McpConfig = { mcpServers: {} };
  const origin = new Map<string, string>();
  const errors: string[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as McpConfig;
      if (parsed.mcpServers) {
        for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
          merged.mcpServers![name] = cfg;
          origin.set(name, file);
        }
      }
    } catch (error: any) {
      errors.push(`${file}: ${error?.message ?? String(error)}`);
    }
  }
  return { config: merged, files, errors, origin };
}

/**
 * Cache of git-ignore decisions per file path. Populated lazily; cleared on
 * extension shutdown (the cache lives only inside this module load, which
 * matches pi's reload-resets-everything model).
 */
const gitIgnoredCache = new Map<string, boolean>();

async function isGitIgnored(pi: ExtensionAPI, file: string): Promise<boolean> {
  const cached = gitIgnoredCache.get(file);
  if (cached !== undefined) return cached;
  // `git check-ignore <path>` exits 0 if the path is ignored, 1 if it is
  // tracked / not ignored, 128 if not in a git repo. We treat "not in a repo"
  // and "ignored" both as `gitIgnored=true` because the panel only cares
  // "is this file safe to write secrets to without leaking via git."
  let result = true;
  try {
    const proc = await pi.exec("git", ["check-ignore", "--quiet", file], {
      cwd: dirname(file),
      timeout: 5_000,
    });
    if (proc.code === 0) result = true;
    else if (proc.code === 1) result = false;
    else result = true; // 128 = not in a repo, treat as safe
  } catch {
    result = true;
  }
  gitIgnoredCache.set(file, result);
  return result;
}

/** Names of `${VAR}` references in any string-valued field of the config, recursively. */
function collectEnvVarRefs(config: ServerConfig): string[] {
  const seen = new Set<string>();
  const re = /\$\{([A-Z0-9_]+)\}/gi;
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
      while ((m = re.exec(value)) !== null) seen.add(m[1]!);
    } else if (Array.isArray(value)) {
      for (const v of value) visit(v);
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) visit(v);
    }
  };
  visit(config);
  return [...seen];
}

/** Generate static (non-runtime) diagnostics by inspecting the raw config. */
function validateServerConfig(name: string, config: ServerConfig): ServerDiagnostic[] {
  const diagnostics: ServerDiagnostic[] = [];

  // Unresolved ${VAR} references.
  const refs = collectEnvVarRefs(config);
  const unresolved = refs.filter((v) => !(v in process.env));
  if (unresolved.length > 0) {
    diagnostics.push({
      level: "warning",
      message: `references ${unresolved.map((v) => `\${${v}}`).join(", ")} which is/are not set in the environment`,
    });
  }

  // HTTP server without any auth signal.
  if (
    config.url &&
    !config.bearerToken &&
    !(config.headers && Object.keys(config.headers).length > 0) &&
    !oauthEnabled(config)
  ) {
    diagnostics.push({
      level: "info",
      message: "http server has no bearerToken, headers, or OAuth configured; the server may reject requests",
    });
  }

  if (oauthEnabled(config) && (config.bearerToken || config.headers?.Authorization || config.headers?.authorization)) {
    diagnostics.push({
      level: "warning",
      message: "OAuth is enabled alongside bearerToken/Authorization header; OAuth takes precedence for SDK auth",
    });
  }

  // stdio with relative command/args[0] and no cwd anchors. The MCP transport will
  // resolve against pi's cwd, which means the server only works from one directory.
  if (config.command && !config.cwd) {
    const looksRelative = !config.command.includes("/") || config.command.startsWith(".");
    const firstArgRelative = (config.args?.[0] ?? "").startsWith(".");
    if (firstArgRelative && !looksRelative) {
      // command is absolute (e.g. `node`) but args[0] is `./mcp-server/...`
      diagnostics.push({
        level: "warning",
        message: `relative path '${config.args?.[0]}' will be resolved against pi's cwd; set 'cwd' on the server entry to pin it`,
      });
    }
  }

  // `${PLUGIN_DIR}` is a Claude Code-ism that pi does not provide. Flag it loudly.
  if (refs.includes("PLUGIN_DIR")) {
    diagnostics.push({
      level: "error",
      message:
        "config uses ${PLUGIN_DIR}; pi does not define this variable. Replace with an absolute path or another env var",
    });
  }

  // Server name diagnostics (pi tool naming truncates at 80 chars).
  if (name.length > 60) {
    diagnostics.push({
      level: "warning",
      message: `server name is ${name.length} chars; tool names will be truncated`,
    });
  }

  return diagnostics;
}

/** Build the placeholder `ConnectedServer` we put in the map before/while connecting. */
function makePendingServer(
  name: string,
  config: ServerConfig,
  source: ServerSourceInfo,
  diagnostics: ServerDiagnostic[],
  state: "connecting" | { error: string },
): ConnectedServer {
  return {
    name,
    config,
    client: undefined as any,
    transport: undefined,
    tools: new Map(),
    resources: [],
    prompts: [],
    source,
    diagnostics: [...diagnostics],
    sessionDisabled: false,
    sessionDisabledTools: new Set(),
    error: state === "connecting" ? "connecting" : state.error,
  };
}

function expandEnvValue(value: string) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, key) => process.env[key] ?? "");
}

function expandEnv(env: Record<string, string> | undefined) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) out[key] = expandEnvValue(String(value));
  return out;
}

function safeName(name: string) {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

function piToolName(serverName: string, toolName: string) {
  return `mcp__${safeName(serverName)}__${safeName(toolName)}`.slice(0, 128);
}

function schemaForPiTool(schema: any) {
  if (!schema || typeof schema !== "object") return Type.Object({});
  if (schema.type === "object") return Type.Unsafe(schema);
  return Type.Unsafe({ type: "object", additionalProperties: true, description: "MCP tool arguments." });
}

function textBlock(text: string) {
  return { type: "text" as const, text };
}

function formatContentBlocks(blocks: any[] | undefined): string {
  return (blocks ?? [])
    .map((block) => {
      if (block.type === "text") return block.text ?? "";
      if (block.type === "image")
        return `[image ${block.mimeType ?? "unknown"}, ${String(block.data ?? "").length} base64 chars]`;
      if (block.type === "audio")
        return `[audio ${block.mimeType ?? "unknown"}, ${String(block.data ?? "").length} base64 chars]`;
      if (block.type === "resource_link") return `[resource_link ${block.uri}${block.name ? ` (${block.name})` : ""}]`;
      if (block.type === "resource") {
        const r = block.resource ?? {};
        if ("text" in r) return `[resource ${r.uri ?? ""}]\n${r.text}`;
        return `[resource ${r.uri ?? ""}, blob ${String(r.blob ?? "").length} base64 chars]`;
      }
      return JSON.stringify(block);
    })
    .filter(Boolean)
    .join("\n");
}

function mcpToPiContent(blocks: any[] | undefined) {
  const text = formatContentBlocks(blocks);
  return [textBlock(text || "(empty MCP result)")];
}

function mcpSamplingContentToText(content: any): string {
  if (!content) return "";
  if (content.type === "text") return content.text ?? "";
  if (content.type === "image") return `[image ${content.mimeType ?? "unknown"}]`;
  if (content.type === "audio") return `[audio ${content.mimeType ?? "unknown"}]`;
  return JSON.stringify(content);
}

async function samplingHandler(request: any) {
  const ctx = activeCtx;
  if (!ctx?.model) throw new Error("MCP sampling requested but pi has no active model context.");
  // Capture into a local so TS narrowing survives the closures below.
  const model = ctx.model;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model as any);
  if (!auth.ok) throw new Error(auth.error);

  const systemPrompt = [
    request.params?.systemPrompt,
    "You are answering an MCP server-initiated sampling request. Return only the assistant response requested by the server.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages = (request.params?.messages ?? [])
    .map((m: any) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: [{ type: "text" as const, text: mcpSamplingContentToText(m.content) }],
      timestamp: Date.now(),
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: undefined,
      stopReason: undefined,
    }))
    .map((m: any) => {
      if (m.role === "assistant") {
        return {
          role: "assistant",
          content: m.content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: emptyUsage(),
          stopReason: "stop",
          timestamp: Date.now(),
        };
      }
      return { role: "user", content: m.content, timestamp: Date.now() };
    });

  const response = await completeSimple(
    model as any,
    { systemPrompt, messages },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      signal: ctx.signal,
      maxTokens: Math.min(Number(request.params?.maxTokens ?? 4096), model.maxTokens ?? 4096),
    },
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? `Sampling failed: ${response.stopReason}`);
  }
  const text = response.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
  return { model: model.id, role: "assistant" as const, content: { type: "text" as const, text } };
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

async function elicitationHandler(request: any) {
  const ctx = activeCtx;
  if (!ctx?.hasUI) return { action: "decline" as const };
  const params = request.params ?? {};
  if (params.mode === "url") {
    const url = params.url ?? params.href ?? "";
    ctx.ui.notify(`MCP server asks you to visit: ${url}`, "info");
    const ok = await ctx.ui.confirm(
      "MCP URL elicitation",
      `${params.message ?? "MCP server requested URL-based input."}\n\n${url}\n\nAccept?`,
    );
    return ok ? { action: "accept" as const } : { action: "decline" as const };
  }

  const schema = params.requestedSchema ?? params.schema ?? {};
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const content: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries<any>(props)) {
    const label = `${params.message ?? "MCP server requests input"}\n\n${key}${required.has(key) ? " *" : ""}${prop?.description ? `: ${prop.description}` : ""}`;
    if (prop?.type === "boolean") {
      content[key] = await ctx.ui.confirm("MCP elicitation", label);
    } else {
      // Use the prop default as the placeholder when present so the user sees it pre-filled in the dialog hint.
      const placeholder = prop?.default === undefined ? label : `${label} (default: ${String(prop.default)})`;
      const answer = await ctx.ui.input("MCP elicitation", placeholder);
      if (!answer && required.has(key)) return { action: "decline" as const };
      if (answer || prop?.default !== undefined) {
        content[key] = prop?.type === "number" || prop?.type === "integer" ? Number(answer) : answer;
      }
    }
  }
  return { action: "accept" as const, content };
}

function rootsHandler() {
  const ctx = activeCtx;
  const cwd = ctx?.cwd ?? process.cwd();
  return { roots: [{ uri: `file://${cwd}`, name: "Current workspace" }] };
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void | Promise<void>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        void onTimeout?.();
      } catch {}
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeHeadersFetch(headers: Record<string, string> | undefined) {
  if (!headers || Object.keys(headers).length === 0) return undefined;
  return async (input: any, init?: any) => {
    const merged = new Headers(init?.headers);
    for (const [key, value] of Object.entries(headers)) merged.set(key, expandEnvValue(value));
    return fetch(input, { ...init, headers: merged });
  };
}

async function connectServer(name: string, config: ServerConfig, pi: ExtensionAPI): Promise<ConnectedServer> {
  // serverRef is assigned at the bottom of this function but is captured by the listChanged
  // callback constructed below. The callback is only invoked asynchronously after connection and
  // capability negotiation, so by the time it fires serverRef is populated. We must use `let`
  // here (a const can't be referenced before its initializer in TS) — Biome's useConst would
  // miss that the read happens inside a closure that fires later, hence the suppression.
  // biome-ignore lint/style/useConst: forward reference into a callback that runs after assignment
  let serverRef: ConnectedServer | undefined;
  const client = new Client({ name: "pi-mcp", version: EXT_VERSION }, {
    capabilities: {
      roots: { listChanged: true },
      sampling: {},
      elicitation: { form: {}, url: {} },
    },
    listChanged: {
      tools: {
        onChanged: (_error: any, tools: Tool[] | undefined) => {
          if (!tools || !serverRef) return;
          if (runtimeStale) return; // captured `pi` is dead; ignore late updates from the server
          try {
            registerServerTools(pi, serverRef, tools);
          } catch (error) {
            if (isStaleCtxError(error)) {
              runtimeStale = true;
              if (process.env.PI_MCP_DEBUG === "1")
                console.error(`[pi-mcp] ignoring listChanged for ${name}: runtime stale`);
              return;
            }
            throw error;
          }
        },
      },
    },
  } as any);
  client.setRequestHandler("roots/list" as any, rootsHandler as any);
  client.setRequestHandler("sampling/createMessage" as any, samplingHandler as any);
  client.setRequestHandler("elicitation/create" as any, elicitationHandler as any);

  let transport: any;
  if (config.url) {
    const headers = { ...(config.headers ?? {}) };
    let authProvider: any = undefined;
    if (oauthEnabled(config)) authProvider = createOAuthProvider(name, config, { interactive: false });
    else if (config.bearerToken) authProvider = { token: async () => expandEnvValue(config.bearerToken!) };
    transport = new StreamableHTTPClientTransport(new URL(expandEnvValue(config.url)), {
      authProvider,
      fetch: makeHeadersFetch(headers),
      requestInit: Object.keys(headers).length ? { headers } : undefined,
    } as any);
    try {
      await withTimeout(
        client.connect(transport, { timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any),
        config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        `MCP HTTP connect ${name}`,
        () => transport.close?.(),
      );
    } catch (error) {
      if (oauthEnabled(config) && isAuthRequiredError(error)) throw error;
      if (!ENABLE_LEGACY_SSE_FALLBACK) throw error;
      transport = new SSEClientTransport(new URL(expandEnvValue(config.url)), {
        authProvider,
        requestInit: Object.keys(headers).length ? { headers } : undefined,
      } as any);
      await withTimeout(
        client.connect(transport, { timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any),
        config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        `MCP legacy SSE connect ${name}`,
        () => transport.close?.(),
      );
    }
  } else {
    if (!config.command) throw new Error("MCP server config requires either command or url");
    transport = new StdioClientTransport({
      command: expandEnvValue(config.command),
      args: (config.args ?? []).map(expandEnvValue),
      cwd: config.cwd ? expandTilde(expandEnvValue(config.cwd)) : undefined,
      env: { ...getDefaultEnvironment(), ...expandEnv(config.env) },
      stderr: "pipe",
    } as any);
    if (transport.stderr) {
      transport.stderr.on("data", (chunk: Buffer) => {
        const msg = chunk.toString("utf8").trim();
        if (msg && process.env.PI_MCP_SHOW_STDERR === "1") console.error(`[mcp:${name}] ${msg}`);
      });
    }
    await withTimeout(
      client.connect(transport, { timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any),
      config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      `MCP stdio connect ${name}`,
      () => transport.close?.(),
    );
  }

  serverRef = {
    name,
    config,
    client,
    transport,
    tools: new Map(),
    resources: [],
    prompts: [],
    instructions: client.getInstructions(),
    // These get filled in by the caller (connectAndAttach) which knows the
    // source and pre-computed diagnostics. We default them here so the type
    // checker is happy.
    source: { file: "", gitIgnored: true },
    diagnostics: [],
    sessionDisabled: false,
    sessionDisabledTools: new Set(),
  };
  await refreshServerCaches(serverRef);
  return serverRef;
}

async function refreshServerCaches(server: ConnectedServer) {
  const caps = server.client?.getServerCapabilities?.() ?? {};
  const tools = caps.tools
    ? await listAll(
        (cursor) =>
          server.client.listTools({ cursor } as any, { timeout: server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any),
        "tools",
      )
    : [];
  server.tools = new Map(tools.map((tool: Tool) => [tool.name, tool]));
  if (caps.resources) {
    try {
      server.resources = await listAll((cursor) => server.client.listResources({ cursor } as any), "resources");
    } catch {
      server.resources = [];
    }
  } else {
    server.resources = [];
  }
  if (caps.prompts) {
    try {
      server.prompts = await listAll((cursor) => server.client.listPrompts({ cursor } as any), "prompts");
    } catch {
      server.prompts = [];
    }
  } else {
    server.prompts = [];
  }
}

async function listAll(fn: (cursor?: string) => Promise<any>, key: string) {
  const all: any[] = [];
  let cursor: string | undefined;
  do {
    const page = await fn(cursor);
    all.push(...(page[key] ?? []));
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

function registerServerTools(pi: ExtensionAPI, server: ConnectedServer, tools: Tool[]) {
  if (runtimeStale) return;
  let mutated = false;
  for (const tool of tools) {
    const name = piToolName(server.name, tool.name);
    if (toolBindings.has(name)) continue;
    toolBindings.set(name, { server, originalName: tool.name, tool });
    server.tools.set(tool.name, tool);
    mutated = true;
    try {
      pi.registerTool({
        name,
        label: `MCP: ${server.name}/${tool.name}`,
        description: tool.description ?? `MCP tool ${tool.name} from server ${server.name}`,
        promptSnippet: `${server.name}/${tool.name}: ${tool.description ?? "MCP tool"}`,
        promptGuidelines: [
          `Use ${name} automatically when ${server.name}/${tool.name} is relevant; do not ask for confirmation unless a separate user-defined hook blocks it.`,
        ],
        parameters: schemaForPiTool((tool as any).inputSchema),
        async execute(_toolCallId, params, signal, onUpdate, ctx) {
          activeCtx = ctx;
          try {
            const result = await server.client.callTool(
              { name: tool.name, arguments: params as Record<string, unknown> } as any,
              {
                signal,
                timeout: server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
                onprogress: (progress: any) =>
                  onUpdate?.({
                    content: [textBlock(`Progress: ${progress.progress}${progress.total ? `/${progress.total}` : ""}`)],
                    details: undefined,
                  }),
                resetTimeoutOnProgress: true,
                maxTotalTimeout: Math.max(server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
              } as any,
            );
            return {
              isError: !!result.isError,
              content: mcpToPiContent(result.content),
              details: { server: server.name, tool: tool.name, result },
            };
          } catch (error: any) {
            return {
              isError: true,
              content: [textBlock(error?.message ?? String(error))],
              details: { server: server.name, tool: tool.name, error: error?.message ?? String(error) },
            };
          }
        },
      });
    } catch (error) {
      // Captured `pi` may be from a session that has since been replaced/reloaded.
      // The new extension load will re-register on its own session_start.
      if (isStaleCtxError(error)) {
        runtimeStale = true;
        toolBindings.delete(name);
        if (mutated) notifyServerStateChange();
        return;
      }
      toolBindings.delete(name);
      if (mutated) notifyServerStateChange();
      throw error;
    }
  }
  if (mutated) notifyServerStateChange();
}

function registerMetaTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: "mcp_list_servers",
    label: "MCP: List Servers",
    description: "List configured MCP servers and their tools/resources/prompts.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      activeCtx = ctx;
      if (activePi) await initializeFromContext(activePi, ctx);
      const result = [...servers.values()].map((s) => ({
        name: s.name,
        connected: !s.error,
        error: s.error,
        serverInfo: s.client?.getServerVersion?.(),
        capabilities: s.client?.getServerCapabilities?.(),
        instructions: s.instructions,
        tools: [...s.tools.values()].map((t: any) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          annotations: t.annotations,
        })),
        resources: s.resources.map((r: any) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })),
        prompts: s.prompts.map((p: any) => ({ name: p.name, description: p.description, arguments: p.arguments })),
      }));
      return { content: [textBlock(JSON.stringify(result, null, 2))], details: result };
    },
  });

  pi.registerTool({
    name: "mcp_read_resource",
    label: "MCP: Read Resource",
    description: "Read a resource from an MCP server by URI.",
    parameters: Type.Object({ server: Type.String(), uri: Type.String() }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      activeCtx = ctx;
      if (activePi) await initializeFromContext(activePi, ctx);
      const server = servers.get(params.server);
      if (!server)
        return {
          isError: true,
          content: [textBlock(`Unknown MCP server: ${params.server}`)],
          details: { error: `Unknown MCP server: ${params.server}` },
        };
      try {
        const result = await server.client.readResource(
          { uri: params.uri } as any,
          { signal, timeout: server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any,
        );
        const text = result.contents
          .map((c: any) =>
            "text" in c ? `[${c.uri}]\n${c.text}` : `[${c.uri}] blob ${String(c.blob ?? "").length} base64 chars`,
          )
          .join("\n\n");
        return { content: [textBlock(text || "(empty resource)")], details: result };
      } catch (error: any) {
        return {
          isError: true,
          content: [textBlock(error?.message ?? String(error))],
          details: { error: error?.message ?? String(error) },
        };
      }
    },
  });

  pi.registerTool({
    name: "mcp_get_prompt",
    label: "MCP: Get Prompt",
    description: "Retrieve an MCP prompt by name with optional arguments.",
    parameters: Type.Object({
      server: Type.String(),
      name: Type.String(),
      arguments: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      activeCtx = ctx;
      if (activePi) await initializeFromContext(activePi, ctx);
      const server = servers.get(params.server);
      if (!server)
        return {
          isError: true,
          content: [textBlock(`Unknown MCP server: ${params.server}`)],
          details: { error: `Unknown MCP server: ${params.server}` },
        };
      try {
        const result = await server.client.getPrompt(
          { name: params.name, arguments: params.arguments ?? {} } as any,
          { signal, timeout: server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any,
        );
        const text = result.messages
          .map((m: any) => `## ${m.role}\n${mcpSamplingContentToText(m.content)}`)
          .join("\n\n");
        return { content: [textBlock(text || "(empty prompt)")], details: result };
      } catch (error: any) {
        return {
          isError: true,
          content: [textBlock(error?.message ?? String(error))],
          details: { error: error?.message ?? String(error) },
        };
      }
    },
  });
}

async function shutdownServers() {
  for (const server of servers.values()) {
    try {
      if (server.transport?.terminateSession) await server.transport.terminateSession();
    } catch {}
    try {
      await server.client?.close?.();
    } catch {}
  }
  servers.clear();
  toolBindings.clear();
  // Drop any remaining UI subscribers (e.g. an open panel modal closure that
  // hasn't yet had its `dispose` called). They're tied to the now-stale
  // runtime, so any re-render they trigger would throw.
  clearListeners();
  // Reset the panel message bus so a stale toast/timer can't leak across
  // session reloads.
  clearAllMessages();
  initialized = false;
  initializing = undefined;
}

/**
 * Connect a server, register its tools with pi, and replace its placeholder
 * in the `servers` map with the live ConnectedServer. On failure, replaces
 * the placeholder with an errored entry whose `error` and `diagnostics`
 * carry the failure message.
 *
 * Used at startup AND by the panel's `r` reconnect / `Shift+R` reload
 * actions (via `actions.ts`'s hooks).
 */
async function connectAndRegister(
  pi: ExtensionAPI,
  name: string,
  cfg: ServerConfig,
  source: ServerSourceInfo,
  staticDiagnostics: ServerDiagnostic[],
): Promise<void> {
  let server: ConnectedServer | undefined;
  try {
    server = await connectServer(name, cfg, pi);
    // The connect itself can take seconds, especially for remote HTTPS servers behind a VPN.
    // If the session was replaced/reloaded while we were awaiting, the captured `pi` is now
    // stale and registerTool would throw. Skip registration cleanly; the new load will redo it.
    if (runtimeStale) {
      await discardServer(name, server, "runtime stale before tool registration");
      return;
    }
    // Stamp provenance + diagnostics from the pre-connect computation onto
    // the live server.
    server.source = source;
    server.diagnostics = [...staticDiagnostics];
    if (oauthEnabled(cfg)) server.diagnostics.push({ level: "info", message: `OAuth: ${getOAuthStatus(name, cfg)}` });
    servers.set(name, server);
    registerServerTools(pi, server, [...server.tools.values()]);
    if (process.env.PI_MCP_DEBUG === "1") console.error(`[pi-mcp] Connected ${name}: ${server.tools.size} tools`);
    notifyServerStateChange();
  } catch (error: any) {
    if (isStaleCtxError(error)) {
      runtimeStale = true;
      await discardServer(name, server, "stale ctx during connect");
      if (process.env.PI_MCP_DEBUG === "1") {
        console.error(`[pi-mcp] Skipped registering ${name}: extension was reloaded mid-connect`);
      }
      return;
    }
    const message = error?.message ?? String(error);
    const failed = makePendingServer(name, cfg, source, staticDiagnostics, { error: message });
    if (oauthEnabled(cfg)) failed.diagnostics.push({ level: "info", message: `OAuth: ${getOAuthStatus(name, cfg)}` });
    failed.diagnostics.push({ level: "error", message });
    servers.set(name, failed);
    console.error(`[pi-mcp] Failed to connect ${name}: ${message}`);
    notifyServerStateChange();
  }
}

async function initializeFromContext(pi: ExtensionAPI, ctx: ExtensionContext) {
  activeCtx = ctx;
  if (initialized) return;
  if (initializing) return initializing;
  initializing = (async () => {
    const { config, files, errors, origin } = loadConfig(ctx.cwd);
    configFiles = files;
    configErrors = errors;
    cleanupOldMcpBackups(files);
    const allEntries = Object.entries(config.mcpServers ?? {});
    if (process.env.PI_MCP_DEBUG === "1")
      console.error(
        `[pi-mcp] cwd=${ctx.cwd} files=${files.join(",")} servers=${allEntries.map(([name]) => name).join(",")}`,
      );
    initialized = true;
    for (const [name, cfg] of Object.entries(config.mcpServers ?? {})) {
      // Compute provenance + static diagnostics up front so the panel can
      // render rich state even before the server has finished connecting.
      // Note: we no longer filter out disabled servers here — we keep them
      // in the map so the panel can show them with a `⊘` icon. We just
      // skip the actual `connectServer` call below.
      const file = origin.get(name) ?? "<unknown>";
      const gitIgnored = await isGitIgnored(pi, file);
      const source: ServerSourceInfo = { file, gitIgnored };
      const staticDiagnostics = validateServerConfig(name, cfg);

      if (cfg.disabled) {
        // Persisted-disabled: register the placeholder but don't connect.
        const placeholder = makePendingServer(name, cfg, source, staticDiagnostics, "connecting");
        placeholder.error = undefined;
        servers.set(name, placeholder);
        notifyServerStateChange();
        continue;
      }

      servers.set(name, makePendingServer(name, cfg, source, staticDiagnostics, "connecting"));
      notifyServerStateChange();
      void connectAndRegister(pi, name, cfg, source, staticDiagnostics);
    }

    // In pipe/subagent mode, wait for initial MCP connections so tools are
    // registered before the first turn. Interactive sessions don't need this
    // because the user provides natural delay. We wait up to 15s total.
    // Pending servers have error="connecting" (a truthy placeholder), so we
    // check for that specific string rather than !s.error.
    //
    // IMPORTANT: only block when there is no interactive UI (print/pipe, subagent).
    // In an interactive session this `await` runs inside the awaited `session_start`
    // handler, so it would stall *every* session creation (startup, and especially
    // `/new`) for as long as the slowest server's handshake (e.g. unraid-docker over
    // SSH ~3s). With a UI present, servers connect in the background and register
    // their tools via connectAndRegister() when ready, so there is nothing to wait on.
    // NB: gate on ctx.hasUI (not ctx.mode) — the pinned @mariozechner/pi-coding-agent
    // types expose hasUI, and hasUI === false ≡ non-interactive (print/RPC) here.
    if (!runtimeStale && !ctx.hasUI) {
      const isPending = (s: ConnectedServer) => s.error === "connecting" && s.tools.size === 0 && !s.config?.disabled;
      if ([...servers.values()].some(isPending)) {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !runtimeStale) {
          if (![...servers.values()].some(isPending)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }

    // After all initial server placeholders are in place, apply session
    // overlays once. (At startup the overlays are empty, but this also
    // wires the helper to be the single point that owns pi.setActiveTools
    // for MCP-bound tools — future toggle actions go through it too.)
    applyToolOverlay(pi);
  })();
  return initializing;
}

export default async function (pi: ExtensionAPI) {
  activePi = pi;
  registerMetaTools(pi);

  // Register action hooks so the panel can call back into our SDK plumbing.
  registerActionHooks({
    reconnectServer: async (name, cfg, source) => {
      const staticDiagnostics = validateServerConfig(name, cfg);
      await connectAndRegister(pi, name, cfg, source, staticDiagnostics);
    },
    discardServer,
    loadConfigFromDisk: () => loadConfig(activeCtx?.cwd ?? process.cwd()),
    validateServerConfig,
    isGitIgnored: (file) => isGitIgnored(pi, file),
    piToolName,
  });

  pi.registerCommand("mcp", {
    description: "Open the MCP servers panel (or pass `--text` for a one-shot summary)",
    handler: async (args, ctx) => {
      activeCtx = ctx;
      await initializeFromContext(pi, ctx);

      // Escape hatch: `/mcp --text` prints the legacy notify-based summary.
      // Useful when ctx.hasUI is false (print/RPC mode) or the panel is
      // broken and the user just wants to see what's loaded.
      const argList = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const wantsText = argList.includes("--text") || !ctx.hasUI;

      if (wantsText) {
        const lines = [
          `MCP extension ${EXT_VERSION}`,
          `Config files: ${configFiles.length ? configFiles.join(", ") : "none"}`,
          ...configErrors.map((e) => `Config error: ${e}`),
          ...[...servers.values()].map(
            (s) =>
              `${s.error ? "✗" : "✓"} ${s.name}: ${s.error ?? `${s.tools.size} tools, ${s.resources.length} resources, ${s.prompts.length} prompts`}`,
          ),
        ];
        ctx.ui.notify(lines.join("\n"), configErrors.length ? "warning" : "info");
        return;
      }

      await openMcpPanel(pi, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    await initializeFromContext(pi, ctx);
  });
  pi.on("session_shutdown", async () => {
    // Mark this extension load's captured `pi` as stale so any in-flight async work
    // (e.g. a remote MCP server that hasn't finished its handshake) bails out cleanly
    // instead of trying to call pi.registerTool() and throwing the stale-ctx error.
    runtimeStale = true;
    await shutdownServers();
  });
}
