"use client";

import clsx from "clsx";
import { Download, FolderOpen, Loader2, RefreshCw } from "lucide-react";
import type { ProviderStatus } from "@/components/ProviderStatusBar";

interface ScrapeToolbarProps {
  category: string;
  onCategoryChange: (v: string) => void;
  resolvedPath: string;
  onProjectDefault: () => void;
  onBrowseFolder: () => void;
  selectedCount: number;
  totalCount: number;
  failedCount: number;
  scrapedCount: number;
  scrapeEngine: string;
  onScrapeEngineChange: (v: string) => void;
  retryEngine: string;
  onRetryEngineChange: (v: string) => void;
  scrapeProviders: ProviderStatus[];
  isScraping: boolean;
  onSelectAll: () => void;
  onSelectFailed: () => void;
  onScrape: () => void;
  onRetryFailed: () => void;
}

function engineLabel(id: string, providers: ProviderStatus[]) {
  const p = providers.find((x) => x.id === id);
  const base = p?.label ?? id;
  if (p?.healthy) return `${base} · live`;
  if (p?.configured && p.healthy === false) return `${base} · offline`;
  return base;
}

export function ScrapeToolbar({
  category,
  onCategoryChange,
  resolvedPath,
  onProjectDefault,
  onBrowseFolder,
  selectedCount,
  totalCount,
  failedCount,
  scrapedCount,
  scrapeEngine,
  onScrapeEngineChange,
  retryEngine,
  onRetryEngineChange,
  scrapeProviders,
  isScraping,
  onSelectAll,
  onSelectFailed,
  onScrape,
  onRetryFailed,
}: ScrapeToolbarProps) {
  const configuredEngines = scrapeProviders.filter((p) => p.configured);
  const canRetry = failedCount > 0 && !isScraping;

  return (
    <section className="glass-panel rounded-2xl p-5 md:p-6 space-y-5 border border-purple-500/20">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-purple-400">Step 3</p>
          <h2 className="text-lg font-semibold text-zinc-100">Scrape selected pages</h2>
          <p className="text-sm text-zinc-500 mt-1 max-w-xl">
            One scrape engine per run. Already-scraped items in your selection are skipped unless they
            failed.
          </p>
        </div>
        <div className="text-right text-sm text-zinc-400">
          <span className="text-zinc-200 font-medium">{selectedCount}</span> selected ·{" "}
          <span className="text-emerald-400">{scrapedCount}</span> saved ·{" "}
          <span className={failedCount ? "text-red-400" : "text-zinc-500"}>{failedCount}</span> failed
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSelectAll}
          className="px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm font-medium border border-zinc-700"
        >
          {selectedCount === totalCount ? "Deselect all" : "Select all"}
        </button>
        {failedCount > 0 && (
          <button
            type="button"
            onClick={onSelectFailed}
            className="px-3 py-2 bg-red-950/40 hover:bg-red-950/60 text-red-300 rounded-lg text-sm font-medium border border-red-800/50"
          >
            Select {failedCount} failed
          </button>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <label className="text-xs font-medium text-zinc-400">Save folder / category</label>
          <div className="flex flex-wrap gap-2 mb-2">
            <button
              type="button"
              onClick={onProjectDefault}
              className="text-xs px-2 py-1 rounded-md bg-purple-500/20 text-purple-300 border border-purple-500/30 hover:bg-purple-500/30"
            >
              Project default
            </button>
            <button
              type="button"
              onClick={onBrowseFolder}
              className="text-xs px-2 py-1 rounded-md bg-blue-500/20 text-blue-300 border border-blue-500/30 hover:bg-blue-500/30"
            >
              Browse folder…
            </button>
          </div>
          <div className="flex items-center gap-2 bg-zinc-900/60 rounded-lg border border-zinc-800 px-3 py-2">
            <FolderOpen className="w-4 h-4 text-purple-400 shrink-0" />
            <input
              type="text"
              value={category}
              onChange={(e) => onCategoryChange(e.target.value)}
              className="bg-transparent flex-1 text-sm text-zinc-200 focus:outline-none placeholder-zinc-600"
              placeholder="e.g. research"
            />
          </div>
          {resolvedPath && (
            <p className="text-[10px] text-zinc-500 truncate" title={resolvedPath}>
              → {resolvedPath}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="scrape-engine" className="text-xs font-medium text-zinc-400">
            Scrape engine (this run)
          </label>
          <select
            id="scrape-engine"
            value={scrapeEngine}
            onChange={(e) => onScrapeEngineChange(e.target.value)}
            disabled={isScraping}
            className="w-full bg-zinc-900 border border-zinc-700 text-zinc-200 text-sm rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-purple-500"
          >
            {configuredEngines.map((p) => (
              <option key={p.id} value={p.id}>
                {engineLabel(p.id, scrapeProviders)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-3">
        <button
          type="button"
          onClick={onScrape}
          disabled={selectedCount === 0 || isScraping}
          className={clsx(
            "btn-primary flex-1 flex items-center justify-center gap-2 py-3",
            (selectedCount === 0 || isScraping) && "opacity-50 cursor-not-allowed",
          )}
        >
          {isScraping ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Scraping…
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              Scrape selected to knowledge base
            </>
          )}
        </button>
      </div>

      {failedCount > 0 && (
        <div className="rounded-xl border border-amber-800/40 bg-amber-950/20 p-4 space-y-3">
          <p className="text-sm text-amber-100/90">
            Some pages failed with the current engine. Select failed items (or use the button above), pick
            another engine, and retry — only failed URLs are re-fetched.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
            <div className="flex-1 space-y-2">
              <label htmlFor="retry-engine" className="text-xs font-medium text-amber-200/80">
                Retry failed with
              </label>
              <select
                id="retry-engine"
                value={retryEngine}
                onChange={(e) => onRetryEngineChange(e.target.value)}
                disabled={isScraping}
                className="w-full bg-zinc-900 border border-amber-800/50 text-zinc-200 text-sm rounded-lg px-3 py-2.5 focus:outline-none focus:ring-1 focus:ring-amber-500"
              >
                {configuredEngines.map((p) => (
                  <option key={p.id} value={p.id}>
                    {engineLabel(p.id, scrapeProviders)}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={onRetryFailed}
              disabled={!canRetry}
              className={clsx(
                "px-5 py-2.5 rounded-lg font-semibold text-sm flex items-center justify-center gap-2 border",
                canRetry
                  ? "bg-amber-600 hover:bg-amber-500 text-white border-amber-500"
                  : "bg-zinc-800 text-zinc-500 border-zinc-700 cursor-not-allowed",
              )}
            >
              <RefreshCw className="w-4 h-4" />
              Retry {failedCount} failed
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
