"use client";

import clsx from "clsx";
import { Search, MousePointerClick, Download, Database, MessageSquare } from "lucide-react";

export type PipelineStep = 1 | 2 | 3 | 4 | 5;

interface PipelineGuideProps {
  activeStep: PipelineStep;
  hasResults: boolean;
  selectedCount: number;
  failedCount: number;
  scrapedCount: number;
  synced: boolean;
}

const steps = [
  {
    n: 1 as const,
    icon: Search,
    title: "Find sources",
    detail: "Search, paste URLs, or import a sitemap or feed.",
  },
  {
    n: 2 as const,
    icon: MousePointerClick,
    title: "Select pages",
    detail: "Click cards to select the pages to keep.",
  },
  {
    n: 3 as const,
    icon: Download,
    title: "Scrape to Markdown",
    detail: "One scrape engine writes the pages into the category folder.",
  },
  {
    n: 4 as const,
    icon: Database,
    title: "Sync to Pinecone",
    detail: "Upload the folder. The category name becomes the namespace.",
  },
  {
    n: 5 as const,
    icon: MessageSquare,
    title: "Ask in RAG Chat",
    detail: "The startup script loads the search server with the app.",
  },
];

export function PipelineGuide({
  activeStep,
  hasResults,
  selectedCount,
  failedCount,
  scrapedCount,
  synced,
}: PipelineGuideProps) {
  return (
    <div className="w-full glass-panel rounded-2xl p-5 md:p-6 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-200">How this works</h2>
        <p className="text-xs text-zinc-500">One search provider and one scrape engine per run.</p>
      </div>

      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {steps.map(({ n, icon: Icon, title, detail }) => {
          const isActive = activeStep === n;

          return (
            <li
              key={n}
              className={clsx(
                "relative rounded-xl border p-4 transition-all",
                isActive
                  ? "border-purple-500/50 bg-purple-950/30 shadow-[0_0_24px_-8px_rgba(168,85,247,0.5)]"
                  : "border-zinc-800 bg-zinc-900/40",
              )}
            >
              <div className="flex items-start gap-3">
                <span
                  className={clsx(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sm font-bold",
                    isActive ? "bg-purple-600 text-white" : "bg-zinc-800 text-zinc-400",
                  )}
                >
                  {n}
                </span>
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Icon className="w-4 h-4 text-purple-400 shrink-0" />
                    <span className="font-medium text-zinc-100 text-sm">{title}</span>
                  </div>
                  <p className="text-xs text-zinc-500 leading-relaxed">{detail}</p>
                  {n === 2 && hasResults && (
                    <p className="text-xs text-purple-300/90">{selectedCount} selected</p>
                  )}
                  {n === 3 && failedCount > 0 && (
                    <p className="text-xs text-amber-400">{failedCount} failed — retry with another engine</p>
                  )}
                  {n === 4 && scrapedCount > 0 && !synced && (
                    <p className="text-xs text-purple-300/90">{scrapedCount} saved and ready to sync</p>
                  )}
                  {n === 5 && synced && (
                    <p className="text-xs text-purple-300/90">Synced. Open RAG Chat.</p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
