import type { ScrapeResult } from "../types";

export function isCrawl4aiConfigured(): boolean {
  return Boolean(process.env.CRAWL4AI_BASE_URL?.trim());
}

function extractMarkdown(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;

  const direct =
    obj.fit_markdown ||
    obj.markdown ||
    obj.md ||
    obj.content;
  if (typeof direct === "string" && direct.trim()) return direct;

  const results = obj.results;
  if (Array.isArray(results) && results.length > 0) {
    return extractMarkdown(results[0]);
  }

  const data = obj.data;
  if (data && typeof data === "object") {
    return extractMarkdown(data);
  }

  return null;
}

export async function scrapeCrawl4ai(url: string): Promise<ScrapeResult> {
  const base = process.env.CRAWL4AI_BASE_URL?.replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "CRAWL4AI_BASE_URL is not set. Start Docker and add CRAWL4AI_BASE_URL=http://localhost:11235 to .env.local",
    );
  }

  const endpoints = [`${base}/md`, `${base}/crawl`];
  let lastError = "";

  for (const endpoint of endpoints) {
    try {
      const body =
        endpoint.endsWith("/md")
          ? { url, f: "fit" }
          : { urls: [url] };

      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        lastError = `${endpoint}: ${res.status} ${(await res.text()).slice(0, 300)}`;
        continue;
      }

      const data = await res.json();
      const markdown = extractMarkdown(data);
      if (markdown) return { markdown };
      lastError = `${endpoint}: no markdown in response`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  throw new Error(`Crawl4AI scrape failed. ${lastError}`);
}

export async function checkCrawl4aiHealth(): Promise<boolean> {
  const base = process.env.CRAWL4AI_BASE_URL?.replace(/\/$/, "");
  if (!base) return false;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}
