export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  date?: string;
}

export interface SearchOptions {
  timeRange?: string;
  limit?: number;
}

export interface ScrapeResult {
  markdown: string;
}
