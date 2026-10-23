import { NextResponse } from "next/server";
import { discoverPages } from "@/lib/discover/collect";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const source = body?.source === "feed" ? "feed" : body?.source === "sitemap" ? "sitemap" : "";
    if (!source) {
      return NextResponse.json({ success: false, error: "Choose a sitemap or a feed" }, { status: 400 });
    }
    if (!body?.url || typeof body.url !== "string") {
      return NextResponse.json({ success: false, error: "A URL is required" }, { status: 400 });
    }
    const pages = await discoverPages({
      source,
      url: body.url,
      pathPrefix: typeof body.pathPrefix === "string" ? body.pathPrefix : "",
      limit: typeof body.limit === "number" ? body.limit : undefined,
    });
    return NextResponse.json({ success: true, data: { results: pages, count: pages.length } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Discovery failed";
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    const detail = cause && !message.includes(cause) ? `${message}: ${cause}` : message;
    return NextResponse.json({ success: false, error: detail }, { status: 400 });
  }
}
