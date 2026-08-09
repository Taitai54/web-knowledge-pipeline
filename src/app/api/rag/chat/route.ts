import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const { query, namespace } = await request.json();

    if (!query) {
      return NextResponse.json({ success: false, error: "Query is required" }, { status: 400 });
    }
    if (!namespace) {
      return NextResponse.json({ success: false, error: "Namespace is required" }, { status: 400 });
    }

    // 1. Query the Flask search server
    let chunks: any[] = [];
    let searchError = "";
    try {
      const searchRes = await fetch("http://localhost:8765/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, namespace, topK: 5 }),
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (searchRes.ok) {
        const searchData = await searchRes.json();
        chunks = searchData.chunks || [];
      } else {
        const errorText = await searchRes.text();
        searchError = `Search server returned HTTP ${searchRes.status}: ${errorText.slice(0, 100)}`;
      }
    } catch (e: any) {
      console.error("Failed to query Flask search server:", e);
      searchError = "Search server is not running on port 8765. Please run 'npm run search-server' first.";
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
        answer: "No relevant content found in the selected namespace. Make sure you have synced files to it.",
        chunks: []
      });
    }

    // 2. Check for LLM keys
    const geminiKey = process.env.GEMINI_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    // Compile context
    const contextText = chunks
      .map((c, i) => `[Citation ${i + 1}] Title: ${c.title || "Untitled"}\nSource: ${c.source || "Unknown"}\nContent:\n${c.text}\n---`)
      .join("\n\n");

    const systemPrompt = `You are a helpful knowledge assistant. Answer the user's question using ONLY the provided text snippets from the knowledge base. 
If the context does not contain the answer, say "I cannot find the answer in the retrieved documents."
Format your response using Markdown. Proactively cite the text snippets by suffixing your statements with their corresponding citation numbers, e.g., "The project uses Next.js [1] and sentence-transformers [2]."

Retrieved Context Snippets:
${contextText}`;

    const userPrompt = `Question: ${query}`;

    let answer = "";
    let providerUsed = "";

    if (geminiKey) {
      providerUsed = "Gemini";
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: `${systemPrompt}\n\n${userPrompt}`
                    }
                  ]
                }
              ]
            })
          }
        );

        if (res.ok) {
          const data = await res.json();
          answer = data.candidates?.[0]?.content?.parts?.[0]?.text || "No response generated.";
        } else {
          const errText = await res.text();
          throw new Error(`Gemini API error: ${errText}`);
        }
      } catch (err: any) {
        console.error("Gemini call failed:", err);
        answer = `Failed to generate answer using Gemini: ${err.message}`;
      }
    } else if (openaiKey) {
      providerUsed = "OpenAI";
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openaiKey}`
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            temperature: 0.2
          })
        });

        if (res.ok) {
          const data = await res.json();
          answer = data.choices?.[0]?.message?.content || "No response generated.";
        } else {
          const errText = await res.text();
          throw new Error(`OpenAI API error: ${errText}`);
        }
      } catch (err: any) {
        console.error("OpenAI call failed:", err);
        answer = `Failed to generate answer using OpenAI: ${err.message}`;
      }
    } else {
      answer = `Chunks retrieved successfully, but no LLM keys (GEMINI_API_KEY or OPENAI_API_KEY) found in your .env.local file. To enable full conversational answers, please add a key and restart the Next.js server.`;
      providerUsed = "None";
    }

    return NextResponse.json({
      success: true,
      answer,
      chunks,
      provider: providerUsed
    });

  } catch (error: any) {
    console.error("RAG Chat API error:", error);
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
