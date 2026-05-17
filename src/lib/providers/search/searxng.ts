import type { SearchOptions, SearchResult } from "../types";

export function getSearxngUrl(): string | undefined {
  return process.env.SEARXNG_URL?.trim() || undefined;
}

export function isSearxngConfigured(): boolean {
  return Boolean(getSearxngUrl());
}

export async function checkSearxngHealth(): Promise<boolean> {
  const base = getSearxngUrl()?.replace(/\/$/, "");
  if (!base) return false;
  try {
    const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    try {
      const res = await fetch(`${base}/search?q=test&format=json`, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: "application/json" },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export async function searchSearxng(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const base = process.env.SEARXNG_URL?.replace(/\/$/, "");
  if (!base) {
    throw new Error("SEARXNG_URL is not set. Start Docker services and add SEARXNG_URL=http://localhost:8080 to .env.local");
  }

  const limit = options.limit ?? 20;
  const params = new URLSearchParams({
    q: query,
    format: "json",
    pageno: "1",
  });

  if (options.timeRange && options.timeRange !== "any" && options.timeRange !== "all") {
    const range = options.timeRange === "day" ? "day" : options.timeRange === "week" ? "day" : options.timeRange === "month" ? "month" : options.timeRange === "year" ? "year" : undefined;
    if (range) params.set("time_range", range);
  }

  const res = await fetch(`${base}/search?${params.toString()}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SearXNG error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = (data.results ?? []) as Array<{
    title?: string;
    url?: string;
    content?: string;
    publishedDate?: string;
  }>;

  return raw.slice(0, limit).map((r, i) => ({
    title: r.title || "Untitled",
    url: r.url || "",
    content: r.content || "",
    score: Math.max(0.1, 1 - i * 0.05),
    date: r.publishedDate,
  })).filter((r) => r.url);
}
