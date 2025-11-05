"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import EventCard from "./EventCard";
import type { SearchResponseNormalized, EventNormalized, Provider } from "../types/normalized";
import { getBaseUrl } from "../lib/config";
import { useHistory } from "../ui/HistoryStore";

type SearchOptions = {
  providers: { name: string; value: string; label: string }[];
  order: { name: string; label: string }[];
  status: { name: string; label: string }[];
  kalshiScopes?: { name: "series" | "events"; label: string }[];
};

type ProviderSection = {
  provider: Provider | string;
  data?: any;
  error?: string;
};

const BASE = getBaseUrl();

async function fetchOptions(): Promise<SearchOptions> {
  try {
    const res = await fetch(`${BASE}/api/search/options`, { cache: "no-store" });
    if (res.ok) {
      const js = await res.json();
      return {
        ...js,
        kalshiScopes: [
          { name: "series", label: "Kalshi: Series" },
          { name: "events", label: "Kalshi: Events" },
        ],
      };
    }
  } catch {}
  return {
    providers: [
      { name: "KALSHI", value: "kalshi", label: "Kalshi" },
      { name: "POLYMARKET", value: "polymarket", label: "Polymarket" },
      { name: "ALL", value: "all", label: "All" },
    ],
    order: [
      { name: "ORDER_BY_TRENDING", label: "Trending" },
      { name: "ORDER_BY_CLOSING_SOON", label: "Closing Soon" },
      { name: "ORDER_BY_LIQUIDITY", label: "Liquidity" },
      { name: "ORDER_BY_VOLUME", label: "Volume" },
      { name: "ORDER_BY_NEWEST", label: "Newest" },
      { name: "ORDER_BY_VOLATILE", label: "Volatile" },
      { name: "ORDER_BY_EVEN_ODDS", label: "Even Odds" },
      { name: "ORDER_BY_QUERYMATCH", label: "Query Match" },
    ],
    status: [
      { name: "OPEN_MARKETS", label: "Open" },
      { name: "CLOSED_MARKETS", label: "Closed" },
      { name: "ALL_MARKETS", label: "All" },
    ],
    kalshiScopes: [
      { name: "series", label: "Kalshi: Series" },
      { name: "events", label: "Kalshi: Events" },
    ],
  };
}

function buildSearchUrl(
  q: string,
  provider: string,
  order: string,
  status: string,
  excludeSports: boolean,
  kalshiScope: "series" | "events",
  limit: number,
  page: number,
  normalized: boolean,
) {
  const url = new URL(`${BASE}/api/search`);
  if (q) url.searchParams.set("q", q);
  url.searchParams.set("limit", String(Math.max(1, Math.min(50, Number(limit) || 10))));
  url.searchParams.set("page", String(Math.max(1, Number(page) || 1)));
  if (provider) url.searchParams.set("provider", provider);
  if (order) url.searchParams.set("order", order);
  if (status) url.searchParams.set("status", status);
  if (excludeSports) url.searchParams.set("exclude_sports", "1");
  url.searchParams.set("kalshi_scope", kalshiScope);
  if (normalized) url.searchParams.set("normalized", "1");
  return url;
}

export default function SearchPage() {
  const { add } = useHistory();
  const [options, setOptions] = useState<SearchOptions | null>(null);
  const [q, setQ] = useState("");
  const [provider, setProvider] = useState("all");
  const [status, setStatus] = useState("OPEN_MARKETS");
  const [order, setOrder] = useState("ORDER_BY_TRENDING");
  const [excludeSports, setExcludeSports] = useState(false);
  const [kalshiScope, setKalshiScope] = useState<"series" | "events">("series");
  const [limit, setLimit] = useState<number>(10);
  const [page, setPage] = useState<number>(1);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [sections, setSections] = useState<ProviderSection[]>([]);

  const lastSearchParamsRef = useRef<string>("");
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    fetchOptions().then(setOptions);
  }, []);

  const providerSummaries = useMemo(() => {
    const out: string[] = [];
    for (const s of sections) {
      if (s.provider === "polymarket") {
        const n = Array.isArray(s?.data) ? s.data.length : (s?.data?.events ?? []).length;
        out.push(`polymarket:${n}`);
      }
      if (s.provider === "kalshi") {
        const n = Array.isArray(s?.data) ? s.data.length : (s?.data?.current_page ?? []).length;
        out.push(`kalshi:${n}`);
      }
    }
    return out;
  }, [sections]);

  const totalResults = useMemo(() => sections.reduce<number>((acc, section) => acc + (Array.isArray(section.data) ? section.data.length : 0), 0), [sections]);

  const filterChips = useMemo(() => {
    const chips: string[] = [];
    const providerLabel = options?.providers?.find((p) => p.value === provider)?.label;
    if (provider !== "all" && providerLabel) chips.push(providerLabel);
    const statusLabel = options?.status?.find((s) => s.name === status)?.label;
    if (status !== "OPEN_MARKETS" && statusLabel) chips.push(statusLabel);
    const orderLabel = options?.order?.find((o) => o.name === order)?.label;
    if (order !== "ORDER_BY_TRENDING" && orderLabel) chips.push(orderLabel);
    if ((provider === "kalshi" || provider === "all") && kalshiScope === "events") chips.push("Kalshi: Events");
    if (excludeSports) chips.push("Exclude Sports");
    if (limit !== 10) chips.push(`Limit ${limit}`);
    if (page !== 1) chips.push(`Page ${page}`);
    return chips;
  }, [options, provider, status, order, kalshiScope, excludeSports, limit, page]);

  const runSearch = async (intent?: "debounced" | "submit") => {
    const trimmed = q.trim();
    if (!trimmed) {
      setSections([]);
      setError("");
      return;
    }
    const url = buildSearchUrl(
      trimmed,
      provider.toLowerCase(),
      order.toUpperCase(),
      status.toUpperCase(),
      excludeSports,
      kalshiScope,
      limit,
      page,
      true,
    );
    const urlKey = url.toString();
    if (intent === "debounced" && urlKey === lastSearchParamsRef.current) return;
    lastSearchParamsRef.current = urlKey;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`Backend HTTP ${res.status}`);
      const payload: SearchResponseNormalized = await res.json();
      const items = (payload?.results ?? []).filter((it: any) => it?.entity === "event") as EventNormalized[];
      const kal = items.filter((x) => x.provider === "kalshi");
      const poly = items.filter((x) => x.provider === "polymarket");
      const results: ProviderSection[] = [
        { provider: "kalshi", data: kal },
        { provider: "polymarket", data: poly },
      ];
      setSections(results);

      const tags: string[] = [];
      if (provider) tags.push(provider);
      if (status) tags.push(status);
      if (order) tags.push(order);
      if (excludeSports) tags.push("excludeSports");
      const includeKalshiScopeTag = provider === "kalshi" || provider === "all";
      const effScope = includeKalshiScopeTag ? ((payload?.meta as any)?.kalshi_scope || kalshiScope) : undefined;
      if (effScope && includeKalshiScopeTag) tags.push(`kalshi:${effScope}`);
      tags.push(`limit:${payload?.meta?.limit ?? limit}`);
      tags.push(`page:${payload?.meta?.page ?? page}`);
      const suffix = [...providerSummaries, ...tags].filter(Boolean).join(" · ");
      const summary = `Search: "${trimmed}"` + (suffix ? ` · ${suffix}` : "");
      add({ kind: "search", summary, method: "GET", url: url.pathname + "?" + url.searchParams.toString() });
    } catch (e: any) {
      setSections([]);
      setError(e?.message || "Backend unavailable");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runSearch("debounced");
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, provider, status, order, excludeSports, kalshiScope, limit, page]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    runSearch("submit");
  };

  const resetFilters = () => {
    setProvider("all");
    setStatus("OPEN_MARKETS");
    setOrder("ORDER_BY_TRENDING");
    setKalshiScope("series");
    setLimit(10);
    setPage(1);
    setExcludeSports(false);
  };

  const hasQuery = q.trim().length > 0;

  return (
    <main className="space-y-8 pb-10">
      <div className="bg-white/90 border border-gray-200 shadow-sm rounded-2xl p-6">
        <form onSubmit={onSubmit} className="grid gap-6 lg:grid-cols-12" aria-label="Search filters">
          <div className="lg:col-span-5 space-y-3">
            <label htmlFor="search" className="text-[11px] font-semibold tracking-wide uppercase text-gray-500">Keyword</label>
            <div className="relative">
              <div className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</div>
              <input
                id="search"
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search events or markets (e.g., election)"
                className="border border-gray-300 rounded-xl pl-10 pr-4 py-3 w-full text-sm bg-white focus:ring-2 focus:ring-black/10"
              />
            </div>
            <p className="text-xs text-gray-500">
              Search Polymarket and Kalshi simultaneously. Results stay on this page and do not change the URL.
            </p>
          </div>

          <div className="lg:col-span-7">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              <label htmlFor="provider" className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Provider
                <select
                  id="provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value)}
                  className="border border-gray-300 rounded-xl px-3 py-2.5 text-sm bg-white"
                >
                  {(options?.providers ?? []).map((p) => (
                    <option key={p.name} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </label>
              <label htmlFor="status" className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Market Status
                <select
                  id="status"
                  value={status}
                  onChange={(e) => setStatus(e.target.value)}
                  className="border border-gray-300 rounded-xl px-3 py-2.5 text-sm bg-white"
                >
                  {(options?.status ?? []).map((s) => (
                    <option key={s.name} value={s.name}>{s.label}</option>
                  ))}
                </select>
              </label>
              <label htmlFor="order" className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Sort By
                <select
                  id="order"
                  value={order}
                  onChange={(e) => setOrder(e.target.value)}
                  className="border border-gray-300 rounded-xl px-3 py-2.5 text-sm bg-white"
                >
                  {(options?.order ?? []).map((o) => (
                    <option key={o.name} value={o.name}>{o.label}</option>
                  ))}
                </select>
              </label>
              <label htmlFor="kalshiScope" className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Kalshi Scope
                <select
                  id="kalshiScope"
                  value={kalshiScope}
                  onChange={(e) => setKalshiScope(e.target.value as any)}
                  className="border border-gray-300 rounded-xl px-3 py-2.5 text-sm bg-white"
                >
                  {(options?.kalshiScopes ?? [
                    { name: "series" as const, label: "Kalshi: Series" },
                    { name: "events" as const, label: "Kalshi: Events" },
                  ]).map((s) => (
                    <option key={s.name} value={s.name}>{s.label}</option>
                  ))}
                </select>
              </label>
              <label htmlFor="limit" className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Result Limit
                <select
                  id="limit"
                  value={String(limit)}
                  onChange={(e) => setLimit(parseInt(e.target.value || "10", 10))}
                  className="border border-gray-300 rounded-xl px-3 py-2.5 text-sm bg-white"
                  title="Results per provider"
                >
                  {[10, 20, 30, 50].map((n) => (
                    <option key={n} value={n}>{`Limit: ${n}`}</option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Page
                <div className="flex items-center gap-2 rounded-xl border border-gray-300 bg-white px-3 py-2.5">
                  <label className="sr-only" htmlFor="page">Page</label>
                  <input
                    id="page"
                    type="number"
                    min={1}
                    step={1}
                    value={page}
                    onChange={(e) => setPage(Math.max(1, parseInt(e.target.value || "1", 10)))}
                    className="w-16 border-none bg-transparent text-sm focus:ring-0"
                    title="Page number"
                  />
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-sm hover:bg-gray-50 disabled:opacity-40"
                      aria-label="Previous page"
                      disabled={page <= 1}
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      onClick={() => setPage((p) => p + 1)}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-gray-200 text-sm hover:bg-gray-50"
                      aria-label="Next page"
                    >
                      →
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="lg:col-span-12 flex flex-wrap items-center justify-between gap-3 border-t border-dashed border-gray-200 pt-4">
            <label className="flex items-center gap-2 text-sm text-gray-700" htmlFor="excludeSports">
              <input
                id="excludeSports"
                type="checkbox"
                checked={excludeSports}
                onChange={(e) => setExcludeSports(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              Exclude Sports (Kalshi)
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={resetFilters}
                title="Reset filters to defaults"
                aria-label="Reset filters"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Reset Filters
              </button>
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-lg bg-black px-5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={loading || !hasQuery}
                aria-live="polite"
              >
                {loading && (
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden="true" />
                )}
                {loading ? "Searching" : "Search"}
              </button>
            </div>
          </div>
        </form>

        {filterChips.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold uppercase tracking-wide text-gray-500">Active Filters:</span>
            {filterChips.map((chip) => (
              <span key={chip} className="rounded-full border border-gray-200 bg-gray-100 px-3 py-1 text-gray-700">{chip}</span>
            ))}
          </div>
        )}
      </div>

      {!hasQuery && (
        <div className="text-sm text-gray-600">Start by entering a keyword above to explore Polymarket and Kalshi events.</div>
      )}
      {error && (
        <p className="text-sm text-red-600" role="alert">Error contacting backend: {error}</p>
      )}

      {hasQuery && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-gray-600">
              {loading ? "Fetching fresh results…" : totalResults > 0 ? `Showing ${totalResults} events` : "No matching events yet."}
            </p>
            {providerSummaries.length > 0 && (
              <p className="text-xs text-gray-500">{providerSummaries.join(" · ")}</p>
            )}
          </div>

          {loading && (
            <div className="grid md:grid-cols-2 gap-6">
              <div className="h-[220px] animate-pulse rounded-2xl border border-gray-200 bg-gray-50" />
              <div className="h-[220px] animate-pulse rounded-2xl border border-gray-200 bg-gray-50" />
            </div>
          )}

          {!loading && totalResults === 0 && (
            <div className="rounded-2xl border border-dashed border-gray-300 bg-white/60 p-8 text-center text-sm text-gray-600">
              No results found. Try broadening your keywords or adjusting the filters above.
            </div>
          )}

          {!loading && totalResults > 0 && (
            <div className="grid md:grid-cols-2 gap-6">
              {sections.map((section, idx) => {
            const providerColor = section.provider === "polymarket" ? {
              card: "border-violet-200 bg-violet-50",
              item: "border-violet-200 bg-violet-50",
              accent: "text-violet-700",
            } : section.provider === "kalshi" ? {
              card: "border-emerald-200 bg-emerald-50",
              item: "border-emerald-200 bg-emerald-50",
              accent: "text-emerald-700",
            } : {
              card: "border-gray-200 bg-gray-50",
              item: "border-gray-200 bg-gray-50",
              accent: "text-gray-700",
            };

                return (
                  <div key={idx} className={`border border-gray-200 rounded-2xl p-5 shadow-sm ${providerColor.card}`}>
                    <div className="mb-3 flex items-center justify-between">
                      <h2 className="text-sm font-semibold capitalize tracking-wide text-gray-800">{section.provider}</h2>
                      {section.provider && (
                        <span className={`text-xs font-medium ${providerColor.accent}`}>
                          {Array.isArray(section.data) ? section.data.length : 0} results
                        </span>
                      )}
                    </div>
                    {section.error && (
                      <p className="text-sm text-red-600">Error: {section.error}</p>
                    )}
                    {!section.error && Array.isArray(section.data) && section.data.length === 0 && (
                      <p className="text-sm text-gray-600">No {section.provider} events matched this search.</p>
                    )}
                    {!section.error && (
                      <div className="space-y-3">
                        {Array.isArray(section.data) && (
                          <>
                            {(section.data as EventNormalized[]).slice(0, 8).map((ev, idx) => (
                              <EventCard
                                key={`${ev.provider}-ev-${ev.event_id}-${idx}`}
                                provider={ev.provider}
                                title={ev.title || ev.event_id}
                                subtitle={(ev.event_ticker || ev.slug) || undefined}
                                eventId={ev.event_id}
                                eventTicker={ev.event_ticker}
                                eventSlug={ev.slug}
                                eventUrl={(ev as any).url}
                                totalCount={ev.markets_count ?? (Array.isArray(ev.markets) ? ev.markets!.length : 0)}
                                initialMarkets={ev.markets ?? []}
                                color={{ item: providerColor.item, accent: providerColor.accent }}
                              />
                            ))}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </main>
  );
}
