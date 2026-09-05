"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { SearchBox } from "@/components/SearchBox";
import { ResultCard } from "@/components/ResultCard";
import { FolderPickerModal } from "@/components/FolderPickerModal";
import { PasteUrlsPanel } from "@/components/PasteUrlsPanel";
import { ProviderStatusBar, type ProviderStatus } from "@/components/ProviderStatusBar";
import { PipelineGuide, type PipelineStep } from "@/components/PipelineGuide";
import { ScrapeToolbar } from "@/components/ScrapeToolbar";
import { RagPlayground } from "@/components/RagPlayground";
import { Globe, MessageSquare } from "lucide-react";
import toast, { Toaster } from "react-hot-toast";
import clsx from "clsx";

interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
  date?: string;
}

type ScrapeStatus = "pending" | "processing" | "scraped" | "error";

function pickAlternateEngine(current: string, providers: ProviderStatus[]): string {
  const configured = providers.filter((p) => p.configured).map((p) => p.id);
  return configured.find((id) => id !== current) ?? current;
}

export default function Home() {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState("general");
  const [provider, setProvider] = useState("searxng");
  const [scrapeEngine, setScrapeEngine] = useState("crawl4ai");
  const [retryEngine, setRetryEngine] = useState("firecrawl");
  const [searchProviders, setSearchProviders] = useState<ProviderStatus[]>([]);
  const [scrapeProviders, setScrapeProviders] = useState<ProviderStatus[]>([]);
  const [providerDefaults, setProviderDefaults] = useState({ search: "searxng", scrape: "crawl4ai" });
  const [isSearching, setIsSearching] = useState(false);
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeStatus, setScrapeStatus] = useState<Record<string, ScrapeStatus>>({});
  const [scrapeEngineByUrl, setScrapeEngineByUrl] = useState<Record<string, string>>({});
  const [resolvedPath, setResolvedPath] = useState<string>("");
  const [resolvedNamespace, setResolvedNamespace] = useState<string>("");
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [showProviderHealth, setShowProviderHealth] = useState(false);
  const [activeWorkspace, setActiveWorkspace] = useState<"scrape" | "playground">("scrape");
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncLogs, setSyncLogs] = useState<string[]>([]);

  useEffect(() => {
    const loadProviders = async () => {
      try {
        const res = await fetch("/api/providers");
        const data = await res.json();
        if (data.success && data.data) {
          setSearchProviders(data.data.search ?? []);
          setScrapeProviders(data.data.scrape ?? []);
          setProviderDefaults(data.data.defaults);
          setProvider(data.data.defaults.search);
          setScrapeEngine(data.data.defaults.scrape);
          setRetryEngine(
            pickAlternateEngine(data.data.defaults.scrape, data.data.scrape ?? []),
          );
        }
      } catch {
        // keep defaults
      }
    };
    loadProviders();
  }, []);

  useEffect(() => {
    setRetryEngine((prev) => {
      const alt = pickAlternateEngine(scrapeEngine, scrapeProviders);
      return alt !== scrapeEngine ? alt : prev;
    });
  }, [scrapeEngine, scrapeProviders]);

  useEffect(() => {
    const fetchPath = async () => {
      if (!category) {
        setResolvedPath("");
        setResolvedNamespace("");
        return;
      }
      try {
        const res = await fetch(`/api/resolve-path?path=${encodeURIComponent(category)}`);
        const data = await res.json();
        setResolvedPath(data.saveDir);
        setResolvedNamespace(data.frontmatterCategory || "");
      } catch {
        setResolvedPath("");
        setResolvedNamespace("");
      }
    };
    const timeoutId = setTimeout(fetchPath, 300);
    return () => clearTimeout(timeoutId);
  }, [category]);

  const failedCount = useMemo(
    () => Object.values(scrapeStatus).filter((s) => s === "error").length,
    [scrapeStatus],
  );
  const scrapedCount = useMemo(
    () => Object.values(scrapeStatus).filter((s) => s === "scraped").length,
    [scrapeStatus],
  );

  const activeStep: PipelineStep = useMemo(() => {
    if (results.length === 0) return 1;
    if (selectedUrls.size === 0) return 2;
    return 3;
  }, [results.length, selectedUrls.size]);

  const handleSearch = async (q: string, searchProvider: string, timeRange: string) => {
    setIsSearching(true);
    setResults([]);
    setSelectedUrls(new Set());
    setScrapeStatus({});
    setScrapeEngineByUrl({});

    try {
      const res = await fetch(
        `/api/search?q=${encodeURIComponent(q)}&provider=${searchProvider}&timeRange=${timeRange}`,
      );
      const data = await res.json();
      if (data.success) {
        setResults(data.data.results || []);
        if ((data.data.results || []).length === 0) {
          toast("No results — try another search provider or paste URLs directly.");
        }
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

  const handleSelectFailed = () => {
    const failed = results.filter((r) => scrapeStatus[r.url] === "error").map((r) => r.url);
    setSelectedUrls(new Set(failed));
    if (failed.length === 0) toast("No failed items to select");
  };

  const scrapeUrls = useCallback(async (urls: string[], engine: string) => {
      if (urls.length === 0) return { ok: 0, failed: 0 };

      setIsScraping(true);
      let ok = 0;
      let failed = 0;

      for (const url of urls) {

        setScrapeStatus((prev) => ({ ...prev, [url]: "processing" }));

        const resultItem = results.find((r) => r.url === url);
        const title = resultItem?.title || "Untitled";

        try {
          const res = await fetch("/api/scrape", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url, category, title, engine }),
          });
          const data = await res.json();

          if (res.ok && data.success) {
            setScrapeStatus((prev) => ({ ...prev, [url]: "scraped" }));
            setScrapeEngineByUrl((prev) => ({ ...prev, [url]: engine }));
            ok += 1;
            toast.success(`Saved: ${title}`);
          } else {
            setScrapeStatus((prev) => ({ ...prev, [url]: "error" }));
            setScrapeEngineByUrl((prev) => ({ ...prev, [url]: engine }));
            failed += 1;
            toast.error(data.error || `Failed: ${title}`);
          }
        } catch (err) {
          console.error("Scraping error:", err);
          setScrapeStatus((prev) => ({ ...prev, [url]: "error" }));
          setScrapeEngineByUrl((prev) => ({ ...prev, [url]: engine }));
          failed += 1;
          const errMsg = err instanceof Error ? err.message : "Error";
          toast.error(`${errMsg}: ${title}`);
        }
      }

      setIsScraping(false);
      return { ok, failed };
    }, [category, results]);

  const handleScrape = async () => {
    if (selectedUrls.size === 0) return;
    const urls = Array.from(selectedUrls).filter((u) => scrapeStatus[u] !== "scraped");
    const skipped = selectedUrls.size - urls.length;
    if (urls.length === 0) {
      toast("Selected items are already scraped");
      return;
    }
    const summary = await scrapeUrls(urls, scrapeEngine);
    if (skipped > 0) {
      toast(`${skipped} already scraped — skipped`);
    }
    if (summary && summary.failed > 0) {
      toast("Some items failed — try another scrape engine below", { icon: "⚠️" });
    }
  };

  const handleRetryFailed = async () => {
    const failedUrls = results.filter((r) => scrapeStatus[r.url] === "error").map((r) => r.url);
    if (failedUrls.length === 0) {
      toast("Nothing failed to retry");
      return;
    }
    if (retryEngine === scrapeEngine) {
      toast("Pick a different engine for retry");
      return;
    }
    const summary = await scrapeUrls(failedUrls, retryEngine);
    if (summary && summary.ok > 0) {
      toast.success(`Recovered ${summary.ok} page(s) with ${retryEngine}`);
    }
  };

  const handleSync = async () => {
    if (isSyncing) return;
    setIsSyncing(true);
    setSyncLogs(["Initiating sync connection..."]);

    try {
      const res = await fetch("/api/pinecone/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Sync failed to start");
      }

      const reader = res.body?.getReader();
      if (!reader) {
        throw new Error("No readable stream in response");
      }

      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.trim()) {
            try {
              const packet = JSON.parse(line);
              if (packet.type === "stdout" || packet.type === "stderr" || packet.type === "status" || packet.type === "error") {
                setSyncLogs((prev) => [...prev, packet.message]);
              } else if (packet.type === "close") {
                setSyncLogs((prev) => [...prev, `Sync finished with exit code ${packet.code}`]);
                if (packet.code === 0) {
                  toast.success("Folder successfully synced to Pinecone!");
                } else {
                  toast.error(`Sync finished with error code ${packet.code}`);
                }
              }
            } catch (err) {
              console.error("Error parsing sync packet:", err, line);
            }
          }
        }
      }
    } catch (err: any) {
      console.error("Sync failed:", err);
      setSyncLogs((prev) => [...prev, `Sync failed: ${err.message}`]);
      toast.error(err.message || "Sync failed");
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <main className="min-h-screen bg-background relative overflow-hidden">
      <FolderPickerModal
        isOpen={isPickerOpen}
        onClose={() => setIsPickerOpen(false)}
        onSelect={(path) => setCategory(path)}
      />
      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            background: "#27272a",
            color: "#fff",
            border: "1px solid #3f3f46",
          },
        }}
      />

      <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-purple-900/20 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-900/20 rounded-full blur-[120px]" />
      </div>

      <div className="container relative z-10 py-12 md:py-16 space-y-10 max-w-5xl">
        <div className="text-center space-y-4">
          <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-purple-100 via-white to-white/70">
            Web Knowledge Pipeline
          </h1>
          <p className="text-lg text-zinc-400 font-light max-w-2xl mx-auto">
            Search → select pages → scrape to Markdown. One search provider and one scrape engine per
            run.
          </p>
        </div>

        {/* Workspace Mode Selection Tabs */}
        <div className="flex justify-center border-b border-zinc-800 pb-2">
          <div className="flex bg-zinc-900/60 p-1.5 rounded-xl border border-zinc-800/80">
            <button
              onClick={() => setActiveWorkspace("scrape")}
              className={clsx(
                "flex items-center gap-2.5 px-6 py-2.5 rounded-lg text-sm font-semibold transition-all duration-300",
                activeWorkspace === "scrape"
                  ? "bg-purple-600 text-white shadow-lg shadow-purple-500/10"
                  : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              <Globe className="w-4 h-4" />
              Scrape & Index Workspace
            </button>
            <button
              onClick={() => setActiveWorkspace("playground")}
              className={clsx(
                "flex items-center gap-2.5 px-6 py-2.5 rounded-lg text-sm font-semibold transition-all duration-300",
                activeWorkspace === "playground"
                  ? "bg-purple-600 text-white shadow-lg shadow-purple-500/10"
                  : "text-zinc-400 hover:text-zinc-200"
              )}
            >
              <MessageSquare className="w-4 h-4" />
              RAG Chat Playground
            </button>
          </div>
        </div>

        {activeWorkspace === "scrape" ? (
          <>
            <PipelineGuide
              activeStep={activeStep}
              hasResults={results.length > 0}
              selectedCount={selectedUrls.size}
              failedCount={failedCount}
            />

            <div className="space-y-4">
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowProviderHealth((v) => !v)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 underline-offset-2 hover:underline"
                >
                  {showProviderHealth ? "Hide" : "Show"} provider health
                </button>
              </div>
              {showProviderHealth && searchProviders.length > 0 && (
                <ProviderStatusBar
                  search={searchProviders}
                  scrape={scrapeProviders}
                  defaults={providerDefaults}
                />
              )}

              <SearchBox
                onSearch={handleSearch}
                isLoading={isSearching}
                provider={provider}
                setProvider={setProvider}
                searchProviders={searchProviders}
              />

              <div className="flex justify-center">
                <PasteUrlsPanel
                  onAdd={(items) => {
                    setResults((prev) => {
                      const existing = new Set(prev.map((r) => r.url));
                      const added = items
                        .filter((i) => !existing.has(i.url))
                        .map((i) => ({
                          title: i.title,
                          url: i.url,
                          content: i.content,
                          score: 0,
                        }));
                      return [...prev, ...added];
                    });
                    toast.success(`Added ${items.length} URL(s) — now select them in step 2`);
                  }}
                />
              </div>
            </div>

            {results.length > 0 && (
              <>
                <div className="px-1">
                  <p className="text-xs font-semibold uppercase tracking-wider text-purple-400">Step 2</p>
                  <h2 className="text-lg font-semibold text-zinc-100">Select pages to save</h2>
                  <p className="text-sm text-zinc-500 mt-1">
                    Click cards to toggle selection — you can select as many as you want.
                  </p>
                </div>

                <ScrapeToolbar
                  category={category}
                  onCategoryChange={setCategory}
                  resolvedPath={resolvedPath}
                  onProjectDefault={() => setCategory("general")}
                  onBrowseFolder={() => setIsPickerOpen(true)}
                  selectedCount={selectedUrls.size}
                  totalCount={results.length}
                  failedCount={failedCount}
                  scrapedCount={scrapedCount}
                  scrapeEngine={scrapeEngine}
                  onScrapeEngineChange={setScrapeEngine}
                  retryEngine={retryEngine}
                  onRetryEngineChange={setRetryEngine}
                  scrapeProviders={scrapeProviders}
                  isScraping={isScraping}
                  onSelectAll={handleSelectAll}
                  onSelectFailed={handleSelectFailed}
                  onScrape={handleScrape}
                  onRetryFailed={handleRetryFailed}
                  onSync={handleSync}
                  isSyncing={isSyncing}
                  syncLogs={syncLogs}
                  onClearLogs={() => setSyncLogs([])}
                />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {results.map((result, index) => (
                    <div
                      key={`${result.url}-${index}`}
                      onClick={() => toggleSelection(result.url)}
                      className="cursor-pointer"
                    >
                      <ResultCard
                        title={result.title}
                        url={result.url}
                        snippet={result.content}
                        date={result.date}
                        isSelected={selectedUrls.has(result.url)}
                        onSelect={() => toggleSelection(result.url)}
                        status={scrapeStatus[result.url]}
                        engineUsed={scrapeEngineByUrl[result.url]}
                        score={result.score}
                      />
                    </div>
                  ))}
                </div>
              </>
            )}
          </>
        ) : (
          <RagPlayground defaultNamespace={resolvedNamespace || category} />
        )}
      </div>
    </main>
  );
}
