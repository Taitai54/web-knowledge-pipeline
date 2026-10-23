import type { ScrapeResult } from "../types";

export function isJinaConfigured(): boolean {
  return true;
}

export async function scrapeJina(url: string): Promise<ScrapeResult> {
  const headers: Record<string, string> = {
    Accept: "text/markdown",
    "User-Agent": "web-knowledge-pipeline/0.1",
  };
  const key = process.env.JINA_API_KEY?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;

  const response = await fetch(`https://r.jina.ai/${url}`, {
    headers,
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    throw new Error(`Jina Reader returned HTTP ${response.status}`);
  }
  const markdown = await response.text();
  if (!markdown.trim()) {
    throw new Error("Jina Reader returned empty markdown");
  }
  return { markdown };
}
