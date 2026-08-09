import type { SearchOptions, SearchResult } from "../types";

export function isBraveConfigured(): boolean {
  const key = process.env.BRAVE_API_KEY;
  return Boolean(key && key.trim().length > 0);
}

function parsePageAge(pageAge: string): string | undefined {
  if (!pageAge) return undefined;
  
  // If it's already an ISO timestamp or yyyy-mm-dd date format, return it
  if (pageAge.includes("-") && !pageAge.includes("ago")) {
    return pageAge;
  }

  const now = new Date();
  const match = pageAge.trim().match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case "second":
        now.setSeconds(now.getSeconds() - value);
        break;
      case "minute":
        now.setMinutes(now.getMinutes() - value);
        break;
      case "hour":
        now.setHours(now.getHours() - value);
        break;
      case "day":
        now.setDate(now.getDate() - value);
        break;
      case "week":
        now.setDate(now.getDate() - value * 7);
        break;
      case "month":
        now.setMonth(now.getMonth() - value);
        break;
      case "year":
        now.setFullYear(now.getFullYear() - value);
        break;
    }
    return now.toISOString();
  }
  return pageAge;
}

export async function searchBrave(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Brave API key is missing. Set BRAVE_API_KEY in environment variables.");
  }

  const limit = options.limit ?? 20;
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": apiKey
    },
    signal: AbortSignal.timeout(15000), // 15s timeout
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brave Search error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const rawResults = data.web?.results || [];

  return rawResults.map((r: any, index: number) => {
    // Brave relevance ranking defaults to index ordering
    const score = Math.max(0.1, 1 - index * 0.05);
    const parsedDate = r.page_age ? parsePageAge(r.page_age) : undefined;

    return {
      title: r.title || "Untitled",
      url: r.url || "",
      content: r.description || "",
      score,
      date: parsedDate,
    };
  }).filter((r: SearchResult) => r.url);
}
