import { NextResponse } from "next/server";
import { tavily } from "@tavily/core";
import FirecrawlApp from "@mendable/firecrawl-js";

// Initialize clients
const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });
const fcApp = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY });

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q");
    const provider = searchParams.get("provider") || "tavily";
    const timeRange = searchParams.get("timeRange") || "all";

    if (provider === "tavily" && (!process.env.TAVILY_API_KEY || process.env.TAVILY_API_KEY.startsWith("tvly-xxx"))) {
      return NextResponse.json({ success: false, error: "Tavily API key is missing or invalid" }, { status: 500 });
    }
    if (provider === "firecrawl" && (!process.env.FIRECRAWL_API_KEY || process.env.FIRECRAWL_API_KEY.startsWith("fc-xxx"))) {
      return NextResponse.json({ success: false, error: "Firecrawl API key is missing or invalid" }, { status: 500 });
    }

    if (!q) {
      return NextResponse.json(
        { success: false, error: "Query is required" },
        { status: 400 },
      );
    }

    let results = [];

    if (provider === "tavily") {
      const days = timeRange === 'day' ? 1 : timeRange === 'week' ? 7 : timeRange === 'month' ? 30 : timeRange === 'year' ? 365 : undefined;
      const tavilyResponse = await tvly.search(q, {
        searchDepth: "advanced",
        includeImages: false,
        includeAnswer: false,
        maxResults: 10,
        days: days,
      });

      results = tavilyResponse.results.map((r: any) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        date: r.publishedDate || undefined,
      }));
    } else if (provider === "firecrawl") {
      // Note: Firecrawl search API
      const searchResponse = await fcApp.search(q, {
        limit: 10
      });
      
      const dataArray = searchResponse.web || (searchResponse as any).data || (Array.isArray(searchResponse) ? searchResponse : []);
      
      results = dataArray.map((r: any) => ({
        title: r.title || r.metadata?.title || 'Untitled',
        url: r.url,
        content: r.description || r.metadata?.description || '',
        score: 1.0, // Default score
        date: r.metadata?.date || undefined
      }));
    } else {
      return NextResponse.json(
        { success: false, error: "Invalid provider" },
        { status: 400 },
      );
    }

    return NextResponse.json({ success: true, data: { results } });
  } catch (error: any) {
    console.error("Search API error:", error);
    return NextResponse.json(
      { success: false, error: error.message || "Internal Server Error" },
      { status: 500 },
    );
  }
}
