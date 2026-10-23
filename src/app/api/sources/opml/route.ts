import { sourcesOpml } from "@/lib/discover/sources";

export async function GET() {
  return new Response(await sourcesOpml(), {
    headers: {
      "Content-Type": "text/x-opml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="knowledge-sources.opml"',
      "Cache-Control": "no-store",
    },
  });
}
