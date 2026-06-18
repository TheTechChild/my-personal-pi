import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { format } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const STATE_KEY = Symbol.for("my-personal-pi.console-capture");
const DEFAULT_LOG_FILE = join(homedir(), ".pi", "agent", "pi-console.log");
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

type ConsoleMethod = (typeof CONSOLE_METHODS)[number];

type CaptureState = {
  installed: boolean;
  logFile?: string;
  originalConsole: Partial<Record<ConsoleMethod, (...args: unknown[]) => void>>;
  originalStderrWrite?: typeof process.stderr.write;
};

function state(): CaptureState {
  const globalWithState = globalThis as typeof globalThis & { [STATE_KEY]?: CaptureState };
  globalWithState[STATE_KEY] ??= {
    installed: false,
    originalConsole: {},
  };
  return globalWithState[STATE_KEY];
}

function normalizeMessage(message: string): string[] {
  const normalized = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length > 0 ? lines : [""];
}

function appendCaptured(logFile: string, level: string, message: string) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const timestamp = new Date().toISOString();
    const payload = normalizeMessage(message)
      .map((line) => `[${timestamp}] [${level}] ${line}`)
      .join("\n");
    appendFileSync(logFile, `${payload}\n`, "utf8");
  } catch {
    // Never let logging failures affect pi startup or the active session.
  }
}

function chunkToString(chunk: unknown, encoding?: BufferEncoding): string {
  if (Buffer.isBuffer(chunk)) return chunk.toString(encoding);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(encoding);
  return String(chunk ?? "");
}

function shouldCapture(ctx: ExtensionContext): boolean {
  if (process.env.PI_CONSOLE_CAPTURE === "0") return false;
  return ctx.hasUI && process.stdout.isTTY === true;
}

function installCapture(ctx: ExtensionContext) {
  if (!shouldCapture(ctx)) return;

  const captureState = state();
  if (captureState.installed) return;

  const logFile = process.env.PI_CONSOLE_CAPTURE_LOG || DEFAULT_LOG_FILE;
  captureState.installed = true;
  captureState.logFile = logFile;

  for (const method of CONSOLE_METHODS) {
    captureState.originalConsole[method] = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]) => {
      appendCaptured(logFile, `console.${method}`, format(...args));
    };
  }

  captureState.originalStderrWrite = process.stderr.write;
  (process.stderr as NodeJS.WriteStream & { write: (...args: unknown[]) => boolean }).write = (
    ...args: unknown[]
  ): boolean => {
    const [chunk, encodingOrCallback, callback] = args;
    const encoding = typeof encodingOrCallback === "string" ? (encodingOrCallback as BufferEncoding) : undefined;
    const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    appendCaptured(logFile, "stderr", chunkToString(chunk, encoding));
    if (typeof cb === "function") process.nextTick(cb as (error?: Error | null) => void);
    return true;
  };

  appendCaptured(logFile, "console-capture", `capturing interactive console/stderr output to ${logFile}`);
}

export default function consoleCapture(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    installCapture(ctx);
  });
}
