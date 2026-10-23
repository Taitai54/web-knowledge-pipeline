"use client";

import { useState } from "react";
import { Rss, Map } from "lucide-react";
import clsx from "clsx";
import toast from "react-hot-toast";

interface DiscoverPanelProps {
  onAdd: (items: { url: string; title: string; content: string; date?: string }[]) => void;
}

type DiscoverMode = "sitemap" | "feed";

export function DiscoverPanel({ onAdd }: DiscoverPanelProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<DiscoverMode>("sitemap");
  const [url, setUrl] = useState("");
  const [pathPrefix, setPathPrefix] = useState("");
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(false);

  const handleDiscover = async () => {
    if (!url.trim() || loading) return;
    setLoading(true);
    try {
      const response = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: mode,
          url: url.trim(),
          pathPrefix: mode === "sitemap" ? pathPrefix.trim() : "",
          limit,
        }),
      });
      const data = await response.json();
      if (!data.success) {
        toast.error(data.error || "Discovery failed");
        return;
      }
      const results = (data.data?.results || []) as {
        url: string;
        title: string;
        snippet?: string;
        date?: string;
      }[];
      onAdd(
        results.map((item) => ({
          url: item.url,
          title: item.title,
          content: item.snippet || (mode === "sitemap" ? "From sitemap" : "From feed"),
          date: item.date,
        })),
      );
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Discovery failed");
    } finally {
      setLoading(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm px-3 py-2 rounded-lg border border-zinc-700 text-zinc-400 hover:text-white hover:border-zinc-500 transition-colors flex items-center gap-2"
      >
        <Map className="w-4 h-4" />
        Sitemap or RSS
      </button>
    );
  }

  return (
    <div className="w-full max-w-3xl glass-panel p-4 rounded-xl space-y-3">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode("sitemap")}
          className={clsx(
            "px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5",
            mode === "sitemap" ? "bg-purple-600 text-white" : "bg-zinc-800 text-zinc-400",
          )}
        >
          <Map className="w-3.5 h-3.5" />
          Sitemap
        </button>
        <button
          type="button"
          onClick={() => setMode("feed")}
          className={clsx(
            "px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5",
            mode === "feed" ? "bg-purple-600 text-white" : "bg-zinc-800 text-zinc-400",
          )}
        >
          <Rss className="w-3.5 h-3.5" />
          RSS or OPML
        </button>
      </div>

      <input
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        placeholder={mode === "sitemap" ? "https://example.com or a sitemap.xml URL" : "https://example.com/feed.xml or an OPML URL"}
        className="w-full bg-zinc-900/80 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
      />

      <div className="flex flex-wrap gap-2">
        {mode === "sitemap" && (
          <input
            value={pathPrefix}
            onChange={(event) => setPathPrefix(event.target.value)}
            placeholder="Optional path, e.g. /docs"
            className="flex-1 min-w-[180px] bg-zinc-900/80 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
          />
        )}
        <label className="text-xs text-zinc-500 flex items-center gap-2">
          Max
          <input
            type="number"
            min={1}
            max={200}
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="w-20 bg-zinc-900/80 border border-zinc-700 rounded-lg px-2 py-2 text-sm text-zinc-200"
          />
        </label>
      </div>

      <p className="text-xs text-zinc-500">
        {mode === "sitemap"
          ? "Lists pages from the site sitemap. A path keeps only that section. Select them, then scrape."
          : "Imports article links from an RSS, Atom, or OPML file."}
      </p>

      <div className="flex gap-2 justify-end">
        <button type="button" onClick={() => setOpen(false)} className="px-3 py-2 text-sm text-zinc-400 hover:text-white">
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleDiscover()}
          disabled={!url.trim() || loading}
          className="px-3 py-2 text-sm rounded-lg bg-purple-600 text-white disabled:opacity-40"
        >
          {loading ? "Looking up…" : "Add to list"}
        </button>
      </div>
    </div>
  );
}
