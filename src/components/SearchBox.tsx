
"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import clsx from "clsx";

interface SearchBoxProps {
  onSearch: (query: string, provider: string, timeRange: string) => Promise<void>;
  isLoading: boolean;
  provider: string;
  setProvider: (p: string) => void;
}

export function SearchBox({ onSearch, isLoading, provider, setProvider }: SearchBoxProps) {
  const [query, setQuery] = useState("");
  const [timeRange, setTimeRange] = useState("any");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      onSearch(query, provider, timeRange);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="relative w-full max-w-3xl mx-auto">
      <div className="relative group">
        <div className="absolute -inset-1 bg-linear-to-r from-pink-600 via-purple-600 to-indigo-600 rounded-lg blur opacity-40 group-hover:opacity-100 transition duration-1000 group-hover:duration-200"></div>
        <div className="relative flex items-center bg-zinc-900 rounded-lg ring-1 ring-zinc-800 shadow-2xl overflow-hidden">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the web (e.g., latest Next.js 15 features...)"
            className="w-full pl-5 pr-14 py-4 md:py-5 bg-zinc-900/80 border border-zinc-800 rounded-2xl focus:outline-none focus:ring-2 focus:ring-purple-500/50 text-zinc-100 placeholder-zinc-500 shadow-inner text-lg transition-all"
            disabled={isLoading}
          />
          
          <div className="flex bg-zinc-800/50 p-2 m-2 rounded-lg border border-zinc-700 items-center justify-between w-full md:w-auto overflow-x-auto gap-4">
            <div className="flex items-center">
              <button
                  type="button"
                  onClick={() => setProvider("firecrawl")}
                  className={clsx(
                      "px-4 py-2 rounded-md text-sm font-bold transition-all",
                      provider === "firecrawl" ? "bg-purple-600 text-white" : "text-zinc-400 hover:text-white"
                  )}
              >
                  Firecrawl
              </button>
              <button
                  type="button"
                  onClick={() => setProvider("tavily")}
                  className={clsx(
                      "px-4 py-2 rounded-md text-sm font-bold transition-all",
                      provider === "tavily" ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-white"
                  )}
              >
                  Tavily
              </button>
            </div>
            
            <div className="flex items-center gap-2 pr-2">
              {provider === "tavily" && (
                <>
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
                </>
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="p-5 hover:bg-zinc-800 transition-colors disabled:opacity-50 border-l border-zinc-800 flex items-center justify-center"
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
  );
}
