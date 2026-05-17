import { NextResponse } from "next/server";
import { defaultSearchProvider, listSearchProviders } from "@/lib/providers/search";
import { defaultScrapeProvider, listScrapeProviders } from "@/lib/providers/scrape";

export async function GET() {
  const search = await listSearchProviders();
  const scrape = await listScrapeProviders();

  return NextResponse.json({
    success: true,
    data: {
      search,
      scrape,
      defaults: {
        search: defaultSearchProvider(),
        scrape: defaultScrapeProvider(),
      },
    },
  });
}
