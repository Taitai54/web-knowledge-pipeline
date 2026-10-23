"use client";

import { useEffect, useState } from "react";
import { Settings2 } from "lucide-react";
import toast from "react-hot-toast";
import type { LlmProviderId, LlmPublicStatus } from "@/lib/rag/llm";

interface LlmSettingsBarProps {
  onChange: (selection: { provider: LlmProviderId; model: string }) => void;
}

export function LlmSettingsBar({ onChange }: LlmSettingsBarProps) {
  const [status, setStatus] = useState<LlmPublicStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [openaiKey, setOpenaiKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("");
  const [lmStudioUrl, setLmStudioUrl] = useState("");

  const apply = (next: LlmPublicStatus) => {
    setStatus(next);
    setOllamaUrl(next.ollamaUrl);
    setLmStudioUrl(next.lmStudioUrl);
    onChange({ provider: next.provider, model: next.model });
  };

  useEffect(() => {
    let cancel = false;
    fetch("/api/rag/llm")
      .then((res) => res.json())
      .then((data) => {
        if (!cancel && data.success) apply(data);
      })
      .catch(() => {
        if (!cancel) toast.error("Could not load model settings");
      });
    return () => {
      cancel = true;
    };
    // Load once. Later updates come from save().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (patch: Record<string, unknown>) => {
    const res = await fetch("/api/rag/llm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!data.success) {
      toast.error(data.error || "Could not save model settings");
      return false;
    }
    apply(data);
    return true;
  };

  if (!status) {
    return (
      <div className="px-5 py-2 border-b border-zinc-800 text-[11px] text-zinc-500">Loading models…</div>
    );
  }

  const current = status.providers.find((item) => item.id === status.provider);
  const models = current?.models || [];

  return (
    <div className="border-b border-zinc-800 bg-zinc-950/20">
      <div className="px-5 py-2 flex flex-wrap items-center gap-2">
        <label className="text-[11px] text-zinc-500" htmlFor="llm-provider">
          Model
        </label>
        <select
          id="llm-provider"
          value={status.provider}
          onChange={(event) => {
            const provider = event.target.value as LlmProviderId;
            const nextModels = status.providers.find((item) => item.id === provider)?.models || [];
            const model = nextModels.includes(status.model) ? status.model : nextModels[0] || "";
            void save({ provider, model });
          }}
          className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-md px-2 py-1"
        >
          {status.providers.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
              {item.ready ? "" : " (unavailable)"}
            </option>
          ))}
        </select>
        {models.length > 0 ? (
          <select
            aria-label="Chat model"
            value={models.includes(status.model) ? status.model : models[0]}
            onChange={(event) => void save({ provider: status.provider, model: event.target.value })}
            className="bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs rounded-md px-2 py-1 max-w-[220px]"
          >
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-[11px] text-amber-300/90">{current?.detail}</span>
        )}
        <span className="text-[10px] text-zinc-500">{current?.detail}</span>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="ml-auto inline-flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200"
        >
          <Settings2 className="w-3.5 h-3.5" />
          {open ? "Hide keys" : "Keys and servers"}
        </button>
      </div>

      {open && (
        <div className="px-5 pb-3 grid gap-2 sm:grid-cols-2">
          <label className="text-[11px] text-zinc-500 flex flex-col gap-1">
            Ollama URL
            <input
              value={ollamaUrl}
              onChange={(event) => setOllamaUrl(event.target.value)}
              onBlur={() => {
                if (ollamaUrl !== status.ollamaUrl) void save({ ollamaUrl });
              }}
              className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 font-mono"
            />
          </label>
          <label className="text-[11px] text-zinc-500 flex flex-col gap-1">
            LM Studio URL
            <input
              value={lmStudioUrl}
              onChange={(event) => setLmStudioUrl(event.target.value)}
              onBlur={() => {
                if (lmStudioUrl !== status.lmStudioUrl) void save({ lmStudioUrl });
              }}
              className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200 font-mono"
            />
          </label>
          <label className="text-[11px] text-zinc-500 flex flex-col gap-1">
            OpenAI key
            <span className="flex gap-1">
              <input
                type="password"
                value={openaiKey}
                onChange={(event) => setOpenaiKey(event.target.value)}
                placeholder={status.providers.find((item) => item.id === "openai")?.detail}
                autoComplete="off"
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200"
              />
              <button
                type="button"
                onClick={() => {
                  if (!openaiKey.trim()) return;
                  void save({ openaiKey }).then((saved) => {
                    if (saved) setOpenaiKey("");
                  });
                }}
                className="px-2 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-200 text-[11px]"
              >
                Save
              </button>
            </span>
          </label>
          <label className="text-[11px] text-zinc-500 flex flex-col gap-1">
            Gemini key
            <span className="flex gap-1">
              <input
                type="password"
                value={geminiKey}
                onChange={(event) => setGeminiKey(event.target.value)}
                placeholder={status.providers.find((item) => item.id === "gemini")?.detail}
                autoComplete="off"
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-200"
              />
              <button
                type="button"
                onClick={() => {
                  if (!geminiKey.trim()) return;
                  void save({ geminiKey }).then((saved) => {
                    if (saved) setGeminiKey("");
                  });
                }}
                className="px-2 rounded-md bg-zinc-800 border border-zinc-700 text-zinc-200 text-[11px]"
              >
                Save
              </button>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
