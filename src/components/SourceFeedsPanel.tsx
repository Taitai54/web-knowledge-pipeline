"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Download, RefreshCw, Rss, X } from "lucide-react";
import toast from "react-hot-toast";

interface SiteSource {
  origin: string;
  title: string;
  feedUrl: string | null;
  category: string;
  included: boolean;
}

export function SourceFeedsPanel() {
  const [feeds, setFeeds] = useState<SiteSource[]>([]);
  const [withoutFeed, setWithoutFeed] = useState(0);
  const [open, setOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await (await fetch("/api/sources")).json();
      if (!data.success) return;
      setFeeds((data.sites as SiteSource[]).filter((site) => site.feedUrl));
      setWithoutFeed(data.withoutFeed);
      setLoaded(true);
    } catch {
      // The list refreshes next time the panel opens.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = () => {
    if (!open) void load();
    setOpen(!open);
  };

  const scan = async () => {
    setScanning(true);
    try {
      const response = await fetch("/api/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scan" }),
      });
      const data = await response.json();
      if (!data.success) {
        toast.error(data.error || "Check failed");
        return;
      }
      if (data.checked === 0) toast.success("All saved sites are already checked");
      else {
        const more = data.remaining > 0 ? ` Run again for ${data.remaining} more.` : "";
        toast.success(`Checked ${data.checked} sites, found ${data.found} feeds, left unticked.${more}`);
      }
      await load();
      setOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Check failed");
    } finally {
      setScanning(false);
    }
  };

  const setIncluded = async (origin: string, included: boolean) => {
    setFeeds((current) => current.map((site) => (site.origin === origin ? { ...site, included } : site)));
    await fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "include", origin, included }),
    });
  };

  const tickedCount = feeds.filter((site) => site.included).length;

  const remove = async (origin: string) => {
    await fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "remove", origin }),
    });
    await load();
  };

  return (
    <section className="glass-panel rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200 flex items-center gap-2">
            <Rss className="w-4 h-4 text-orange-400" />
            Sites to follow
          </h2>
          <p className="text-xs text-zinc-500 mt-1 max-w-xl">
            When you save a page, the app looks for that site&apos;s own RSS feed and ticks it. Untick what you
            don&apos;t want, then download the ticked feeds as an OPML file for your RSS app.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void scan()}
            disabled={scanning}
            className="text-sm px-3 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:text-white hover:border-zinc-500 disabled:opacity-50 flex items-center gap-2"
          >
            <RefreshCw className={scanning ? "w-4 h-4 animate-spin" : "w-4 h-4"} />
            {scanning ? "Checking sites…" : "Check saved pages"}
          </button>
          {tickedCount > 0 ? (
            <a
              href="/api/sources/opml"
              download
              className="text-sm px-3 py-2 rounded-lg bg-purple-600 text-white hover:bg-purple-500 flex items-center gap-2"
            >
              <Download className="w-4 h-4" />
              Download OPML ({tickedCount})
            </a>
          ) : (
            <span className="text-sm px-3 py-2 rounded-lg bg-zinc-800 text-zinc-500 flex items-center gap-2 cursor-not-allowed">
              <Download className="w-4 h-4" />
              Download OPML
            </span>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={toggle}
        className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {!loaded
          ? "Loading…"
          : `${feeds.length} ${feeds.length === 1 ? "feed" : "feeds"} found, ${tickedCount} ticked`}
        {loaded && withoutFeed > 0 && ` · ${withoutFeed} ${withoutFeed === 1 ? "site has" : "sites have"} no feed`}
      </button>

      {open && feeds.length > 0 && (
        <ul className="max-h-72 overflow-y-auto divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {feeds.map((site) => (
            <li key={site.origin} className="flex items-center gap-3 px-3 py-2">
              <input
                type="checkbox"
                checked={site.included}
                onChange={(event) => void setIncluded(site.origin, event.target.checked)}
                aria-label={`Include ${site.title} in OPML`}
                className="w-4 h-4 accent-purple-500 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-zinc-200 truncate">{site.title}</p>
                <p className="text-xs text-zinc-500 font-mono truncate">{site.feedUrl}</p>
              </div>
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 shrink-0">
                {site.category}
              </span>
              <button
                type="button"
                onClick={() => void remove(site.origin)}
                title="Remove from the list"
                className="text-zinc-500 hover:text-red-400 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
