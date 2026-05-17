"use client";

import clsx from "clsx";
import { Search, MousePointerClick, Download } from "lucide-react";

export type PipelineStep = 1 | 2 | 3;

interface PipelineGuideProps {
  activeStep: PipelineStep;
  hasResults: boolean;
  selectedCount: number;
  failedCount: number;
}

const steps = [
  {
    n: 1 as const,
    icon: Search,
    title: "Find sources",
    detail:
      "Pick one search engine (Exa or Tavily for quality, SearXNG for free discovery) or paste URLs.",
  },
  {
    n: 2 as const,
    icon: MousePointerClick,
    title: "Select pages",
    detail: "Click cards to select multiple URLs. Use Select All if you want the full list.",
  },
  {
    n: 3 as const,
    icon: Download,
    title: "Scrape to Markdown",
    detail: "Pick one scrape engine per run. Retry failures with a different engine if needed.",
  },
];

export function PipelineGuide({
  activeStep,
  hasResults,
  selectedCount,
  failedCount,
}: PipelineGuideProps) {
  return (
    <div className="w-full max-w-4xl mx-auto glass-panel rounded-2xl p-5 md:p-6 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-200">How this works</h2>
        <p className="text-xs text-zinc-500">
          Search and scrape use <span className="text-zinc-400">one provider each per step</span> — not
          multiple at once.
        </p>
      </div>

      <ol className="grid gap-3 md:grid-cols-3">
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
                    <p className="text-xs text-purple-300/90">
                      {selectedCount} of your results selected
                    </p>
                  )}
                  {n === 3 && failedCount > 0 && (
                    <p className="text-xs text-amber-400">{failedCount} failed — try another engine below</p>
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
