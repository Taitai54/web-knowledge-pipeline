import { NextResponse } from "next/server";
import { SEARCH_SERVER_URL } from "@/lib/rag/searchServer";

export async function GET(request: Request) {
  const index = new URL(request.url).searchParams.get("index") || "";
  const query = index ? `?index=${encodeURIComponent(index)}` : "";
  try {
    const [healthRes, nsRes, indexesRes] = await Promise.all([
      fetch(`${SEARCH_SERVER_URL}/health${query}`, { signal: AbortSignal.timeout(5000) }),
      fetch(`${SEARCH_SERVER_URL}/namespaces${query}`, { signal: AbortSignal.timeout(15000) }),
      fetch(`${SEARCH_SERVER_URL}/indexes`, { signal: AbortSignal.timeout(15000) }),
    ]);

    const health = healthRes.ok ? await healthRes.json() : {};
    const nsBody = nsRes.ok ? await nsRes.json() : {};
    const indexesBody = indexesRes.ok ? await indexesRes.json() : {};

    return NextResponse.json({
      success: true,
      online: healthRes.ok,
      model: health.model || "cold",
      rerank: health.rerank || "cold",
      index: health.index || nsBody.index || index || "peace",
      error: health.error || (!nsRes.ok ? "Could not list namespaces" : ""),
      namespaces: Array.isArray(nsBody.namespaces) ? nsBody.namespaces : [],
      indexes: Array.isArray(indexesBody.indexes) ? indexesBody.indexes : [],
    });
  } catch {
    return NextResponse.json({
      success: true,
      online: false,
      model: "offline",
      rerank: "offline",
      index: index || "peace",
      error: "Search server is not running. Start the pipeline with run-web-knowledge-pipeline.bat.",
      namespaces: [],
      indexes: [],
    });
  }
}
