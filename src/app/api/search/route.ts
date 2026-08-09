import { NextResponse } from "next/server";
import { defaultSearchProvider, runSearch } from "@/lib/providers/search";

function calculateImportanceScore(url: string, baseScore: number, dateString?: string): number {
  let freshnessWeight = 1.0;
  let authorityWeight = 1.0;

  // 1. Freshness calculations
  if (dateString) {
    try {
      const publishDate = new Date(dateString);
      const ageInDays = (Date.now() - publishDate.getTime()) / (1000 * 60 * 60 * 24);

      if (ageInDays >= 0) {
        if (ageInDays <= 7) {
          freshnessWeight = 1.2;
        } else if (ageInDays <= 30) {
          freshnessWeight = 1.1;
        } else if (ageInDays <= 180) {
          freshnessWeight = 1.0;
        } else if (ageInDays <= 365) {
          freshnessWeight = 0.85;
        } else if (ageInDays <= 730) {
          freshnessWeight = 0.7;
        } else {
          freshnessWeight = 0.5;
        }
      }
    } catch {
      freshnessWeight = 0.9;
    }
  } else {
    freshnessWeight = 0.9;
  }

  // 2. Authority calculations based on URL domain
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    const officialDomains = [
      "nextjs.org",
      "vercel.com",
      "react.dev",
      "reactjs.org",
      "developer.mozilla.org",
      "mdn.mozilla.org",
      "typescriptlang.org",
      "nodejs.org",
      "python.org",
      "github.com",
      "npmjs.com",
      "pypi.org",
      "docker.com",
      "kubernetes.io",
      "aws.amazon.com",
      "google.com",
      "microsoft.com",
      "arxiv.org"
    ];

    const techPlatforms = [
      "medium.com",
      "dev.to",
      "hashnode.dev",
      "substack.com",
      "stackoverflow.com",
      "stackexchange.com"
    ];

    if (officialDomains.some(d => hostname === d || hostname.endsWith("." + d))) {
      authorityWeight = 1.25;
    } else if (techPlatforms.some(d => hostname === d || hostname.endsWith("." + d))) {
      authorityWeight = 1.1;
    }
  } catch {
    // URL parsing failed, keep neutral
  }

  return baseScore * freshnessWeight * authorityWeight;
}

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
    
    const ratedResults = results.map(r => {
      const finalScore = calculateImportanceScore(r.url, r.score, r.date);
      return {
        ...r,
        // Clamp score between 0.01 and 1.2 for display logic
        score: Math.min(1.2, Math.max(0.01, finalScore))
      };
    });

    ratedResults.sort((a, b) => b.score - a.score);

    return NextResponse.json({ success: true, data: { results: ratedResults, provider } });
  } catch (error: unknown) {
    console.error("Search API error:", error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
