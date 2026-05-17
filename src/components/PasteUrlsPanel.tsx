"use client";

import { useState } from "react";
import { Link2 } from "lucide-react";

interface PasteUrlsPanelProps {
  onAdd: (items: { url: string; title: string; content: string }[]) => void;
}

function titleFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const slug = u.pathname.split("/").filter(Boolean).pop() || u.hostname;
    return slug.replace(/[-_]/g, " ");
  } catch {
    return url;
  }
}

export function PasteUrlsPanel({ onAdd }: PasteUrlsPanelProps) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);

  const handleAdd = () => {
    const lines = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("http://") || l.startsWith("https://"));

    if (lines.length === 0) return;

    const seen = new Set<string>();
    const items = lines
      .filter((url) => {
        if (seen.has(url)) return false;
        seen.add(url);
        return true;
      })
      .map((url) => ({
        url,
        title: titleFromUrl(url),
        content: "Pasted URL — no search snippet",
      }));

    onAdd(items);
    setText("");
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm px-3 py-2 rounded-lg border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors flex items-center gap-2 mx-auto"
      >
        <Link2 className="w-4 h-4" />
        Paste URLs (no search API)
      </button>
    );
  }

  return (
    <div className="w-full max-w-3xl mx-auto glass-panel p-4 rounded-xl space-y-3">
      <p className="text-sm text-zinc-400">One URL per line. These are added to your result list for scraping.</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={"https://example.com/article-1\nhttps://example.com/article-2"}
        rows={4}
        className="w-full bg-zinc-900/80 border border-zinc-700 rounded-lg p-3 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-purple-500 font-mono"
      />
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-3 py-2 text-sm text-zinc-400 hover:text-white"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleAdd}
          className="px-4 py-2 text-sm font-semibold bg-purple-600 hover:bg-purple-500 text-white rounded-lg"
        >
          Add to list
        </button>
      </div>
    </div>
  );
}
