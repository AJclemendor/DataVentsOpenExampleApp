"use client";

import { useCallback, useMemo, useState } from "react";
import GraphModal from "../ui/GraphModal";
import type { EventNormalized, MarketNormalized, Provider } from "../types/normalized";
import { getBaseUrl } from "../lib/config";

export default function EventCard({
  provider,
  title,
  subtitle,
  eventId,
  eventTicker,
  eventSlug,
  eventUrl,
  totalCount,
  initialMarkets,
  color,
}: {
  provider: Provider;
  title: string;
  subtitle?: string;
  eventId: string;
  eventTicker?: string | null;
  eventSlug?: string | null;
  eventUrl?: string | null;
  totalCount?: number;
  initialMarkets?: MarketNormalized[] | null;
  color: { item: string; accent: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [markets, setMarkets] = useState<MarketNormalized[] | null>(null);
  const [graph, setGraph] = useState<null | { market: MarketNormalized; title: string }>(null);

  const haveAllInitial = useMemo(() => {
    const initLen = Array.isArray(initialMarkets) ? initialMarkets.length : 0;
    const total = typeof totalCount === "number" ? totalCount : initLen;
    return initLen > 0 && initLen >= total;
  }, [initialMarkets, totalCount]);

  const displaySubtitle = useMemo(() => subtitle ?? (eventTicker ?? eventSlug ?? ""), [subtitle, eventTicker, eventSlug]);

  const providerUrl = useMemo(() => {
    if (eventUrl) return eventUrl;
    if (provider === "polymarket" && eventSlug) return `https://polymarket.com/event/${eventSlug}`;
    const first = (initialMarkets && initialMarkets[0]) || null;
    if (first?.url) return first.url;
    if (provider === "polymarket" && first?.slug) return `https://polymarket.com/market/${first.slug}`;
    if (provider === "kalshi" && first?.ticker) return `https://kalshi.com/trade/${first.ticker}`;
    return undefined;
  }, [eventUrl, provider, eventSlug, initialMarkets]);

  const onToggle = useCallback(async () => {
    const next = !expanded;
    setExpanded(next);
    if (!next) return;
    if (markets && markets.length) return;

    if (haveAllInitial) {
      setMarkets(initialMarkets ?? []);
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const prefix = getBaseUrl();
      const asNum = Number(eventId);
      const body: any = {
        provider,
        normalized: true,
        with_nested_markets: true,
        event_ticker: eventTicker || eventId,
        id: !Number.isNaN(asNum) && Number.isFinite(asNum) ? asNum : undefined,
        slug: eventSlug || undefined,
      };
      const res = await fetch(`${prefix}/api/event`, { cache: "no-store", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const data: EventNormalized = payload?.data ?? payload; // normalized
      const mkts = Array.isArray(data?.markets) ? (data.markets as MarketNormalized[]) : [];
      setMarkets(mkts);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, [expanded, markets, haveAllInitial, initialMarkets, provider, eventTicker, eventSlug, eventId]);

  const showGrid = expanded && (loading || error || (markets?.length ?? (initialMarkets?.length ?? 0)) > 0);
  const items: MarketNormalized[] = markets ?? (haveAllInitial ? (initialMarkets ?? []) : []);

  const sortedItems = useMemo(() => {
    const norm = (v: unknown): number | null => {
      if (v == null) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      if (n >= 0 && n <= 1) return n;
      if (n > 1 && n <= 100) return n / 100;
      if (n > 100 && n <= 10000) return n / 10000;
      return Math.max(0, Math.min(1, n));
    };
    // Identify placeholder markets such as "Person A/B/C" and inactive/empty shells.
    // Regex matches questions/slugs like "... Person B ..." (case-insensitive)
    const isPlaceholder = (m: MarketNormalized): boolean => {
      const q = (m.question || "") + " " + (m.slug || "");
      if (/\bperson\s+[a-z]\b/i.test(q)) return true; // regex: catch Person A/B/C
      const vr = (m as any).vendor_raw || {};
      if (vr && (vr.active === false || vr.manualActivation === true)) return true;
      return false;
    };
    const score = (m: MarketNormalized): number => {
      const bid = norm(m.best_bid) ?? 0;
      const ask = norm(m.best_ask) ?? 0;
      return bid + ask;
    };
    const filtered = items.filter((m) => !isPlaceholder(m));
    return filtered.sort((a, b) => score(b) - score(a));
  }, [items]);

  return (
    <div className={`border rounded p-3 ${color.item}`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left"
      >
        <div className="font-medium">{title}</div>
        <div className="text-xs text-gray-600 flex items-center gap-2">
          <span>{displaySubtitle}</span>
          {providerUrl && (
            <a
              href={providerUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={`${color.accent} hover:underline inline-flex items-center gap-1`}
              title={`Open on ${provider === "kalshi" ? "Kalshi" : "Polymarket"}`}
            >
              Open on {provider === "kalshi" ? "Kalshi" : "Polymarket"} ↗
            </a>
          )}
        </div>
        <div className={`text-xs ${color.accent}`}>Submarkets: {typeof totalCount === "number" ? totalCount : (initialMarkets?.length ?? 0)}</div>
      </button>

      {showGrid && (
        <div className="mt-3">
          {loading && <div className="text-xs text-gray-600">Loading submarkets…</div>}
          {error && <div className="text-xs text-red-600">{error}</div>}
          {!loading && !error && (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              {sortedItems.map((m, i) => {
                const normProb = (v: unknown): number | null => {
                  if (v == null) return null;
                  const n = Number(v);
                  if (!Number.isFinite(n)) return null;
                  if (n >= 0 && n <= 1) return n;
                  if (n > 1 && n <= 100) return n / 100;
                  if (n > 100 && n <= 10000) return n / 10000;
                  return Math.max(0, Math.min(1, n));
                };
                const fmtCents = (v: unknown) => {
                  const p = normProb(v);
                  return p == null ? "-" : `${(p * 100).toFixed(1)}¢`;
                };
                const name = (m.question ?? m.slug ?? m.ticker ?? `Market ${i}`).toString();
                const bid = m.best_bid;
                const ask = m.best_ask;
                const last = m.last_price;
                const key = m.market_id || m.slug || m.ticker || String(i);
                const onOpenGraph = () => {
                  setGraph({ market: m, title: name });
                };
                return (
                  <button key={key} className="border rounded p-2 bg-white/40 text-left w-full hover:bg-white" onClick={onOpenGraph}>
                    <div className="text-sm font-medium truncate">{name}</div>
                    {m.ticker && <div className="text-[11px] text-gray-600 truncate">{m.ticker}</div>}
                    {m.slug && !m.ticker && <div className="text-[11px] text-gray-600 truncate">{m.slug}</div>}
                    <div className="text-[11px] text-gray-700 mt-1">Bid {fmtCents(bid)} · Ask {fmtCents(ask)} · Last {fmtCents(last)}</div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <GraphModal open={!!graph} market={graph?.market} title={graph?.title} onClose={() => setGraph(null)} />
    </div>
  );
}
