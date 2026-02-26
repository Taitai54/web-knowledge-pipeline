
"use client";

import { Check, ExternalLink } from "lucide-react";
import clsx from "clsx";

interface ResultCardProps {
  title: string;
  url: string;
  snippet: string;
  date?: string;
  isSelected: boolean;
  onSelect: (url: string) => void;
  status?: "scraped" | "pending" | "processing" | "error";
}

export function ResultCard({
  title,
  url,
  snippet,
  date,
  isSelected,
  onSelect,
  status = "pending",
}: ResultCardProps) {
  return (
    <div
      className={clsx(
        "relative group flex flex-col p-8 rounded-2xl border transition-all duration-300",
        isSelected 
          ? "bg-zinc-800/60 border-purple-500/60 shadow-[0_0_20px_-3px_rgba(168,85,247,0.4)]"
          : "bg-zinc-900/40 border-zinc-800 hover:border-zinc-700 hover:bg-zinc-900/80 hover:shadow-lg"
      )}
    >
      <div className="absolute top-4 right-4 z-10">
        <button
          onClick={() => onSelect(url)}
          className={clsx(
            "w-6 h-6 rounded-full border flex items-center justify-center transition-all",
            isSelected
              ? "bg-purple-600 border-purple-600 scale-110"
              : "border-zinc-600 hover:border-white group-hover:bg-zinc-800"
          )}
        >
          {isSelected && <Check className="w-4 h-4 text-white" />}
        </button>
      </div>

      <div className="flex-1 space-y-4">
        <h3 className="text-xl font-semibold text-white line-clamp-2 leading-snug">
          {title}
        </h3>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-zinc-500 hover:text-purple-400 truncate flex items-center gap-1 w-fit transition-colors"
        >
          {new URL(url).hostname}
          <ExternalLink className="w-3 h-3" />
        </a>
        
        {date && (
          <span className="inline-block px-2 py-0.5 mt-2 bg-zinc-800/80 text-zinc-400 rounded text-xs font-medium border border-zinc-700/50">
            {new Date(date).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
          </span>
        )}
        
        <p className="text-base text-zinc-300 line-clamp-4 leading-relaxed">
          {snippet}
        </p>
      </div>

      <div className="mt-6 pt-4 border-t border-zinc-800 flex justify-between items-center">
        <span className={clsx(
            "text-xs px-2 py-1 rounded-full font-medium",
            status === 'scraped' ? "bg-green-900/30 text-green-400" :
            status === 'processing' ? "bg-yellow-900/30 text-yellow-400 animate-pulse" :
            status === 'error' ? "bg-red-900/40 text-red-400" :
            isSelected ? "text-purple-300" : "text-zinc-500"
        )}>
          {status === 'scraped' ? 'Scraped' : status === 'processing' ? 'Processing...' : status === 'error' ? 'Scrape Failed' : isSelected ? 'Ready to Scrap' : 'Reviewing'}
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onSelect(url); }}
          className={clsx(
            "text-sm font-semibold px-4 py-2 rounded-lg transition-all",
            isSelected
              ? "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
              : "bg-purple-600 text-white hover:bg-purple-500 shadow-lg shadow-purple-500/20"
          )}
        >
          {isSelected ? "Deselect" : "Select for Markdown"}
        </button>
      </div>
    </div>
  );
}
