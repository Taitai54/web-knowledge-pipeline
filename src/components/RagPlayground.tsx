"use client";

import { useState, useRef, useEffect } from "react";
import { MessageSquare, Send, Brain, Loader2, Sparkles, FileText, ExternalLink, HelpCircle, CornerDownRight } from "lucide-react";
import clsx from "clsx";
import toast from "react-hot-toast";

interface Chunk {
  id: string;
  score: number;
  title: string;
  source: string;
  text: string;
  docType?: string;
  section?: string;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  chunks?: Chunk[];
  provider?: string;
  error?: boolean;
}

interface RagPlaygroundProps {
  defaultNamespace: string;
}

export function RagPlayground({ defaultNamespace }: RagPlaygroundProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [namespace, setNamespace] = useState(defaultNamespace || "general");
  const [isLoading, setIsLoading] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (defaultNamespace) {
      setNamespace(defaultNamespace);
    }
  }, [defaultNamespace]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading]);

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userQuery = input.trim();
    setInput("");
    setIsLoading(true);

    const userMessage: Message = {
      id: Math.random().toString(36).substring(7),
      role: "user",
      content: userQuery,
    };

    setMessages((prev) => [...prev, userMessage]);

    try {
      const res = await fetch("/api/rag/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: userQuery, namespace }),
      });

      const data = await res.json();

      const assistantMessage: Message = {
        id: Math.random().toString(36).substring(7),
        role: "assistant",
        content: data.answer || data.error || "No response received.",
        chunks: data.chunks || [],
        provider: data.provider,
        error: !data.success,
      };

      setMessages((prev) => [...prev, assistantMessage]);
      
      if (data.success && data.chunks && data.chunks.length > 0) {
        setSelectedMessageId(assistantMessage.id);
      }
      
      if (!data.success) {
        toast.error(data.error || "RAG query failed");
      }
    } catch (err) {
      console.error(err);
      const errorMessage: Message = {
        id: Math.random().toString(36).substring(7),
        role: "assistant",
        content: "Network error: Failed to connect to RAG endpoint.",
        error: true,
      };
      setMessages((prev) => [...prev, errorMessage]);
      toast.error("Failed to connect to server");
    } finally {
      setIsLoading(false);
    }
  };

  // Find the sources for the currently selected message
  const activeMessage = messages.find((m) => m.id === selectedMessageId);
  const activeChunks = activeMessage?.chunks || [];

  // Parse text to highlight citation numbers e.g. [1], [2]
  const renderMessageContent = (text: string) => {
    const citationRegex = /\[Citation (\d+)\]|\[(\d+)\]/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = citationRegex.exec(text)) !== null) {
      const matchIndex = match.index;
      const citationNum = match[1] || match[2];

      // Add text before match
      if (matchIndex > lastIndex) {
        parts.push(text.substring(lastIndex, matchIndex));
      }

      // Add citation link/badge
      parts.push(
        <span
          key={`cite-${matchIndex}`}
          className="inline-flex items-center justify-center px-1.5 py-0.5 mx-0.5 text-[10px] font-bold rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/40 cursor-pointer hover:bg-purple-500 hover:text-white transition-all transform hover:scale-105"
          onClick={() => {
            // Trigger scrolling or highlights
            const element = document.getElementById(`chunk-${citationNum}`);
            if (element) {
              element.scrollIntoView({ behavior: "smooth", block: "center" });
              element.classList.add("ring-2", "ring-purple-500", "scale-[1.01]");
              setTimeout(() => {
                element.classList.remove("ring-2", "ring-purple-500", "scale-[1.01]");
              }, 2000);
            }
          }}
          title={`Go to source [${citationNum}]`}
        >
          {citationNum}
        </span>
      );

      lastIndex = citationRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return (
      <div className="space-y-2 whitespace-pre-wrap leading-relaxed text-sm text-zinc-200">
        {parts.length > 0 ? parts : text}
      </div>
    );
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-10 gap-6 h-[70vh] items-stretch animate-fade-in">
      {/* Left Chat Window (6 Columns) */}
      <div className="lg:col-span-6 flex flex-col glass-panel rounded-2xl border border-purple-500/20 overflow-hidden shadow-2xl bg-zinc-900/40">
        {/* Chat Header */}
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between bg-zinc-950/40">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-purple-600/20 border border-purple-500/30 flex items-center justify-center">
              <Brain className="w-4 h-4 text-purple-400" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-100 flex items-center gap-1.5">
                RAG QA Playground
                <Sparkles className="w-3.5 h-3.5 text-purple-400 animate-pulse" />
              </h3>
              <p className="text-[10px] text-zinc-500 font-mono">Index: peace</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400">Namespace:</span>
            <input
              type="text"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-md px-2.5 py-1 focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono w-28 md:w-36"
              placeholder="Namespace"
            />
          </div>
        </div>

        {/* Message Thread */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 min-h-[350px]">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 space-y-4">
              <div className="w-12 h-12 rounded-full bg-zinc-800/80 border border-zinc-700 flex items-center justify-center text-zinc-400">
                <MessageSquare className="w-6 h-6" />
              </div>
              <div className="space-y-1.5 max-w-sm">
                <h4 className="text-sm font-medium text-zinc-200">Start a conversation</h4>
                <p className="text-xs text-zinc-500">
                  Ask a question about documents saved under the <span className="font-mono text-zinc-400">"{namespace}"</span> namespace in your Pinecone index.
                </p>
              </div>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-md w-full pt-4">
                <button
                  type="button"
                  onClick={() => setInput("What are the key concepts explained in these documents?")}
                  className="p-3 text-left bg-zinc-900/80 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50 rounded-xl text-xs text-zinc-400 hover:text-zinc-200 transition-all flex gap-2 items-start"
                >
                  <HelpCircle className="w-3.5 h-3.5 shrink-0 text-purple-400/80 mt-0.5" />
                  <span>Summarize key concepts</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInput("Find any recent technical recommendations or warnings mentioned.")}
                  className="p-3 text-left bg-zinc-900/80 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/50 rounded-xl text-xs text-zinc-400 hover:text-zinc-200 transition-all flex gap-2 items-start"
                >
                  <HelpCircle className="w-3.5 h-3.5 shrink-0 text-purple-400/80 mt-0.5" />
                  <span>Find technical recommendations</span>
                </button>
              </div>
            </div>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                onClick={() => m.role === "assistant" && m.chunks && m.chunks.length > 0 && setSelectedMessageId(m.id)}
                className={clsx(
                  "flex flex-col p-4 rounded-xl border transition-all",
                  m.role === "user"
                    ? "bg-purple-950/10 border-purple-500/10 ml-12"
                    : clsx(
                        "border-zinc-800 mr-12 cursor-pointer",
                        selectedMessageId === m.id
                          ? "bg-zinc-800/40 border-purple-500/40 shadow-md shadow-purple-500/5"
                          : "bg-zinc-900/30 hover:bg-zinc-800/20"
                      )
                )}
              >
                <div className="flex items-center gap-2 mb-2 justify-between">
                  <span
                    className={clsx(
                      "text-[10px] font-bold uppercase tracking-wider",
                      m.role === "user" ? "text-purple-400" : "text-emerald-400"
                    )}
                  >
                    {m.role === "user" ? "You" : "Assistant"}
                  </span>
                  
                  {m.role === "assistant" && (
                    <div className="flex items-center gap-1.5">
                      {m.provider && m.provider !== "None" && (
                        <span className="text-[9px] px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded-md border border-zinc-700">
                          {m.provider}
                        </span>
                      )}
                      {m.chunks && m.chunks.length > 0 && (
                        <span className={clsx(
                          "text-[9px] px-1.5 py-0.5 rounded-md",
                          selectedMessageId === m.id 
                            ? "bg-purple-500/20 text-purple-300 font-semibold" 
                            : "bg-zinc-800 text-zinc-500"
                        )}>
                          {m.chunks.length} Sources
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {renderMessageContent(m.content)}
              </div>
            ))
          )}

          {isLoading && (
            <div className="flex items-center gap-2 p-4 bg-zinc-900/30 border border-zinc-800/50 rounded-xl mr-12 animate-pulse">
              <Loader2 className="w-4 h-4 animate-spin text-purple-500" />
              <span className="text-xs text-zinc-400 font-light">Retrieving vectors & generating answer…</span>
            </div>
          )}
          
          <div ref={messagesEndRef} />
        </div>

        {/* Input Tray */}
        <form onSubmit={handleSend} className="p-4 border-t border-zinc-800 bg-zinc-950/30">
          <div className="relative flex items-center bg-zinc-900 rounded-xl border border-zinc-800 px-3 focus-within:ring-1 focus-within:ring-purple-500 focus-within:border-purple-500 transition-all shadow-inner">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask your knowledge base... (e.g. How does this crawler handle retry delays?)"
              className="w-full bg-transparent border-0 text-sm text-zinc-100 placeholder-zinc-500 py-3.5 focus:outline-none focus:ring-0"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading}
              className="p-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-30 disabled:bg-transparent disabled:text-zinc-600 text-white rounded-lg transition-all flex items-center justify-center shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </form>
      </div>

      {/* Right Source Inspector (4 Columns) */}
      <div className="lg:col-span-4 flex flex-col glass-panel rounded-2xl border border-zinc-800 bg-zinc-900/20 overflow-hidden shadow-2xl">
        <div className="px-5 py-4 border-b border-zinc-800 bg-zinc-950/40">
          <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
            <FileText className="w-4 h-4 text-purple-400" />
            Sources & References
          </h3>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[250px]">
          {activeChunks.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 text-zinc-500 space-y-2">
              <FileText className="w-8 h-8 opacity-20" />
              <p className="text-xs">No active message selected.</p>
              <p className="text-[10px] text-zinc-600 max-w-[200px]">
                Click on any assistant message in the chat to view its source documents here.
              </p>
            </div>
          ) : (
            activeChunks.map((chunk, index) => {
              const urlHostname = chunk.source.startsWith("http") 
                ? new URL(chunk.source).hostname 
                : null;

              return (
                <div
                  key={chunk.id}
                  id={`chunk-${index + 1}`}
                  className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 space-y-3 transition-all duration-300 hover:border-zinc-700"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30 flex items-center justify-center text-[10px] font-bold shrink-0">
                        {index + 1}
                      </span>
                      <h4 className="text-xs font-semibold text-zinc-200 line-clamp-1 truncate max-w-[150px] md:max-w-none" title={chunk.title}>
                        {chunk.title}
                      </h4>
                    </div>

                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-950/40 text-emerald-400 border border-emerald-900/40 font-mono">
                      {(chunk.score * 100).toFixed(0)}% Match
                    </span>
                  </div>

                  <p className="text-xs text-zinc-400 font-mono break-all line-clamp-1" title={chunk.source}>
                    {urlHostname ? (
                      <a
                        href={chunk.source}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline flex items-center gap-1 text-purple-400"
                      >
                        {urlHostname}
                        <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    ) : (
                      chunk.source
                    )}
                  </p>

                  <div className="bg-zinc-950/40 border border-zinc-800/80 rounded-lg p-2.5 text-xs text-zinc-300 font-light max-h-[150px] overflow-y-auto leading-relaxed whitespace-pre-wrap">
                    {chunk.text}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
