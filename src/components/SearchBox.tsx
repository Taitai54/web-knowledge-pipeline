"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import clsx from "clsx";
import type { ProviderStatus } from "@/components/ProviderStatusBar";

interface SearchBoxProps {
  onSearch: (query: string, provider: string, timeRange: string) => Promise<void>;
  isLoading: boolean;
  provider: string;
  setProvider: (p: string) => void;
  searchProviders?: ProviderStatus[];
}

export function SearchBox({
  onSearch,
  isLoading,
  provider,
  setProvider,
  searchProviders,
}: SearchBoxProps) {
  const [query, setQuery] = useState("");
  const [timeRange, setTimeRange] = useState("any");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query, provider, timeRange);
    }
  };

  const showTimeRange = provider === "tavily" || provider === "exa";

  const providerButton = (id: string, label: string, activeClass: string) => {
    const info = searchProviders?.find((p) => p.id === id);
    const configured = info?.configured ?? true;
    const live = info?.healthy === true;
    const offline = info?.configured && info?.healthy === false;

    return (
      <button
        key={id}
        type="button"
        disabled={!configured}
        onClick={() => configured && setProvider(id)}
        title={
          !configured
            ? `${label}: add env vars to .env.local and restart dev server`
            : offline
              ? `${label}: Docker service not reachable`
              : live
                ? `${label}: online`
                : label
        }
        className={clsx(
          "px-4 py-2 rounded-md text-sm font-bold transition-all relative",
          provider === id && configured ? activeClass : "text-zinc-400",
          configured ? "hover:text-white" : "opacity-40 cursor-not-allowed",
        )}
      >
        {label}
        {live && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-emerald-500 rounded-full" />
        )}
        {offline && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-amber-500 rounded-full" />
        )}
      </button>
    );
  };

  return (
    <section className="w-full max-w-3xl mx-auto space-y-3">
      <div className="flex items-baseline justify-between gap-2 px-1">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-purple-400">Step 1</p>
          <h2 className="text-lg font-semibold text-zinc-100">Find sources on the web</h2>
        </div>
        <p className="text-xs text-zinc-500 max-w-[200px] text-right">
          Choose <span className="text-zinc-400">one</span> search provider, then submit
        </p>
      </div>
    <form onSubmit={handleSubmit} className="relative">
      <div className="relative group">
        <div className="absolute -inset-1 bg-linear-to-r from-pink-600 via-purple-600 to-indigo-600 rounded-lg blur opacity-40 group-hover:opacity-100 transition duration-1000 group-hover:duration-200" />
        <div className="relative flex flex-col md:flex-row items-stretch bg-zinc-900 rounded-lg ring-1 ring-zinc-800 shadow-2xl overflow-hidden">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the web (e.g., latest Next.js 15 features...)"
            className="w-full flex-1 pl-5 pr-4 py-4 md:py-5 bg-zinc-900/80 text-zinc-100 placeholder-zinc-500 text-lg transition-all focus:outline-none focus:ring-2 focus:ring-purple-500/50"
            disabled={isLoading}
          />

          <div className="flex flex-wrap bg-zinc-800/50 p-2 m-2 rounded-lg border border-zinc-700 items-center gap-2 md:gap-4">
            <div className="flex items-center flex-wrap gap-1">
              {providerButton("searxng", "SearXNG", "bg-emerald-600 text-white")}
              {providerButton("brave", "Brave", "bg-orange-600 text-white")}
              {providerButton("exa", "Exa", "bg-cyan-600 text-white")}
              {providerButton("tavily", "Tavily", "bg-blue-600 text-white")}
              {providerButton("firecrawl", "Firecrawl", "bg-purple-600 text-white")}
            </div>

            {showTimeRange && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-zinc-500 font-medium">Time:</span>
                <select
                  value={timeRange}
                  onChange={(e) => setTimeRange(e.target.value)}
                  className="bg-zinc-900 border border-zinc-700 text-zinc-300 text-sm rounded-md px-2 py-1 focus:outline-none focus:ring-1 focus:ring-purple-500"
                >
                  <option value="any">Any time</option>
                  <option value="day">Past 24 hours</option>
                  <option value="week">Past week</option>
                  <option value="month">Past month</option>
                  <option value="year">Past year</option>
                </select>
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="p-4 md:p-5 hover:bg-zinc-800 transition-colors disabled:opacity-50 border-t md:border-t-0 md:border-l border-zinc-800 flex items-center justify-center"
          >
            {isLoading ? (
              <div className="w-7 h-7 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            ) : (
              <Search className="w-7 h-7 text-zinc-400 group-hover:text-white transition-colors" />
            )}
          </button>
        </div>
      </div>
    </form>
    </section>
  );
}
