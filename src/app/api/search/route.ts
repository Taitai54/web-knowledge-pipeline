import { NextResponse } from "next/server";
import { defaultSearchProvider, runSearch } from "@/lib/providers/search";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const q = searchParams.get("q");
    const provider = searchParams.get("provider") || defaultSearchProvider();
    const timeRange = searchParams.get("timeRange") || "all";

    if (!q) {
      return NextResponse.json(
        { success: false, error: "Query is required" },
        { status: 400 },
      );
    }

    const results = await runSearch(provider, q, { timeRange, limit: 20 });
    results.sort((a, b) => b.score - a.score);

    return NextResponse.json({ success: true, data: { results, provider } });
  } catch (error: unknown) {
    console.error("Search API error:", error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
