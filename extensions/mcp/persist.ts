import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerConfig } from "./state.js";

export type McpJsonFile = { mcpServers?: Record<string, ServerConfig> };

export type PersistResult<T = void> =
  | { ok: true; value: T; message?: string }
  | { ok: false; message: string; blockedSecrets?: SecretFinding[] };

export interface SecretFinding {
  path: string;
  valuePreview: string;
  suggestedEnv: string;
}

const SECRET_FIELD_RE =
  /^(bearerToken|token|apiKey|api_key|password|secret|auth|authorization|clientSecret|client_secret|accessToken|access_token|privateKey|private_key)$/i;
const SECRET_PREFIX_RE = /^(sk-|pk-|pat_|xoxb-|xoxp-|xoxa-|ghp_|gho_|ghu_|ghs_|ghr_|eyJ)/;
const LONG_BLOB_RE = /^[A-Za-z0-9+/=]{40,}$/;
const BACKUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function defaultUserMcpFile(): string {
  return join(homedir(), ".pi/agent/mcp.json");
}

export function parseMcpFile(file: string): PersistResult<McpJsonFile> {
  try {
    if (!existsSync(file)) return { ok: true, value: { mcpServers: {} } };
    return { ok: true, value: JSON.parse(readFileSync(file, "utf8")) as McpJsonFile };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `failed to parse strict JSON ${file}: ${msg}` };
  }
}

export function serializeMcpFile(doc: McpJsonFile): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function writeMcpFileAtomic(file: string, doc: McpJsonFile): PersistResult {
  try {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(`${file}.bak.${stamp}`, readFileSync(file));
    }
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    writeFileSync(tmp, serializeMcpFile(doc), "utf8");
    renameSync(tmp, file);
    return { ok: true, value: undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `failed to write ${file}: ${msg}` };
  }
}

export function replaceServerInFile(
  file: string,
  serverName: string,
  config: ServerConfig,
  opts: { gitIgnored: boolean },
): PersistResult<McpJsonFile> {
  const parsed = parseMcpFile(file);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  doc.mcpServers ??= {};
  doc.mcpServers[serverName] = config;

  const guarded = guardSecrets(doc.mcpServers[serverName], serverName, opts.gitIgnored);
  if (!guarded.ok) return guarded;

  const written = writeMcpFileAtomic(file, doc);
  if (!written.ok) return written;
  return { ok: true, value: doc };
}

export function removeServerFromFile(file: string, serverName: string): PersistResult<McpJsonFile> {
  const parsed = parseMcpFile(file);
  if (!parsed.ok) return parsed;
  const doc = parsed.value;
  if (!doc.mcpServers?.[serverName]) return { ok: false, message: `${serverName} is not in ${file}` };
  const { [serverName]: _removed, ...remaining } = doc.mcpServers;
  doc.mcpServers = remaining;
  const written = writeMcpFileAtomic(file, doc);
  if (!written.ok) return written;
  return { ok: true, value: doc };
}

export function cleanupOldMcpBackups(files: Iterable<string>, retentionMs = BACKUP_RETENTION_MS): void {
  const dirs = new Set<string>();
  for (const file of files) dirs.add(dirname(file));
  dirs.add(dirname(defaultUserMcpFile()));

  const cutoff = Date.now() - retentionMs;
  for (const dir of dirs) {
    try {
      for (const entry of readdirSync(dir)) {
        if (!/\.mcp\.json\.bak\./.test(entry) && !/mcp\.json\.bak\./.test(entry)) continue;
        const path = join(dir, entry);
        const stat = statSync(path);
        if (stat.mtimeMs < cutoff) unlinkSync(path);
      }
    } catch {}
  }
}

export function guardSecrets(config: ServerConfig, serverName: string, gitIgnored: boolean): PersistResult {
  if (gitIgnored) return { ok: true, value: undefined };
  const findings: SecretFinding[] = [];
  scanValue(config as unknown, [serverName], findings);
  if (findings.length === 0) return { ok: true, value: undefined };
  return {
    ok: false,
    message: `blocked write to git-tracked .mcp.json: literal secret-like value${findings.length === 1 ? "" : "s"} found. Use \${VAR} references instead.`,
    blockedSecrets: findings,
  };
}

function scanValue(value: unknown, path: string[], out: SecretFinding[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanValue(v, [...path, String(i)], out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      scanValue(v, [...path, k], out);
    }
    return;
  }
  if (typeof value !== "string") return;
  if (value.startsWith("${") || value.includes("${")) return;

  const last = path[path.length - 1] ?? "";
  const parent = path[path.length - 2] ?? "";
  const isAuthorizationHeader = parent.toLowerCase() === "headers" && last.toLowerCase() === "authorization";
  const secretLike =
    SECRET_FIELD_RE.test(last) || isAuthorizationHeader || SECRET_PREFIX_RE.test(value) || LONG_BLOB_RE.test(value);
  if (!secretLike) return;

  out.push({
    path: path.join("."),
    valuePreview: previewSecret(value),
    suggestedEnv: suggestEnvName(path),
  });
}

function previewSecret(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function suggestEnvName(path: string[]): string {
  return path
    .filter((p) => !/^\d+$/.test(p))
    .join("_")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase();
}
