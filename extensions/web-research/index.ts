import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as cheerio from "cheerio";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

const DEFAULT_USER_AGENT =
  process.env.WEB_RESEARCH_USER_AGENT ??
  "Mozilla/5.0 (compatible; pi-web-research/1.0; +https://pi.dev)";

const MAX_FETCH_BYTES = Number(process.env.WEB_FETCH_MAX_BYTES ?? 5_000_000);
const DEFAULT_FETCH_CHARS = Number(process.env.WEB_FETCH_MAX_CHARS ?? 30_000);
const DEFAULT_TIMEOUT_MS = Number(process.env.WEB_RESEARCH_TIMEOUT_MS ?? 20_000);

type SearchResult = {
  title: string;
  url: string;
  snippet?: string;
  source?: string;
};

function enumSchema<T extends string[]>(values: [...T], description?: string) {
  return Type.Union(values.map((value) => Type.Literal(value)), { description });
}

function domainOf(rawUrl: string): string | undefined {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function assertHttpUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http and https URLs are supported, got ${url.protocol}`);
  }
  return url;
}

function signalWithTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeoutSignal;
  return AbortSignal.any([signal, timeoutSignal]);
}

function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) return { text, truncated: false };
  return {
    text: text.slice(0, Math.max(0, maxChars)) + `\n\n[truncated to ${maxChars} characters]`,
    truncated: true,
  };
}

function normalizeDuckDuckGoUrl(href: string): string | undefined {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : url.href;
  } catch {
    return undefined;
  }
}

async function braveSearch(query: string, maxResults: number, freshness: string | undefined, signal: AbortSignal | undefined) {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new Error("BRAVE_API_KEY is not set");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(maxResults, 1), 20)));
  if (freshness && freshness !== "any") {
    const map: Record<string, string> = { day: "pd", week: "pw", month: "pm", year: "py" };
    url.searchParams.set("freshness", map[freshness] ?? freshness);
  }

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
      "User-Agent": DEFAULT_USER_AGENT,
    },
    signal,
  });
  if (!response.ok) throw new Error(`Brave Search failed: HTTP ${response.status} ${response.statusText}`);
  const data = (await response.json()) as any;
  const results: SearchResult[] = (data.web?.results ?? []).slice(0, maxResults).map((item: any) => ({
    title: String(item.title ?? ""),
    url: String(item.url ?? ""),
    snippet: item.description ? String(item.description).replace(/<[^>]+>/g, "") : undefined,
    source: domainOf(String(item.url ?? "")),
  }));
  return results.filter((result) => result.title && result.url);
}

async function duckDuckGoSearch(query: string, maxResults: number, signal: AbortSignal | undefined) {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
    },
    signal,
  });
  if (!response.ok) throw new Error(`DuckDuckGo search failed: HTTP ${response.status} ${response.statusText}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const results: SearchResult[] = [];

  $(".result").each((_i, el) => {
    if (results.length >= maxResults) return false;
    const titleEl = $(el).find(".result__title a").first();
    const href = titleEl.attr("href");
    const normalized = href ? normalizeDuckDuckGoUrl(href) : undefined;
    const title = titleEl.text().replace(/\s+/g, " ").trim();
    const snippet = $(el).find(".result__snippet").text().replace(/\s+/g, " ").trim();
    if (title && normalized) {
      results.push({ title, url: normalized, snippet: snippet || undefined, source: domainOf(normalized) });
    }
  });

  return results;
}

async function searchWeb(params: any, signal: AbortSignal | undefined) {
  const maxResults = Math.min(Math.max(Number(params.max_results ?? 8), 1), 20);
  const query = params.site ? `site:${params.site} ${params.query}` : params.query;
  const provider = (process.env.WEB_SEARCH_PROVIDER ?? (process.env.BRAVE_API_KEY ? "brave" : "duckduckgo")).toLowerCase();
  const requestSignal = signalWithTimeout(signal, DEFAULT_TIMEOUT_MS);

  if (provider === "brave") return braveSearch(query, maxResults, params.freshness, requestSignal);
  if (provider === "duckduckgo" || provider === "ddg") return duckDuckGoSearch(query, maxResults, requestSignal);
  throw new Error(`Unsupported WEB_SEARCH_PROVIDER: ${provider}. Supported: brave, duckduckgo`);
}

function getMeta($: cheerio.CheerioAPI, name: string) {
  return (
    $(`meta[name="${name}"]`).attr("content") ??
    $(`meta[property="og:${name}"]`).attr("content") ??
    undefined
  );
}

function extractLinks($: cheerio.CheerioAPI, baseUrl: string) {
  const links: Array<{ text: string; url: string }> = [];
  $("a[href]").each((_i, el) => {
    if (links.length >= 100) return false;
    const href = $(el).attr("href");
    if (!href) return;
    try {
      const url = new URL(href, baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      const text = $(el).text().replace(/\s+/g, " ").trim().slice(0, 200);
      links.push({ text, url: url.href });
    } catch {
      // Ignore invalid links.
    }
  });
  return links;
}

async function readLimitedBody(response: Response) {
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength && contentLength > MAX_FETCH_BYTES) {
    throw new Error(`Response is too large (${contentLength} bytes; limit ${MAX_FETCH_BYTES})`);
  }

  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_FETCH_BYTES) {
      await reader.cancel();
      throw new Error(`Response exceeded ${MAX_FETCH_BYTES} byte limit`);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function decodeBody(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function htmlToReadable(html: string, finalUrl: string, format: string) {
  const $ = cheerio.load(html);
  const titleFromHtml = $("title").first().text().replace(/\s+/g, " ").trim() || undefined;
  const description = getMeta($, "description");
  const links = extractLinks($, finalUrl);

  let articleTitle = titleFromHtml;
  let contentHtml: string | undefined;
  let textContent: string | undefined;

  try {
    const dom = new JSDOM(html, { url: finalUrl });
    const article = new Readability(dom.window.document).parse();
    if (article) {
      articleTitle = article.title || articleTitle;
      contentHtml = article.content || undefined;
      textContent = article.textContent || undefined;
    }
  } catch {
    // Fall back below.
  }

  if (!contentHtml) {
    $("script, style, noscript, svg").remove();
    contentHtml = $("body").html() ?? html;
    textContent = $("body").text().replace(/\s+/g, " ").trim();
  }

  let content: string;
  if (format === "html") {
    content = contentHtml;
  } else if (format === "text") {
    content = textContent ?? cheerio.load(contentHtml).text().replace(/\s+/g, " ").trim();
  } else {
    const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
    content = turndown.turndown(contentHtml);
  }

  return { title: articleTitle, description, content, links };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web and return ranked results with titles, URLs, snippets, and source domains.",
    promptSnippet: "Search the public web for current or external information.",
    promptGuidelines: [
      "Use web_search when the user asks for current, external, or source-backed information that is not available in the local workspace.",
      "After web_search identifies promising pages, use web_fetch on selected URLs before making factual claims.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query." }),
      max_results: Type.Optional(Type.Integer({ description: "Maximum results to return, 1-20. Default: 8." })),
      freshness: Type.Optional(enumSchema(["any", "day", "week", "month", "year"], "Optional freshness filter. Supported by Brave; ignored by DuckDuckGo.")),
      site: Type.Optional(Type.String({ description: "Restrict results to this domain, e.g. wikipedia.org or developer.mozilla.org." })),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const results = await searchWeb(params, signal);
        return {
          content: [{ type: "text", text: JSON.stringify({ query: params.query, results }, null, 2) }],
          details: { query: params.query, results },
        };
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: "text", text: error?.message ?? String(error) }],
          details: { error: error?.message ?? String(error) },
        };
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetch a URL and return readable extracted content as markdown, text, HTML, or JSON with source metadata.",
    promptSnippet: "Fetch and extract readable content from a public URL.",
    promptGuidelines: [
      "Use web_fetch to inspect source pages before summarizing or citing them.",
      "Prefer web_fetch format=markdown for normal pages; use format=json for APIs and format=html only when raw markup is needed.",
      "When web_fetch returns truncated=true, mention that only part of the source was available or fetch a smaller/more specific URL if possible.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
      format: Type.Optional(enumSchema(["markdown", "text", "html", "json"], "Output format. Default: markdown.")),
      max_chars: Type.Optional(Type.Integer({ description: `Maximum characters to return. Default: ${DEFAULT_FETCH_CHARS}.` })),
      include_links: Type.Optional(Type.Boolean({ description: "Include up to 100 extracted links. Default: false." })),
    }),
    async execute(_toolCallId, params, signal) {
      try {
        const requestedUrl = assertHttpUrl(params.url);
        const format = params.format ?? "markdown";
        const maxChars = Math.min(Math.max(Number(params.max_chars ?? DEFAULT_FETCH_CHARS), 1_000), 200_000);
        const response = await fetch(requestedUrl, {
          redirect: "follow",
          headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*" },
          signal: signalWithTimeout(signal, DEFAULT_TIMEOUT_MS),
        });

        const finalUrl = response.url || requestedUrl.href;
        const contentType = response.headers.get("content-type") ?? "";
        const status = response.status;
        const ok = response.ok;
        const bytes = await readLimitedBody(response);
        const raw = decodeBody(bytes);

        let title: string | undefined;
        let description: string | undefined;
        let content = raw;
        let links: Array<{ text: string; url: string }> = [];

        if (format === "json" || contentType.includes("application/json") || contentType.includes("+json")) {
          if (format === "json") {
            try {
              content = JSON.stringify(JSON.parse(raw), null, 2);
            } catch {
              content = raw;
            }
          }
        } else if (contentType.includes("text/html") || /^\s*</.test(raw)) {
          const extracted = htmlToReadable(raw, finalUrl, format);
          title = extracted.title;
          description = extracted.description;
          content = extracted.content;
          links = extracted.links;
        }

        const truncated = truncateText(content, maxChars);
        const result = {
          url: requestedUrl.href,
          final_url: finalUrl,
          status,
          ok,
          content_type: contentType,
          title,
          description,
          content: truncated.text,
          links: params.include_links ? links : undefined,
          truncated: truncated.truncated,
        };

        return {
          isError: !ok,
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: "text", text: error?.message ?? String(error) }],
          details: { error: error?.message ?? String(error), url: params.url },
        };
      }
    },
  });
}
