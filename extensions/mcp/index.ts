import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { completeSimple } from "@mariozechner/pi-ai";
import {
  Client,
  StdioClientTransport,
  StreamableHTTPClientTransport,
  SSEClientTransport,
  getDefaultEnvironment,
  type Tool,
} from "@modelcontextprotocol/client";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const EXT_VERSION = "0.1.0";
const DEFAULT_TIMEOUT_MS = Number(process.env.PI_MCP_TOOL_TIMEOUT_MS ?? 120_000);
const ENABLE_LEGACY_SSE_FALLBACK = process.env.PI_MCP_LEGACY_SSE_FALLBACK !== "0";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type McpConfig = {
  mcpServers?: Record<string, ServerConfig>;
};

type ServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  bearerToken?: string;
  disabled?: boolean;
  timeoutMs?: number;
};

type ConnectedServer = {
  name: string;
  config: ServerConfig;
  client: Client;
  transport: any;
  tools: Map<string, Tool>;
  resources: any[];
  prompts: any[];
  instructions?: string;
  error?: string;
};

type ToolBinding = {
  server: ConnectedServer;
  originalName: string;
  tool: Tool;
};

const servers = new Map<string, ConnectedServer>();
const toolBindings = new Map<string, ToolBinding>();
let activeCtx: ExtensionContext | undefined;
let activePi: ExtensionAPI | undefined;
let configFiles: string[] = [];
let configErrors: string[] = [];
let initialized = false;
let initializing: Promise<void> | undefined;

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

function stripJsonComments(text: string) {
  return text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

function loadConfig(cwd: string): { config: McpConfig; files: string[]; errors: string[] } {
  const files = findConfigFiles(cwd);
  const merged: McpConfig = { mcpServers: {} };
  const errors: string[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(file, "utf8");
      let parsed: McpConfig;
      try {
        parsed = JSON.parse(raw) as McpConfig;
      } catch {
        parsed = JSON.parse(stripJsonComments(raw)) as McpConfig;
      }
      if (parsed.mcpServers) {
        merged.mcpServers = { ...merged.mcpServers, ...parsed.mcpServers };
      }
    } catch (error: any) {
      errors.push(`${file}: ${error?.message ?? String(error)}`);
    }
  }
  return { config: merged, files, errors };
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
      if (block.type === "image") return `[image ${block.mimeType ?? "unknown"}, ${String(block.data ?? "").length} base64 chars]`;
      if (block.type === "audio") return `[audio ${block.mimeType ?? "unknown"}, ${String(block.data ?? "").length} base64 chars]`;
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
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model as any);
  if (!auth.ok) throw new Error(auth.error);

  const systemPrompt = [
    request.params?.systemPrompt,
    "You are answering an MCP server-initiated sampling request. Return only the assistant response requested by the server.",
  ].filter(Boolean).join("\n\n");

  const messages = (request.params?.messages ?? []).map((m: any) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: [{ type: "text" as const, text: mcpSamplingContentToText(m.content) }],
    timestamp: Date.now(),
    api: ctx.model.api,
    provider: ctx.model.provider,
    model: ctx.model.id,
    usage: undefined,
    stopReason: undefined,
  })).map((m: any) => {
    if (m.role === "assistant") {
      return { role: "assistant", content: m.content, api: ctx.model!.api, provider: ctx.model!.provider, model: ctx.model!.id, usage: emptyUsage(), stopReason: "stop", timestamp: Date.now() };
    }
    return { role: "user", content: m.content, timestamp: Date.now() };
  });

  const response = await completeSimple(ctx.model as any, { systemPrompt, messages }, {
    apiKey: auth.apiKey,
    headers: auth.headers,
    signal: ctx.signal,
    maxTokens: Math.min(Number(request.params?.maxTokens ?? 4096), ctx.model.maxTokens ?? 4096),
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage ?? `Sampling failed: ${response.stopReason}`);
  }
  const text = response.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
  return { model: ctx.model.id, role: "assistant" as const, content: { type: "text" as const, text } };
}

function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

async function elicitationHandler(request: any) {
  const ctx = activeCtx;
  if (!ctx?.hasUI) return { action: "decline" as const };
  const params = request.params ?? {};
  if (params.mode === "url") {
    const url = params.url ?? params.href ?? "";
    ctx.ui.notify(`MCP server asks you to visit: ${url}`, "info");
    const ok = await ctx.ui.confirm("MCP URL elicitation", `${params.message ?? "MCP server requested URL-based input."}\n\n${url}\n\nAccept?`);
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
      const answer = await ctx.ui.input("MCP elicitation", label, prop?.default === undefined ? "" : String(prop.default));
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

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string, onTimeout?: () => void | Promise<void>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try { void onTimeout?.(); } catch {}
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
  const client = new Client(
    { name: "pi-mcp", version: EXT_VERSION },
    {
      capabilities: {
        roots: { listChanged: true },
        sampling: {},
        elicitation: { form: {}, url: {} },
      },
      listChanged: {
        tools: { onChanged: (_error: any, tools: Tool[] | undefined) => tools && registerServerTools(pi, serverRef, tools) },
      },
    } as any,
  );
  client.setRequestHandler("roots/list" as any, rootsHandler as any);
  client.setRequestHandler("sampling/createMessage" as any, samplingHandler as any);
  client.setRequestHandler("elicitation/create" as any, elicitationHandler as any);

  let transport: any;
  if (config.url) {
    const headers = { ...(config.headers ?? {}) };
    let authProvider: any = undefined;
    if (config.bearerToken) authProvider = { token: async () => expandEnvValue(config.bearerToken!) };
    transport = new StreamableHTTPClientTransport(new URL(expandEnvValue(config.url)), {
      authProvider,
      fetch: makeHeadersFetch(headers),
      requestInit: Object.keys(headers).length ? { headers } : undefined,
    } as any);
    try {
      await withTimeout(client.connect(transport, { timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any), config.timeoutMs ?? DEFAULT_TIMEOUT_MS, `MCP HTTP connect ${name}`, () => transport.close?.());
    } catch (error) {
      if (!ENABLE_LEGACY_SSE_FALLBACK) throw error;
      transport = new SSEClientTransport(new URL(expandEnvValue(config.url)), { requestInit: Object.keys(headers).length ? { headers } : undefined } as any);
      await withTimeout(client.connect(transport, { timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any), config.timeoutMs ?? DEFAULT_TIMEOUT_MS, `MCP legacy SSE connect ${name}`, () => transport.close?.());
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
    await withTimeout(client.connect(transport, { timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any), config.timeoutMs ?? DEFAULT_TIMEOUT_MS, `MCP stdio connect ${name}`, () => transport.close?.());
  }

  const serverRef: ConnectedServer = { name, config, client, transport, tools: new Map(), resources: [], prompts: [], instructions: client.getInstructions() };
  await refreshServerCaches(serverRef);
  return serverRef;
}

async function refreshServerCaches(server: ConnectedServer) {
  const tools = await listAll((cursor) => server.client.listTools({ cursor } as any, { timeout: server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any), "tools");
  server.tools = new Map(tools.map((tool: Tool) => [tool.name, tool]));
  try { server.resources = await listAll((cursor) => server.client.listResources({ cursor } as any), "resources"); } catch { server.resources = []; }
  try { server.prompts = await listAll((cursor) => server.client.listPrompts({ cursor } as any), "prompts"); } catch { server.prompts = []; }
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
  for (const tool of tools) {
    const name = piToolName(server.name, tool.name);
    if (toolBindings.has(name)) continue;
    toolBindings.set(name, { server, originalName: tool.name, tool });
    server.tools.set(tool.name, tool);
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
              onprogress: (progress: any) => onUpdate?.({ content: [textBlock(`Progress: ${progress.progress}${progress.total ? `/${progress.total}` : ""}`)] }),
              resetTimeoutOnProgress: true,
              maxTotalTimeout: Math.max(server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
            } as any,
          );
          return { isError: !!result.isError, content: mcpToPiContent(result.content), details: { server: server.name, tool: tool.name, result } };
        } catch (error: any) {
          return { isError: true, content: [textBlock(error?.message ?? String(error))], details: { server: server.name, tool: tool.name, error: error?.message ?? String(error) } };
        }
      },
    });
  }
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
        tools: [...s.tools.values()].map((t: any) => ({ name: t.name, title: t.title, description: t.description, annotations: t.annotations })),
        resources: s.resources.map((r: any) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })),
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
      if (!server) return { isError: true, content: [textBlock(`Unknown MCP server: ${params.server}`)] };
      try {
        const result = await server.client.readResource({ uri: params.uri } as any, { signal, timeout: server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any);
        const text = result.contents.map((c: any) => "text" in c ? `[${c.uri}]\n${c.text}` : `[${c.uri}] blob ${String(c.blob ?? "").length} base64 chars`).join("\n\n");
        return { content: [textBlock(text || "(empty resource)")], details: result };
      } catch (error: any) {
        return { isError: true, content: [textBlock(error?.message ?? String(error))], details: { error: error?.message ?? String(error) } };
      }
    },
  });

  pi.registerTool({
    name: "mcp_get_prompt",
    label: "MCP: Get Prompt",
    description: "Retrieve an MCP prompt by name with optional arguments.",
    parameters: Type.Object({ server: Type.String(), name: Type.String(), arguments: Type.Optional(Type.Record(Type.String(), Type.Any())) }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      activeCtx = ctx;
      if (activePi) await initializeFromContext(activePi, ctx);
      const server = servers.get(params.server);
      if (!server) return { isError: true, content: [textBlock(`Unknown MCP server: ${params.server}`)] };
      try {
        const result = await server.client.getPrompt({ name: params.name, arguments: params.arguments ?? {} } as any, { signal, timeout: server.config.timeoutMs ?? DEFAULT_TIMEOUT_MS } as any);
        const text = result.messages.map((m: any) => `## ${m.role}\n${mcpSamplingContentToText(m.content)}`).join("\n\n");
        return { content: [textBlock(text || "(empty prompt)")], details: result };
      } catch (error: any) {
        return { isError: true, content: [textBlock(error?.message ?? String(error))], details: { error: error?.message ?? String(error) } };
      }
    },
  });
}

async function shutdownServers() {
  for (const server of servers.values()) {
    try {
      if (server.transport?.terminateSession) await server.transport.terminateSession();
    } catch {}
    try { await server.client?.close?.(); } catch {}
  }
  servers.clear();
  toolBindings.clear();
  initialized = false;
  initializing = undefined;
}

async function initializeFromContext(pi: ExtensionAPI, ctx: ExtensionContext) {
  activeCtx = ctx;
  if (initialized) return;
  if (initializing) return initializing;
  initializing = (async () => {
    const { config, files, errors } = loadConfig(ctx.cwd);
    configFiles = files;
    configErrors = errors;
    const entries = Object.entries(config.mcpServers ?? {}).filter(([, cfg]) => !cfg.disabled);
    if (process.env.PI_MCP_DEBUG === "1") console.error(`[pi-mcp] cwd=${ctx.cwd} files=${files.join(",")} servers=${entries.map(([name]) => name).join(",")}`);
    initialized = true;
    for (const [name, cfg] of entries) {
      servers.set(name, { name, config: cfg, client: undefined as any, transport: undefined, tools: new Map(), resources: [], prompts: [], error: "connecting" } as ConnectedServer);
      void (async () => {
        try {
          const server = await connectServer(name, cfg, pi);
          servers.set(name, server);
          registerServerTools(pi, server, [...server.tools.values()]);
          if (process.env.PI_MCP_DEBUG === "1") console.error(`[pi-mcp] Connected ${name}: ${server.tools.size} tools`);
        } catch (error: any) {
          const failed = { name, config: cfg, client: undefined as any, transport: undefined, tools: new Map(), resources: [], prompts: [], error: error?.message ?? String(error) } as ConnectedServer;
          servers.set(name, failed);
          console.error(`[pi-mcp] Failed to connect ${name}: ${failed.error}`);
        }
      })();
    }
  })();
  return initializing;
}

export default async function (pi: ExtensionAPI) {
  activePi = pi;
  registerMetaTools(pi);

  pi.registerCommand("mcp", {
    description: "Show MCP server status",
    handler: async (_args, ctx) => {
      activeCtx = ctx;
      await initializeFromContext(pi, ctx);
      const lines = [
        `MCP extension ${EXT_VERSION}`,
        `Config files: ${configFiles.length ? configFiles.join(", ") : "none"}`,
        ...configErrors.map((e) => `Config error: ${e}`),
        ...[...servers.values()].map((s) => `${s.error ? "✗" : "✓"} ${s.name}: ${s.error ?? `${s.tools.size} tools, ${s.resources.length} resources, ${s.prompts.length} prompts`}`),
      ];
      ctx.ui.notify(lines.join("\n"), configErrors.length ? "warning" : "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    await initializeFromContext(pi, ctx);
  });
  pi.on("session_shutdown", async () => {
    await shutdownServers();
  });
}
