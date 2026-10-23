import { NextResponse } from "next/server";
import { generateAnswer } from "@/lib/rag/llm";
import { SEARCH_SERVER_URL } from "@/lib/rag/searchServer";

function priorTurns(history: unknown): string {
  if (!Array.isArray(history)) return "";
  const lines = history
    .filter(
      (turn) =>
        turn &&
        (turn.role === "user" || turn.role === "assistant") &&
        typeof turn.content === "string" &&
        turn.content.trim(),
    )
    .slice(-8)
    .map(
      (turn) =>
        `${turn.role === "user" ? "User" : "Assistant"}: ${String(turn.content).slice(0, 4000)}`,
    );
  if (lines.length === 0) return "";
  return `Conversation so far:\n${lines.join("\n\n")}\n\n`;
}

function retrievalQuery(query: string, history: unknown): string {
  if (!Array.isArray(history)) return query;
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length > 8) return query;
  const priorUser = [...history]
    .reverse()
    .find((turn) => turn && turn.role === "user" && typeof turn.content === "string" && turn.content.trim());
  if (!priorUser) return query;
  return `${String(priorUser.content).slice(0, 500)}\n${query}`;
}

export async function POST(request: Request) {
  try {
    const { query, index, namespace, namespaces, history, provider, model } = await request.json();
    const searchNamespaces: string[] = (Array.isArray(namespaces) ? namespaces : [namespace])
      .filter((name: unknown): name is string => typeof name === "string" && name.trim() !== "");

    if (!query) {
      return NextResponse.json({ success: false, error: "Query is required" }, { status: 400 });
    }
    if (searchNamespaces.length === 0) {
      return NextResponse.json({ success: false, error: "Namespace is required" }, { status: 400 });
    }

    // 1. Query the local search server (chosen Pinecone index and namespace).
    let chunks: any[] = [];
    let searchError = "";
    let reranked = false;
    let hybrid = false;
    let searchWarnings: string[] = [];
    const searchQuery = retrievalQuery(query, history);
    try {
      const searchRes = await fetch(`${SEARCH_SERVER_URL}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: searchQuery, index, namespaces: searchNamespaces, topK: 5, rerank: true }),
        signal: AbortSignal.timeout(90000),
      });

      if (searchRes.ok) {
        const searchData = await searchRes.json();
        chunks = searchData.chunks || [];
        reranked = Boolean(searchData.reranked);
        hybrid = Boolean(searchData.hybrid);
        searchWarnings = (Array.isArray(searchData.errors) ? searchData.errors : []).map(
          (item: { namespace?: string; method?: string }) => `${item.namespace} (${item.method} search failed)`,
        );
      } else {
        const errorText = await searchRes.text();
        searchError = `Search server returned HTTP ${searchRes.status}: ${errorText.slice(0, 100)}`;
      }
    } catch (e: any) {
      console.error("Failed to query Flask search server:", e);
      searchError = "Search server is not running on port 8765. Start run-web-knowledge-pipeline.bat and wait until it says Ready for chat.";
    }

    if (searchError) {
      return NextResponse.json({
        success: false,
        error: searchError,
        chunks: []
      });
    }

    if (chunks.length === 0) {
      return NextResponse.json({
        success: true,
        answer: "No relevant content found in the selected namespaces. Make sure you have synced files to them.",
        chunks: [],
        warnings: searchWarnings,
      });
    }

    // Compile context
    const contextText = chunks
      .map((c, i) => `[Citation ${i + 1}] Title: ${c.title || "Untitled"}\nSource: ${c.source || "Unknown"}\nContent:\n${c.text}\n---`)
      .join("\n\n");

    const systemPrompt = `You are a helpful knowledge assistant. Answer the user's question using ONLY the provided text snippets from the knowledge base. 
If the context does not contain the answer, say "I cannot find the answer in the retrieved documents."
Use the conversation only to understand follow-up questions. The retrieved snippets are the only source for facts.
Format your response using Markdown. Proactively cite the text snippets by suffixing your statements with their corresponding citation numbers, e.g., "The project uses Next.js [1] and sentence-transformers [2]."

Retrieved Context Snippets:
${contextText}`;

    const userPrompt = `${priorTurns(history)}Question: ${query}`;

    let answer = "";
    let providerUsed = "";
    let modelUsed = "";

    try {
      const generated = await generateAnswer(systemPrompt, userPrompt, { provider, model });
      answer = generated.text;
      providerUsed = generated.label;
      modelUsed = generated.model;
    } catch (err) {
      console.error("LLM call failed:", err);
      answer = err instanceof Error ? err.message : "The model request failed.";
      providerUsed = "None";
    }

    return NextResponse.json({
      success: true,
      answer,
      chunks,
      provider: providerUsed,
      model: modelUsed,
      reranked,
      hybrid,
      warnings: searchWarnings,
    });

  } catch (error: any) {
    console.error("RAG Chat API error:", error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
