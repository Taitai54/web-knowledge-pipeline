"use client";

import { useState, useRef, useEffect } from "react";
import { MessageSquare, Send, Brain, Loader2, Sparkles, FileText, ExternalLink, HelpCircle, Download } from "lucide-react";
import { LlmSettingsBar } from "@/components/LlmSettingsBar";
import type { LlmProviderId } from "@/lib/rag/llm";
import clsx from "clsx";
import toast from "react-hot-toast";

interface Chunk {
  id: string;
  score: number | null;
  title: string;
  source: string;
  text: string;
  docType?: string;
  section?: string;
  namespace?: string;
  matchedBy?: string[];
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  chunks?: Chunk[];
  provider?: string;
  modelName?: string;
  reranked?: boolean;
  hybrid?: boolean;
  error?: boolean;
}

function chatMarkdown(messages: Message[], index: string, namespaces: string[]): string {
  const lines = [
    "# RAG chat",
    "",
    `- Index: ${index}`,
    `- Namespaces: ${namespaces.join(", ")}`,
    `- Exported: ${new Date().toLocaleString()}`,
    "",
  ];
  let question = 0;
  for (const message of messages) {
    if (message.role === "user") {
      question += 1;
      lines.push(`## ${question}. ${message.content}`, "");
      continue;
    }
    lines.push(message.content.trim(), "");
    if (message.provider && message.provider !== "None") {
      lines.push(`_${message.modelName ? `${message.provider} · ${message.modelName}` : message.provider}_`, "");
    }
    if (message.chunks && message.chunks.length > 0) {
      lines.push("### Sources", "");
      message.chunks.forEach((chunk, i) => {
        const where = [chunk.source, chunk.namespace && `namespace: ${chunk.namespace}`].filter(Boolean).join(" · ");
        lines.push(`${i + 1}. **${chunk.title}**${where ? ` — ${where}` : ""}`, "");
        lines.push(...chunk.text.trim().split("\n").map((line) => `   > ${line}`), "");
      });
    }
  }
  return lines.join("\n");
}

interface NamespaceInfo {
  name: string;
  vectorCount: number;
}

interface IndexInfo {
  name: string;
  dimension: number;
  ready: boolean;
  model: string;
  reason: string;
}

interface RagStatus {
  online: boolean;
  model: string;
  rerank: string;
  index: string;
  error: string;
  namespaces: NamespaceInfo[];
  indexes: IndexInfo[];
}

interface RagPlaygroundProps {
  defaultNamespace: string;
}

export function RagPlayground({ defaultNamespace }: RagPlaygroundProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [namespaces, setNamespaces] = useState<string[]>([defaultNamespace || "general"]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [status, setStatus] = useState<RagStatus>({
    online: false,
    model: "offline",
    rerank: "offline",
    index: "peace",
    error: "",
    namespaces: [],
    indexes: [],
  });
  const [index, setIndex] = useState("");
  const [namespaceNote, setNamespaceNote] = useState("");
  const [llmChoice, setLlmChoice] = useState<{ provider: LlmProviderId; model: string } | null>(null);
  const didAutoPick = useRef(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatReady = status.online && status.model === "ready";

  useEffect(() => {
    if (defaultNamespace) setNamespaces([defaultNamespace]);
  }, [defaultNamespace]);

  useEffect(() => {
    let cancel = false;
    const tick = async () => {
      try {
        const res = await fetch(index ? `/api/rag/status?index=${encodeURIComponent(index)}` : "/api/rag/status");
        const data = await res.json();
        if (!cancel) {
          setStatus({
            online: Boolean(data.online),
            model: data.model || "offline",
            rerank: data.rerank || "offline",
            index: data.index || "peace",
            error: data.error || "",
            namespaces: Array.isArray(data.namespaces) ? data.namespaces : [],
            indexes: Array.isArray(data.indexes) ? data.indexes : [],
          });
        }
      } catch {
        if (!cancel) {
          setStatus((prev) => ({ ...prev, online: false, model: "offline", namespaces: [] }));
        }
      }
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, [index]);

  const changeIndex = (name: string) => {
    setIndex(name);
    setStatus((prev) => ({ ...prev, index: name, model: "loading", error: "", namespaces: [] }));
    setNamespaceNote("");
    didAutoPick.current = false;
  };

  useEffect(() => {
    if (didAutoPick.current || status.namespaces.length === 0) return;
    didAutoPick.current = true;
    const usable = namespaces.filter((name) =>
      status.namespaces.some((ns) => ns.name === name && ns.vectorCount > 0),
    );
    if (usable.length === namespaces.length) return;
    const dropped = namespaces.filter((name) => !usable.includes(name)).join(", ");
    if (usable.length > 0) {
      setNamespaces(usable);
      setNamespaceNote(`${dropped} is empty or not in this index, so it was unticked.`);
      return;
    }
    const best = status.namespaces.find((ns) => ns.vectorCount > 0);
    if (!best) return;
    setNamespaces([best.name]);
    setNamespaceNote(`${dropped} is empty or not in this index. Opened ${best.name} instead.`);
  }, [status.namespaces, namespaces]);

  const toggleNamespace = (name: string) => {
    setNamespaceNote("");
    setNamespaces((prev) =>
      prev.includes(name) ? (prev.length > 1 ? prev.filter((item) => item !== name) : prev) : [...prev, name],
    );
  };

  const namespaceLabel = namespaces.join(", ");

  const downloadChat = () => {
    const blob = new Blob([chatMarkdown(messages, status.index, namespaces)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `rag-chat-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(url);
  };

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
    if (!chatReady) return;
    setInput("");
    setIsLoading(true);

    const history = messages
      .filter((message) => !message.error)
      .map((message) => ({ role: message.role, content: message.content }));

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
        body: JSON.stringify({
          query: userQuery,
          index: status.index,
          namespaces,
          history,
          provider: llmChoice?.provider,
          model: llmChoice?.model,
        }),
      });

      const data = await res.json();

      const assistantMessage: Message = {
        id: Math.random().toString(36).substring(7),
        role: "assistant",
        content: data.answer || data.error || "No response received.",
        chunks: data.chunks || [],
        provider: data.provider,
        modelName: data.model,
        reranked: Boolean(data.reranked),
        hybrid: Boolean(data.hybrid),
        error: !data.success,
      };

      setMessages((prev) => [...prev, assistantMessage]);

      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        toast.error(`Skipped: ${data.warnings.join(", ")}`);
      }
      
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
              <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 font-mono">
                <span>Index:</span>
                {status.indexes.length > 0 ? (
                  <select
                    value={status.index}
                    onChange={(e) => changeIndex(e.target.value)}
                    className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-[11px] rounded-md px-1.5 py-0.5 focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
                  >
                    {status.indexes.map((item) => (
                      <option key={item.name} value={item.name} disabled={!item.model} title={item.reason}>
                        {item.name}
                        {item.model ? "" : " (no local model)"}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span>{status.index || "peace"}</span>
                )}
                <span>
                  {status.model === "ready"
                    ? "· search ready"
                    : status.model === "loading" || status.model === "cold"
                      ? "· loading model"
                      : status.model === "unsupported"
                        ? "· not searchable"
                        : "· search offline"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={downloadChat}
                disabled={messages.length === 0}
                title="Download this chat, answers and sources as one Markdown file"
                className="p-1.5 rounded-md border border-zinc-700 bg-zinc-800 text-zinc-300 hover:text-white hover:border-purple-500 disabled:opacity-30 disabled:hover:border-zinc-700 transition-all"
              >
                <Download className="w-3.5 h-3.5" />
              </button>
              <span className="text-xs text-zinc-400">Namespaces:</span>
              {status.namespaces.length > 0 ? (
                <details className="relative">
                  <summary className="list-none cursor-pointer bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-md px-2.5 py-1 font-mono max-w-[220px] truncate">
                    {namespaces.length > 1 ? `${namespaces[0]} +${namespaces.length - 1}` : namespaces[0]} ▾
                  </summary>
                  <div className="absolute right-0 z-20 mt-1 w-64 max-h-72 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-900 p-1.5 shadow-xl">
                    {status.namespaces.map((ns) => (
                      <label
                        key={ns.name}
                        className={clsx(
                          "flex items-center gap-2 rounded-md px-2 py-1 text-xs font-mono",
                          ns.vectorCount > 0 ? "text-zinc-200 hover:bg-zinc-800 cursor-pointer" : "text-zinc-600",
                        )}
                      >
                        <input
                          type="checkbox"
                          checked={namespaces.includes(ns.name)}
                          disabled={ns.vectorCount === 0}
                          onChange={() => toggleNamespace(ns.name)}
                          className="accent-purple-500"
                        />
                        <span className="truncate">{ns.name}</span>
                        <span className="ml-auto text-zinc-500">{ns.vectorCount.toLocaleString()}</span>
                      </label>
                    ))}
                  </div>
                </details>
              ) : (
                <input
                  type="text"
                  value={namespaceLabel}
                  onChange={(e) => setNamespaces([e.target.value])}
                  className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-md px-2.5 py-1 focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono w-28 md:w-36"
                  placeholder="Namespace"
                />
              )}
            </div>
            {namespaceNote && (
              <p className="text-[10px] text-amber-300/90 max-w-[260px] text-right">{namespaceNote}</p>
            )}
          </div>
        </div>

        <LlmSettingsBar onChange={setLlmChoice} />

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
                  Ask a question about documents saved under <span className="font-mono text-zinc-400">{namespaceLabel}</span> in the <span className="font-mono text-zinc-400">{status.index}</span> index.
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
                          {m.modelName ? `${m.provider} · ${m.modelName}` : m.provider}
                        </span>
                      )}
                      {m.hybrid && (
                        <span className="text-[9px] px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded-md border border-zinc-700">
                          keyword + meaning
                        </span>
                      )}
                      {m.reranked && (
                        <span className="text-[9px] px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded-md border border-zinc-700">
                          reranked
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
              placeholder={
                chatReady
                  ? `Ask ${namespaceLabel}…`
                  : status.model === "loading" || status.model === "cold"
                    ? "Loading the embedding model. Chat opens when it finishes."
                    : status.online && status.error
                      ? status.error
                      : "Search server is offline. Start run-web-knowledge-pipeline.bat."
              }
              className="w-full bg-transparent border-0 text-sm text-zinc-100 placeholder-zinc-500 py-3.5 focus:outline-none focus:ring-0"
              disabled={isLoading || !chatReady}
            />
            <button
              type="submit"
              disabled={!input.trim() || isLoading || !chatReady}
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

                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-950/40 text-emerald-400 border border-emerald-900/40 font-mono shrink-0">
                      {typeof chunk.score === "number" ? `${(chunk.score * 100).toFixed(0)}% Match` : "Keyword match"}
                    </span>
                  </div>

                  {(chunk.namespace || (chunk.matchedBy && chunk.matchedBy.length > 1)) && (
                    <p className="text-[10px] text-zinc-500 font-mono">
                      {[chunk.namespace, chunk.matchedBy && chunk.matchedBy.length > 1 && "found by keyword + meaning"]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}

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
