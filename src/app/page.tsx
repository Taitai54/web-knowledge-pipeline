"use client";

import { useState, useEffect } from "react";
import { SearchBox } from "@/components/SearchBox";
import { ResultCard } from "@/components/ResultCard";
import { FolderPickerModal } from "@/components/FolderPickerModal";
import { Download, FolderOpen, Loader2 } from "lucide-react";
import toast, { Toaster } from 'react-hot-toast';

interface SearchResult {
  title: string;
  url: string;
  content: string; // Snippet from Tavily
  score: number;
  date?: string;
}

export default function Home() {
  // query state not needed here since SearchBox manages its own local query state
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState("general");
  const [provider, setProvider] = useState("firecrawl");
  const [isSearching, setIsSearching] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeStatus, setScrapeStatus] = useState<Record<string, "pending" | "processing" | "scraped" | "error">>({});
  const [resolvedPath, setResolvedPath] = useState<string>("");
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  useEffect(() => {
    const fetchPath = async () => {
      if (!category) {
        setResolvedPath("");
        return;
      }
      try {
        const res = await fetch(`/api/resolve-path?path=${encodeURIComponent(category)}`);
        const data = await res.json();
        setResolvedPath(data.saveDir);
      } catch {
        setResolvedPath("");
      }
    };
    const timeoutId = setTimeout(fetchPath, 300);
    return () => clearTimeout(timeoutId);
  }, [category]);

  const handleSearch = async (q: string, searchProvider: string, timeRange: string) => {
    setIsSearching(true);
    // Using searchProvider passed from SearchBox
    setResults([]);
    setSelectedUrls(new Set());
    setScrapeStatus({});

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&provider=${searchProvider}&timeRange=${timeRange}`);
      const data = await res.json();
      if (data.success) {
        setResults(data.data.results || []);
      } else {
        toast.error(data.error || "Search failed");
      }
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "An error occurred during search");
    } finally {
      setIsSearching(false);
    }
  };

  const toggleSelection = (url: string) => {
    setSelectedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  };

  const handleSelectAll = () => {
    if (selectedUrls.size === results.length) {
      setSelectedUrls(new Set());
    } else {
      setSelectedUrls(new Set(results.map((r) => r.url)));
    }
  };

  const handleSelectFolder = () => {
    setIsPickerOpen(true);
  };

  const handleScrape = async () => {
    if (selectedUrls.size === 0) return;

    setIsScraping(true);
    
    const urlsToScrape = Array.from(selectedUrls);

    for (const url of urlsToScrape) {
      setScrapeStatus(prev => ({ ...prev, [url]: "processing" }));

      const resultItem = results.find(r => r.url === url);
      const title = resultItem?.title || "Untitled";

      try {
        const res = await fetch("/api/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, category, title }),
        });
        const data = await res.json();

        if (res.ok && data.success) {
          setScrapeStatus(prev => ({ ...prev, [url]: "scraped" }));
          toast.success(`Scraped: ${title}`);
        } else {
          setScrapeStatus(prev => ({ ...prev, [url]: "error" }));
          toast.error(data.error || `Failed to scrape: ${title}`);
        }
      } catch (err) {
        console.error("Scraping error:", err);
        setScrapeStatus(prev => ({ ...prev, [url]: "error" }));
        const errMsg = err instanceof Error ? err.message : "error occurred";
        toast.error(`${errMsg} while scraping: ${title}`);
      }
    }

    setIsScraping(false);
  };

  return (
    <main className="min-h-screen bg-background relative overflow-hidden">
        <FolderPickerModal 
          isOpen={isPickerOpen} 
          onClose={() => setIsPickerOpen(false)} 
          onSelect={(path) => setCategory(path)} 
        />
        <Toaster position="bottom-right" toastOptions={{
          style: {
            background: '#27272a',
            color: '#fff',
            border: '1px solid #3f3f46'
          }
        }} />
        {/* Background Gradients */}
        <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
            <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-purple-900/20 rounded-full blur-[120px]" />
            <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900/20 rounded-full blur-[120px]" />
        </div>

        <div className="container relative z-10 py-16 md:py-24 space-y-16">
            
            {/* Header */}
            <div className="text-center space-y-6 animate-fade-in">
                <h1 className="text-5xl md:text-7xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-purple-100 via-white to-white/70">
                    Web Knowledge Pipeline
                </h1>
                <p className="text-xl md:text-2xl text-zinc-300 font-light max-w-3xl mx-auto leading-relaxed">
                    Search the live web, curate high-quality sources, and transform them into clean Markdown for your RAG system.
                </p>
            </div>

            {/* Search Section */}
            <div className="animate-fade-in animate-delay-100">
                <SearchBox onSearch={handleSearch} isLoading={isSearching} provider={provider} setProvider={setProvider} />
            </div>

            {/* Controls & Folder Selection */}
            {results.length > 0 && (
                <div className="flex flex-col md:flex-row gap-4 items-center justify-between glass-panel p-4 rounded-xl animate-fade-in animate-delay-200">
                    <div className="flex items-center gap-4 w-full md:w-auto">
                        <button
                          onClick={handleSelectAll}
                          className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-sm font-semibold transition-colors border border-zinc-700"
                        >
                          {selectedUrls.size === results.length ? "Deselect All" : "Select All"}
                        </button>
                        <div className="flex flex-col">
                           <div className="flex items-center gap-2 mb-2">
                               <button 
                                 onClick={() => setCategory("general")}
                                 title="Reset to default project knowledge base folder"
                                 className="text-xs px-2 py-1 rounded-md transition-colors bg-purple-500/20 text-purple-300 border border-purple-500/30 hover:bg-purple-500/30"
                               >
                                 Project Default
                               </button>
                               <button 
                                 onClick={handleSelectFolder}
                                 className="text-xs px-2 py-1 rounded-md transition-colors bg-blue-500/20 text-blue-300 border border-blue-500/30 hover:bg-blue-500/30"
                               >
                                 Browse Custom Folder...
                               </button>
                           </div>
                            <div className="bg-zinc-900/50 p-2 rounded-lg border border-zinc-800 flex items-center gap-3 w-full md:w-auto">
                                <FolderOpen className="w-5 h-5 text-purple-400 flex-shrink-0" />
                                <input 
                                    type="text" 
                                    value={category}
                                    onChange={(e) => setCategory(e.target.value)}
                                    className="bg-transparent border-none focus:outline-none text-sm w-full md:w-72 placeholder-zinc-500 text-zinc-300"
                                    title="Category name or absolute path"
                                    placeholder="Category (e.g., research)..."
                                />
                            </div>
                            {resolvedPath && (
                              <div className="text-[10px] mt-1.5 text-zinc-500 ml-1 max-w-[300px] md:max-w-sm truncate" title={resolvedPath}>
                                Saving to: <span className="font-mono text-zinc-400">{resolvedPath}</span>
                              </div>
                            )}
                        </div>
                        <span className="text-sm text-muted-foreground whitespace-nowrap">
                            {selectedUrls.size} selected
                        </span>
                    </div>

                    <button
                        onClick={handleScrape}
                        disabled={selectedUrls.size === 0 || isScraping}
                        className="btn-primary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed w-full md:w-auto justify-center"
                    >
                        {isScraping ? (
                            <>
                                <Loader2 className="w-4 h-4 animate-spin" />
                                Processing Pipeline...
                            </>
                        ) : (
                            <>
                                <Download className="w-4 h-4" />
                                Scrape to Knowledge Base
                            </>
                        )}
                    </button>
                </div>
            )}

            {/* Results Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-fade-in animate-delay-300">
                {results.map((result, index) => (
                    <div key={`${result.url}-${index}`} onClick={() => toggleSelection(result.url)} className="cursor-pointer">
                        <ResultCard
                            title={result.title}
                            url={result.url}
                            snippet={result.content}
                            date={result.date}
                            isSelected={selectedUrls.has(result.url)}
                            onSelect={() => toggleSelection(result.url)} // Handled by parent click too
                            status={scrapeStatus[result.url] as "pending" | "processing" | "scraped" | "error" | undefined}
                        />
                    </div>
                ))}
            </div>
        </div>
    </main>
  );
}
