"use client";

import clsx from "clsx";

export interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  healthy?: boolean;
  description: string;
}

interface ProviderStatusBarProps {
  search: ProviderStatus[];
  scrape: ProviderStatus[];
  defaults: { search: string; scrape: string };
}

function dot(configured: boolean, healthy?: boolean) {
  if (!configured) {
    return { className: "bg-zinc-600", title: "Not configured — add URL to .env.local" };
  }
  if (healthy === false) {
    return { className: "bg-amber-500", title: "Configured but service not reachable — is Docker running?" };
  }
  if (healthy === true) {
    return { className: "bg-emerald-500", title: "Online" };
  }
  return { className: "bg-zinc-400", title: "Configured" };
}

export function ProviderStatusBar({ search, scrape, defaults }: ProviderStatusBarProps) {
  const localSearch = search.find((p) => p.id === "searxng");
  const localScrape = scrape.find((p) => p.id === "crawl4ai");
  const missingEnv = !localSearch?.configured || !localScrape?.configured;

  return (
    <div className="w-full max-w-3xl mx-auto glass-panel rounded-xl p-4 space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-zinc-300 font-medium">Provider status</span>
        <span className="text-xs text-zinc-500">
          Defaults: search <span className="text-zinc-400">{defaults.search}</span> · scrape{" "}
          <span className="text-zinc-400">{defaults.scrape}</span>
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {(
          [
            { role: "search", items: search },
            { role: "scrape", items: scrape },
          ] as const
        ).map(({ role, items }) => (
          <div key={role} className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-zinc-500 w-14 shrink-0">
              {role}
            </span>
            <div className="flex flex-wrap gap-2">
              {items.map((p) => {
                const d = dot(p.configured, p.healthy);
                return (
                  <div
                    key={`${role}-${p.id}`}
                    className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900/60 border border-zinc-800"
                    title={d.title}
                  >
                    <span className={clsx("w-2 h-2 rounded-full shrink-0", d.className)} />
                    <span className="text-zinc-200">{p.label}</span>
                    {!p.configured && <span className="text-[10px] text-zinc-500">env</span>}
                    {p.configured && p.healthy === false && (
                      <span className="text-[10px] text-amber-400">offline</span>
                    )}
                    {p.healthy === true && (
                      <span className="text-[10px] text-emerald-400">live</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {missingEnv && (
        <p className="text-xs text-amber-200/90 leading-relaxed">
          Local Docker needs <code className="text-amber-100">SEARXNG_URL</code> and{" "}
          <code className="text-amber-100">CRAWL4AI_BASE_URL</code> in{" "}
          <code className="text-amber-100">.env.local</code>, then restart the dev server (Ctrl+C → run bat again).
        </p>
      )}
    </div>
  );
}
