import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import {
  type AuthProvider,
  type AuthResult,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type OAuthTokens,
  UnauthorizedError,
  auth,
  extractWWWAuthenticateParams,
  refreshAuthorization,
} from "@modelcontextprotocol/client";
import type { ServerConfig } from "./state.js";

export const DEFAULT_OAUTH_REDIRECT_URL = "http://127.0.0.1:17631/mcp/oauth/callback";

const STORE_PATH = join(homedir(), ".pi", "agent", "mcp-oauth.json");
const LOCK_PATH = `${STORE_PATH}.lock`;
const OAUTH_TIMEOUT_MS = Number(process.env.PI_MCP_OAUTH_TIMEOUT_MS ?? 120_000);
const TOKEN_REFRESH_SKEW_MS = Number(process.env.PI_MCP_OAUTH_REFRESH_SKEW_MS ?? 5 * 60_000);
const OAUTH_LOCK_TIMEOUT_MS = Number(process.env.PI_MCP_OAUTH_LOCK_TIMEOUT_MS ?? 15_000);
const OAUTH_LOCK_STALE_MS = Number(process.env.PI_MCP_OAUTH_LOCK_STALE_MS ?? 60_000);
const OAUTH_LOCK_HEARTBEAT_MS = Math.max(1_000, Math.floor(OAUTH_LOCK_STALE_MS / 3));

type OAuthStoreRecord = {
  tokens?: OAuthTokens;
  tokensUpdatedAt?: string;
  clientInformation?: OAuthClientInformationMixed;
  codeVerifier?: string;
  state?: string;
  authorizationServerUrl?: string;
  resourceUrl?: string;
  discoveryState?: OAuthDiscoveryState;
  authorizationUrl?: string;
  updatedAt?: string;
};

type OAuthStore = {
  version: 1;
  servers: Record<string, OAuthStoreRecord>;
};

type ProviderOptions = {
  interactive?: boolean;
  onAuthorizationUrl?: (url: URL) => void | Promise<void>;
};

export function oauthEnabled(config: ServerConfig): boolean {
  return Boolean(config.url && config.oauth?.enabled);
}

export function oauthRecordKey(serverName: string, config: ServerConfig): string {
  return `${serverName}\n${config.url ?? ""}`;
}

export function getOAuthStorePath(): string {
  return STORE_PATH;
}

export function getOAuthStatus(serverName: string, config: ServerConfig): string {
  if (!oauthEnabled(config)) return "disabled";
  const record = readRecord(serverName, config);
  if (record?.tokens?.access_token) return "authenticated";
  if (record?.authorizationUrl) return "authorization required";
  return "not authenticated";
}

export function getPendingAuthorizationUrl(serverName: string, config: ServerConfig): string | undefined {
  return readRecord(serverName, config)?.authorizationUrl;
}

export function clearOAuthCredentials(serverName: string, config: ServerConfig): void {
  const store = loadStore();
  delete store.servers[oauthRecordKey(serverName, config)];
  saveStore(store);
}

export function createOAuthProvider(
  serverName: string,
  config: ServerConfig,
  options: ProviderOptions = {},
): OAuthClientProvider {
  const redirectUrl = config.oauth?.redirectUrl ?? DEFAULT_OAUTH_REDIRECT_URL;
  const scopes = config.oauth?.scopes?.filter(Boolean) ?? [];
  const clientId = expandEnvValue(config.oauth?.clientId);
  const clientSecret = expandEnvValue(config.oauth?.clientSecret);

  const updateRecord = (patch: Partial<OAuthStoreRecord>) => {
    const store = loadStore();
    const key = oauthRecordKey(serverName, config);
    store.servers[key] = { ...(store.servers[key] ?? {}), ...patch, updatedAt: new Date().toISOString() };
    saveStore(store);
  };

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        redirect_uris: [redirectUrl],
        token_endpoint_auth_method: clientSecret ? "client_secret_basic" : "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "pi MCP extension",
        scope: scopes.length ? scopes.join(" ") : undefined,
      };
    },
    state() {
      const state = randomBytes(16).toString("hex");
      updateRecord({ state });
      return state;
    },
    clientInformation() {
      if (clientId) return { client_id: clientId, client_secret: clientSecret };
      return readRecord(serverName, config)?.clientInformation;
    },
    saveClientInformation(clientInformation) {
      updateRecord({ clientInformation });
    },
    tokens() {
      return readRecord(serverName, config)?.tokens;
    },
    saveTokens(tokens) {
      updateRecord({ tokens, tokensUpdatedAt: new Date().toISOString(), authorizationUrl: undefined });
    },
    async redirectToAuthorization(authorizationUrl) {
      updateRecord({ authorizationUrl: authorizationUrl.toString() });
      await options.onAuthorizationUrl?.(authorizationUrl);
      if (!options.interactive) {
        throw new Error(`OAuth authorization required for ${serverName}. Open /mcp and run OAuth login.`);
      }
    },
    saveCodeVerifier(codeVerifier) {
      updateRecord({ codeVerifier });
    },
    codeVerifier() {
      const verifier = readRecord(serverName, config)?.codeVerifier;
      if (!verifier) throw new Error(`Missing OAuth PKCE verifier for ${serverName}; restart login.`);
      return verifier;
    },
    invalidateCredentials(scope) {
      const store = loadStore();
      const key = oauthRecordKey(serverName, config);
      const existing = store.servers[key];
      if (!existing) return;
      if (scope === "all") delete store.servers[key];
      else {
        if (scope === "tokens") existing.tokens = undefined;
        if (scope === "client") existing.clientInformation = undefined;
        if (scope === "verifier") existing.codeVerifier = undefined;
        if (scope === "discovery") existing.discoveryState = undefined;
        existing.updatedAt = new Date().toISOString();
      }
      saveStore(store);
    },
    saveAuthorizationServerUrl(authorizationServerUrl) {
      updateRecord({ authorizationServerUrl });
    },
    authorizationServerUrl() {
      return readRecord(serverName, config)?.authorizationServerUrl;
    },
    saveResourceUrl(resourceUrl) {
      updateRecord({ resourceUrl });
    },
    resourceUrl() {
      return readRecord(serverName, config)?.resourceUrl;
    },
    saveDiscoveryState(discoveryState) {
      updateRecord({ discoveryState });
    },
    discoveryState() {
      return readRecord(serverName, config)?.discoveryState;
    },
  };

  return provider;
}

/**
 * Transport-facing auth provider.
 *
 * The MCP SDK's built-in OAuth adapter refreshes tokens only after a 401 and
 * does not coordinate refresh-token rotation across multiple pi processes.
 * Notion rotates refresh tokens, so two sessions refreshing at the same time
 * can make one process save the new token while another invalidates it as
 * `invalid_grant`. This wrapper refreshes proactively and serializes refreshes
 * through a file lock shared by all pi sessions.
 */
export function createOAuthAuthProvider(serverName: string, config: ServerConfig): AuthProvider {
  const provider = createOAuthProvider(serverName, config, { interactive: false });

  return {
    token: async () => (await getFreshTokens(serverName, config))?.access_token,
    onUnauthorized: async (ctx) => {
      const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(ctx.response);
      const result = await authorizeWithLock(provider, serverName, {
        serverUrl: ctx.serverUrl,
        resourceMetadataUrl,
        scope,
        fetchFn: ctx.fetchFn,
      });
      if (result !== "AUTHORIZED") throw new UnauthorizedError(`OAuth authorization required for ${serverName}`);
    },
  };
}

export function createOAuthFetch(
  serverName: string,
  config: ServerConfig,
  fetchFn: typeof fetch = fetch,
): typeof fetch {
  const provider = createOAuthProvider(serverName, config, { interactive: false });

  return async (input, init) => {
    const response = await fetchFn(input, init);
    if (response.status !== 403) return response;

    const { error, resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
    if (error !== "insufficient_scope") return response;

    await response.text().catch(() => undefined);
    const result = await authorizeWithLock(provider, serverName, {
      serverUrl: new URL(expandEnvValue(config.url!)),
      resourceMetadataUrl,
      scope,
      fetchFn,
    });
    if (result !== "AUTHORIZED") throw new UnauthorizedError(`OAuth upscoping required for ${serverName}`);

    const tokens = await provider.tokens();
    const retryHeaders = new Headers(init?.headers);
    if (tokens?.access_token) retryHeaders.set("Authorization", `Bearer ${tokens.access_token}`);
    return fetchFn(input, { ...init, headers: retryHeaders });
  };
}

async function authorizeWithLock(
  provider: OAuthClientProvider,
  serverName: string,
  options: Parameters<typeof auth>[1],
): Promise<AuthResult> {
  try {
    return await withOAuthStoreLock(() => auth(provider, options));
  } catch (error) {
    if (process.env.PI_MCP_DEBUG === "1") {
      console.error(`[pi-mcp] OAuth authorization failed for ${serverName}: ${errorMessage(error)}`);
    }
    throw error;
  }
}

async function getFreshTokens(serverName: string, config: ServerConfig): Promise<OAuthTokens | undefined> {
  const record = readRecord(serverName, config);
  if (!record?.tokens) return undefined;
  if (!shouldRefreshTokens(record)) return record.tokens;

  try {
    return await withOAuthStoreLock(async () => {
      const lockedRecord = readRecord(serverName, config);
      if (!lockedRecord?.tokens) return undefined;
      if (!shouldRefreshTokens(lockedRecord)) return lockedRecord.tokens;
      return refreshStoredTokens(serverName, config, lockedRecord);
    });
  } catch (error) {
    if (process.env.PI_MCP_DEBUG === "1") {
      console.error(`[pi-mcp] OAuth proactive refresh failed for ${serverName}: ${errorMessage(error)}`);
    }
    return readRecord(serverName, config)?.tokens;
  }
}

function shouldRefreshTokens(record: OAuthStoreRecord): boolean {
  const expiresIn = record.tokens?.expires_in;
  if (typeof expiresIn !== "number" || expiresIn <= 0) return false;
  const tokensSavedAt = Date.parse(record.tokensUpdatedAt ?? record.updatedAt ?? "");
  if (!Number.isFinite(tokensSavedAt)) return false;
  return Date.now() + TOKEN_REFRESH_SKEW_MS >= tokensSavedAt + expiresIn * 1000;
}

async function refreshStoredTokens(
  serverName: string,
  config: ServerConfig,
  record: OAuthStoreRecord,
): Promise<OAuthTokens | undefined> {
  const refreshToken = record.tokens?.refresh_token;
  if (!refreshToken) return record.tokens;

  const authorizationServerUrl = record.authorizationServerUrl ?? record.discoveryState?.authorizationServerUrl;
  const clientInformation = configuredClientInformation(config) ?? record.clientInformation;
  if (!authorizationServerUrl || !clientInformation) return record.tokens;

  const resourceUrl = record.resourceUrl ?? record.discoveryState?.resourceMetadata?.resource;
  const tokens = await refreshAuthorization(authorizationServerUrl, {
    metadata: record.discoveryState?.authorizationServerMetadata,
    clientInformation,
    refreshToken,
    resource: resourceUrl ? new URL(resourceUrl) : undefined,
  });

  const now = new Date().toISOString();
  const store = loadStore();
  const key = oauthRecordKey(serverName, config);
  store.servers[key] = {
    ...(store.servers[key] ?? {}),
    tokens,
    tokensUpdatedAt: now,
    authorizationUrl: undefined,
    updatedAt: now,
  };
  saveStore(store);
  return tokens;
}

function configuredClientInformation(config: ServerConfig): OAuthClientInformationMixed | undefined {
  const clientId = expandEnvValue(config.oauth?.clientId);
  if (!clientId) return undefined;
  return { client_id: clientId, client_secret: expandEnvValue(config.oauth?.clientSecret) };
}

async function withOAuthStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  const owner = `${process.pid}:${randomBytes(8).toString("hex")}`;
  let fd: number | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  while (fd === undefined) {
    try {
      mkdirSync(dirname(STORE_PATH), { recursive: true });
      const lockFd = openSync(LOCK_PATH, "wx", 0o600);
      writeLockOwner(lockFd, owner);
      fd = lockFd;
      heartbeat = setInterval(() => touchLock(owner), OAUTH_LOCK_HEARTBEAT_MS);
      heartbeat.unref?.();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      removeStaleLock();
      if (Date.now() - startedAt > OAUTH_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for MCP OAuth lock at ${LOCK_PATH}`);
      }
      await sleep(100 + Math.floor(Math.random() * 100));
    }
  }

  try {
    return await fn();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      closeSync(fd);
    } catch {}
    removeLockIfOwner(owner);
  }
}

function writeLockOwner(fd: number, owner: string): void {
  writeFileSync(fd, `${owner}\n${new Date().toISOString()}\n`);
}

function readLockOwner(): string | undefined {
  try {
    return readFileSync(LOCK_PATH, "utf8").split("\n", 1)[0];
  } catch {
    return undefined;
  }
}

function touchLock(owner: string): void {
  if (readLockOwner() !== owner) return;
  try {
    writeFileSync(LOCK_PATH, `${owner}\n${new Date().toISOString()}\n`);
  } catch {}
}

function removeLockIfOwner(owner: string): void {
  if (readLockOwner() !== owner) return;
  try {
    unlinkSync(LOCK_PATH);
  } catch {}
}

function removeStaleLock(): void {
  try {
    if (!existsSync(LOCK_PATH)) return;
    if (Date.now() - statSync(LOCK_PATH).mtimeMs > OAUTH_LOCK_STALE_MS) unlinkSync(LOCK_PATH);
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runInteractiveOAuthFlow(
  serverName: string,
  config: ServerConfig,
  promptForCode: (authorizationUrl: string) => Promise<string | undefined>,
): Promise<{ ok: boolean; message: string }> {
  if (!config.url) return { ok: false, message: `${serverName}: OAuth requires a remote url` };
  if (!oauthEnabled(config)) return { ok: false, message: `${serverName}: OAuth is not enabled` };

  const serverUrl = expandEnvValue(config.url);
  let authorizationUrl: string | undefined;
  const callback = await startLoopbackCallback().catch(() => undefined);
  const provider = createOAuthProvider(serverName, config, {
    interactive: true,
    onAuthorizationUrl: async (url) => {
      authorizationUrl = url.toString();
      await openBrowser(authorizationUrl);
    },
  });

  const scope = config.oauth?.scopes?.filter(Boolean).join(" ") || undefined;
  const first = await withOAuthStoreLock(() => auth(provider, { serverUrl, scope }));
  if (first === "AUTHORIZED") {
    callback?.close();
    return { ok: true, message: `${serverName}: already authorized` };
  }

  if (!authorizationUrl) {
    callback?.close();
    return { ok: false, message: `${serverName}: OAuth did not return an authorization URL` };
  }

  let codeOrUrl: string | undefined;
  if (callback) {
    codeOrUrl = await Promise.race([callback.code, timeoutAfter(OAUTH_TIMEOUT_MS)]).catch(() => undefined);
    if (!codeOrUrl) codeOrUrl = await promptForCode(authorizationUrl);
  } else {
    codeOrUrl = await promptForCode(authorizationUrl);
  }
  callback?.close();

  const code = extractAuthorizationCode(codeOrUrl);
  if (!code) return { ok: false, message: `${serverName}: OAuth login cancelled or no code provided` };

  const result: AuthResult = await withOAuthStoreLock(() =>
    auth(provider, { serverUrl, authorizationCode: code, scope }),
  );
  return result === "AUTHORIZED"
    ? { ok: true, message: `${serverName}: OAuth login complete` }
    : { ok: false, message: `${serverName}: OAuth did not complete authorization` };
}

function readRecord(serverName: string, config: ServerConfig): OAuthStoreRecord | undefined {
  return loadStore().servers[oauthRecordKey(serverName, config)];
}

function loadStore(): OAuthStore {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as OAuthStore;
    if (parsed.version === 1 && parsed.servers && typeof parsed.servers === "object") return parsed;
  } catch {}
  return { version: 1, servers: {} };
}

function saveStore(store: OAuthStore): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, STORE_PATH);
  try {
    chmodSync(STORE_PATH, 0o600);
  } catch {}
}

function expandEnvValue(value: string): string;
function expandEnvValue(value: string | undefined): string | undefined;
function expandEnvValue(value: string | undefined): string | undefined {
  return value?.replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, key) => process.env[key] ?? "");
}

async function openBrowser(url: string): Promise<void> {
  const command = platform() === "darwin" ? "open" : platform() === "win32" ? "cmd" : "xdg-open";
  const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function startLoopbackCallback(): Promise<{ code: Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const requestUrl = new URL(req.url ?? "/", DEFAULT_OAUTH_REDIRECT_URL);
      if (requestUrl.pathname !== new URL(DEFAULT_OAUTH_REDIRECT_URL).pathname) {
        res.writeHead(404).end("Not found");
        return;
      }
      const code = requestUrl.searchParams.get("code");
      const error = requestUrl.searchParams.get("error");
      if (code) {
        res.writeHead(200, { "content-type": "text/plain" }).end("OAuth complete. You can return to pi.");
        codeResolver?.(code);
      } else {
        res.writeHead(400, { "content-type": "text/plain" }).end(error ? `OAuth failed: ${error}` : "Missing code");
        codeRejecter?.(new Error(error ?? "Missing OAuth code"));
      }
      server.close();
    });

    let codeResolver: ((code: string) => void) | undefined;
    let codeRejecter: ((error: Error) => void) | undefined;
    const code = new Promise<string>((res, rej) => {
      codeResolver = res;
      codeRejecter = rej;
    });
    server.on("error", reject);
    server.listen(Number(new URL(DEFAULT_OAUTH_REDIRECT_URL).port), "127.0.0.1", () => {
      resolve({ code, close: () => server.close() });
    });
  });
}

function timeoutAfter(ms: number): Promise<undefined> {
  return new Promise((resolve) => setTimeout(() => resolve(undefined), ms));
}

function extractAuthorizationCode(input: string | undefined): string | undefined {
  const value = input?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.searchParams.get("code") ?? undefined;
  } catch {
    return value;
  }
}
