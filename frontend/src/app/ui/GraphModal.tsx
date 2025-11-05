"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import PriceChart, { type SeriesPoint } from "./PriceChart";
import OrderBookView from "./OrderBookView";
import { parseOrderbookLevels } from "./orderbook/parse";
import type { MarketNormalized } from "../types/normalized";
import { useHistory } from "./HistoryStore";
import { getBaseUrl, getWsUrl } from "../lib/config";
const BASE = getBaseUrl();

type ConnectionState = "disconnected" | "connecting" | "connected";

type WsEventEnvelope = {
  vendor?: string;
  event?: string;
  market?: string | null;
  ts?: number;
  data?: Record<string, unknown>;
};

const deriveWsUrl = () => getWsUrl();

export default function GraphModal({
  open,
  market,
  title,
  onClose,
}: {
  open: boolean;
  market?: MarketNormalized | null;
  title?: string;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"chart" | "orderbook">("chart");
  const [last, setLast] = useState<SeriesPoint[]>([]);
  const [bid, setBid] = useState<SeriesPoint[]>([]);
  const [ask, setAsk] = useState<SeriesPoint[]>([]);
  const [obBids, setObBids] = useState<Array<{ price: number; size?: number }>>([]);
  const [obAsks, setObAsks] = useState<Array<{ price: number; size?: number }>>([]);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [timeframe, setTimeframe] = useState<"24h" | "7d" | "30d">("24h");
  const [histInterval, setHistInterval] = useState<number | null>(null);
  const [wsState, setWsState] = useState<ConnectionState>("disconnected");
  const [wsError, setWsError] = useState<string>("");
  const [wsLastEvent, setWsLastEvent] = useState<WsEventEnvelope | null>(null);
  const [wsEventCount, setWsEventCount] = useState<number>(0);

  const wsRef = useRef<WebSocket | null>(null);
  const wsStateRef = useRef<ConnectionState>("disconnected");
  const wsHistoryIdRef = useRef<string | null>(null);
  const wsMessageCountRef = useRef<number>(0);
  const wsLastEventRef = useRef<WsEventEnvelope | null>(null);

  const { add, update } = useHistory();

  const wsUrl = useMemo(() => deriveWsUrl(), []);

  const bookRef = useRef<{ bids: Map<number, number>; asks: Map<number, number> } | null>(null);
  const applyBookUpdateRef = useRef<
    (update: { bids: Array<{ price: number; size?: number; delta?: number }>; asks: Array<{ price: number; size?: number; delta?: number }>; snapshot?: boolean }) => void
  >(() => {});

  const wsPayload = useMemo(() => {
    if (!market) return null;
    const provider = market.provider;
    if (!provider) return null;
    const payload: Record<string, unknown> = {
      type: "subscribe",
      provider,
      market: {
        provider,
      },
    };
    const m = payload.market as Record<string, unknown>;
    const assign = (key: string, value: unknown) => {
      if (value == null) return;
      if (typeof value === "string" && value.trim() === "") return;
      m[key] = value;
    };
    assign("ticker", market.ticker);
    assign("market_id", market.market_id);
    assign("vendor_market_id", market.vendor_market_id);
    assign("slug", market.slug);
    if (Object.keys(m).length <= 1) {
      return null;
    }
    return payload;
  }, [market]);

  const range = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    if (timeframe === "7d") {
      return { start: nowSec - 7 * 24 * 3600, end: nowSec, kInt: 3600, pInt: 14400 };
    }
    if (timeframe === "30d") {
      return { start: nowSec - 30 * 24 * 3600, end: nowSec, kInt: 14400, pInt: 86400 };
    }
    return { start: nowSec - 24 * 3600, end: nowSec, kInt: 300, pInt: 3600 };
  }, [timeframe]);

  const intervalForTimeframe = useMemo(() => {
    const vendor = market?.provider;
    if (vendor === "polymarket") {
      if (timeframe === "30d") return 86400;
      if (timeframe === "7d") return 14400;
      return 3600;
    }
    if (timeframe === "30d") return 14400;
    if (timeframe === "7d") return 3600;
    return 300;
  }, [timeframe, market?.provider]);

  const fetchOnce = useCallback(async () => {
    if (!open) return;
      try {
        setLoading(true);
        setError("");
        const url = `${BASE}/api/history`;
        const body = JSON.stringify({ provider: market?.provider, market, start: range.start, end: range.end, interval: intervalForTimeframe });
        const res = await fetch(url, { cache: "no-store", method: "POST", headers: { "content-type": "application/json" }, body });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        const pts = (payload?.points as any[]) || [];
        const rawSeries = pts
          .map((d) => ({ t: Number(d?.t) || 0, p: d?.p == null ? null : Number(d.p) }))
          .filter((d) => d.t > 0) as SeriesPoint[];
        const series = rawSeries
          .map((d) => ({ t: d.t, p: normProb(d.p) }))
          .filter((d) => d.p != null) as SeriesPoint[];
        setLast(series);
        setBid([]);
        setAsk([]);
        const iv = Number(payload?.interval);
        setHistInterval(Number.isFinite(iv) ? iv : intervalForTimeframe);
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setLoading(false);
      }
  }, [open, market, range, intervalForTimeframe]);

  const resetWsState = useCallback(() => {
    wsMessageCountRef.current = 0;
    wsLastEventRef.current = null;
    setWsError("");
    setWsEventCount(0);
    setWsLastEvent(null);
    wsHistoryIdRef.current = null;
  }, []);

  const disconnectWs = useCallback(() => {
    const socket = wsRef.current;
    if (!socket) return;
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "unsubscribe" }));
      }
      socket.close();
    } catch {}
    wsRef.current = null;
    wsStateRef.current = "disconnected";
    setWsState("disconnected");
  }, []);

  const handleWsMessage = useCallback(
    (event: MessageEvent<string>) => {
      wsMessageCountRef.current += 1;
      setWsEventCount(wsMessageCountRef.current);
      try {
        const parsed = JSON.parse(event.data) as WsEventEnvelope;
        wsLastEventRef.current = parsed;
        setWsLastEvent(parsed);

        if ((parsed?.event || "").toLowerCase() === "orderbook" && parsed?.vendor && parsed?.data) {
          try {
            const vendor = String(parsed.vendor).toLowerCase();
            if (vendor === "kalshi" || vendor === "polymarket") {
              const levels = parseOrderbookLevels(vendor as any, parsed.data);
              if (typeof applyBookUpdateRef.current === "function") {
                applyBookUpdateRef.current(levels);
              }
            }
          } catch (obErr) {
          }
        }
        if (wsHistoryIdRef.current) {
          update(wsHistoryIdRef.current, {
            summary: `WS ${market?.provider ?? "vendor"} (${wsMessageCountRef.current} events)`,
            meta: {
              lastEvent: parsed,
              totalEvents: wsMessageCountRef.current,
              location: "GraphModal",
            },
          });
        }
      } catch (err) {
        setWsError(`Failed to parse websocket event: ${(err as Error).message}`);
      }
    },
    [market?.provider, update],
  );

  const connectWs = useCallback(() => {
    if (wsStateRef.current !== "disconnected" || !wsPayload) return;
    resetWsState();
    try {
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;
      wsStateRef.current = "connecting";
      setWsState("connecting");

      socket.addEventListener("open", () => {
        wsStateRef.current = "connected";
        setWsState("connected");
        try {
          socket.send(JSON.stringify(wsPayload));
        } catch (sendErr) {
          setWsError(`Failed to send subscribe: ${(sendErr as Error).message}`);
        }
        wsHistoryIdRef.current = add({
          kind: "ws",
          summary: `WS subscribe · ${market?.provider ?? ""}`.trim(),
          method: "WS",
          url: wsUrl,
          meta: {
            payload: wsPayload,
            context: "GraphModal",
            market,
          },
        });
      });

      socket.addEventListener("message", handleWsMessage as EventListener);

      socket.addEventListener("error", (err) => {
        setWsError("WebSocket error");
        if (wsHistoryIdRef.current) {
          update(wsHistoryIdRef.current, {
            summary: "WS error",
            meta: {
              error: String(err),
              totalEvents: wsMessageCountRef.current,
            },
          });
        }
      });

      socket.addEventListener("close", (closeEvent) => {
        wsRef.current = null;
        const wasActive = wsStateRef.current !== "disconnected";
        wsStateRef.current = "disconnected";
        setWsState("disconnected");
        if (wasActive && wsHistoryIdRef.current) {
          update(wsHistoryIdRef.current, {
            summary: `WS closed (${wsMessageCountRef.current} events)`,
            meta: {
              lastEvent: wsLastEventRef.current,
              totalEvents: wsMessageCountRef.current,
              closeCode: closeEvent.code,
              closeReason: closeEvent.reason,
            },
          });
        }
        resetWsState();
      });
    } catch (err) {
      wsStateRef.current = "disconnected";
      setWsState("disconnected");
      setWsError(`Failed to open websocket: ${(err as Error).message}`);
      resetWsState();
    }
  }, [add, handleWsMessage, market, resetWsState, update, wsPayload, wsUrl]);

  useEffect(() => {
    return () => {
      if (wsRef.current) {
        disconnectWs();
      } else {
        resetWsState();
      }
    };
  }, [disconnectWs, resetWsState]);

  useEffect(() => {
    if (!open) {
      if (wsRef.current) {
        disconnectWs();
      } else {
        resetWsState();
      }
    }
  }, [disconnectWs, open, resetWsState]);

  useEffect(() => {
    if (wsStateRef.current !== "disconnected") {
      disconnectWs();
    } else {
      resetWsState();
    }
  }, [disconnectWs, market, resetWsState]);

  useEffect(() => {
    if (!open) return;
    // Single fetch on open for lightweight charts
    fetchOnce();
  }, [open, fetchOnce]);

  useEffect(() => {
    if (!open) return;
    // Refetch when timeframe changes
    fetchOnce();
  }, [timeframe, open, fetchOnce]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const onBeforeUnload = () => {
      const ws = wsRef.current;
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "unsubscribe" }));
        }
      } catch {}
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [open]);

  // Initialize/reset in-memory order book when modal opens or market changes
  useEffect(() => {
    if (!open) return;
    bookRef.current = { bids: new Map(), asks: new Map() };
    setObBids([]);
    setObAsks([]);
    return () => {
      bookRef.current = null;
    };
  }, [open, market]);

  // Define ref-backed mutation function to apply incoming orderbook snapshots/deltas
  useEffect(() => {
    const quantize = (p: number): number => Math.round(p * 10000) / 10000; // 1 bp precision
    applyBookUpdateRef.current = (update) => {
      const book = bookRef.current;
      if (!book) return;
      const { bids, asks, snapshot } = update || {};
      if (snapshot) {
        book.bids.clear();
        book.asks.clear();
      }
      // Apply bid updates
      if (Array.isArray(bids)) {
        for (const lvl of bids) {
          const price = typeof lvl?.price === "number" ? lvl.price : NaN;
          const size = typeof (lvl as any)?.size === "number" ? (lvl as any).size : NaN;
          const delta = typeof (lvl as any)?.delta === "number" ? (lvl as any).delta : NaN;
          if (!Number.isFinite(price)) continue;
          const p = quantize(price);
          if (Number.isFinite(delta)) {
            const has = book.bids.has(p);
            const prev = has ? (book.bids.get(p) as number) : 0;
            if (!has && delta < 0) {
              // Ignore negative delta for unknown level
              continue;
            }
            const next = prev + delta;
            if (next <= 0) book.bids.delete(p);
            else book.bids.set(p, next);
          } else if (Number.isFinite(size)) {
            if (size <= 0) book.bids.delete(p);
            else book.bids.set(p, size);
          }
        }
      }
      // Apply ask updates
      if (Array.isArray(asks)) {
        for (const lvl of asks) {
          const price = typeof lvl?.price === "number" ? lvl.price : NaN;
          const size = typeof (lvl as any)?.size === "number" ? (lvl as any).size : NaN;
          const delta = typeof (lvl as any)?.delta === "number" ? (lvl as any).delta : NaN;
          if (!Number.isFinite(price)) continue;
          const p = quantize(price);
          if (Number.isFinite(delta)) {
            const has = book.asks.has(p);
            const prev = has ? (book.asks.get(p) as number) : 0;
            if (!has && delta < 0) {
              // Ignore negative delta for unknown level
              continue;
            }
            const next = prev + delta;
            if (next <= 0) book.asks.delete(p);
            else book.asks.set(p, next);
          } else if (Number.isFinite(size)) {
            if (size <= 0) book.asks.delete(p);
            else book.asks.set(p, size);
          }
        }
      }

      // Derive top 10 per side for display
      const bidsTop = Array.from(book.bids.entries())
        .map(([price, size]) => ({ price, size }))
        .sort((a, b) => b.price - a.price)
        .slice(0, 10);
      const asksTop = Array.from(book.asks.entries())
        .map(([price, size]) => ({ price, size }))
        .sort((a, b) => a.price - b.price)
        .slice(0, 10);
      setObBids(bidsTop);
      setObAsks(asksTop);
    };
  }, []);

  // ------- Latest tick summary (derived) -------
  const lastTick = useMemo(() => {
    if (!Array.isArray(last) || last.length === 0) return null;
    return last[last.length - 1];
  }, [last]);

  const prevTick = useMemo(() => {
    if (!Array.isArray(last) || last.length < 2) return null;
    return last[last.length - 2];
  }, [last]);

  const snapshotBid = market?.best_bid ?? null;
  const snapshotAsk = market?.best_ask ?? null;

  // Normalize provider values to [0,1] (accept raw %, ¢, or bps-like values)
  const normProb = (v: unknown): number | null => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    if (n <= 1 && n >= 0) return n;               // already [0,1]
    if (n > 1 && n <= 100) return n / 100;        // percent (e.g., 93 → 0.93)
    if (n > 100 && n <= 10000) return n / 10000;  // bps or cents (e.g., 9300 → 0.93)
    // Fallback clamp to [0,1]
    return Math.max(0, Math.min(1, n));
  };

  const fmtPct = (v: number | null | undefined) => {
    const p = normProb(v);
    return p == null ? "-" : `${(p * 100).toFixed(1)}%`;
  };
  const fmtTs = (ms?: number) => (typeof ms === "number" && ms > 0 ? new Date(ms).toLocaleString() : "-");
  const deltaTxt = useMemo(() => {
    if (!lastTick || !prevTick) return null;
    const dv = Number(normProb(lastTick.p)) - Number(normProb(prevTick.p));
    const sign = dv > 0 ? "+" : dv < 0 ? "−" : "";
    return `${sign}${Math.abs(dv * 100).toFixed(1)} pp`;
  }, [lastTick, prevTick]);

  const effBidRaw = (bid.length ? bid[bid.length - 1]?.p : null) ?? snapshotBid ?? null;
  const effAskRaw = (ask.length ? ask[ask.length - 1]?.p : null) ?? snapshotAsk ?? null;
  const effBid = normProb(effBidRaw);
  const effAsk = normProb(effAskRaw);
  const spreadTxt = effBid != null && effAsk != null ? `${((effAsk - effBid) * 100).toFixed(1)} pp` : "-";

  const wsStatusColor = wsState === "connected" ? "bg-emerald-500" : wsState === "connecting" ? "bg-amber-500" : "bg-gray-300";
  const wsStatusLabel = wsState === "connected" ? "Live" : wsState === "connecting" ? "Connecting" : "Stopped";

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white rounded-xl border shadow-2xl w-full max-w-5xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-3 border-b bg-gradient-to-r from-indigo-600 via-purple-600 to-pink-600 text-white rounded-t-xl">
          <div className="text-sm font-medium truncate">{title || (market?.question || market?.slug || market?.ticker || market?.market_id)}</div>
          <button className="text-white/90 hover:text-white" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="p-5 overflow-auto">
          <div className="mb-4 inline-flex rounded-md shadow-sm border bg-white overflow-hidden" role="tablist" aria-label="Graph view selector">
            <button
              onClick={() => setActiveTab("chart")}
              className={`px-3 py-1.5 text-xs ${activeTab === "chart" ? "bg-indigo-600 text-white" : "hover:bg-gray-50"}`}
              role="tab"
              aria-selected={activeTab === "chart"}
            >
              Chart
            </button>
            <button
              onClick={() => setActiveTab("orderbook")}
              className={`px-3 py-1.5 text-xs border-l ${activeTab === "orderbook" ? "bg-indigo-600 text-white" : "hover:bg-gray-50"}`}
              role="tab"
              aria-selected={activeTab === "orderbook"}
            >
              Order Book
            </button>
          </div>

          {activeTab === "chart" ? (
            <PriceChart data={last} bid={bid} ask={ask} />
          ) : (
            <div>
              {wsState !== "connected" && (
                <div className="mb-2 text-xs text-gray-600">Start Live to stream the order book</div>
              )}
              <OrderBookView bids={obBids} asks={obAsks} />
            </div>
          )}
          {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
          {/* Latest tick summary */}
          <div className="mt-4 border rounded-lg bg-gray-50">
            <div className="px-3 py-2 border-b text-[11px] text-gray-600 flex items-center gap-2">
              <span className="font-semibold text-gray-700">Most Recent Tick</span>
              {histInterval ? <span className="text-gray-500">(interval {histInterval}s)</span> : null}
            </div>
            <div className="px-3 py-3 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-[11px] text-gray-500">Price</div>
                <div className="font-medium">{fmtPct(lastTick?.p ?? (market?.last_price ?? null))}</div>
                {deltaTxt && <div className="text-[11px] text-gray-500">Δ {deltaTxt}</div>}
              </div>
              <div>
                <div className="text-[11px] text-gray-500">Bid / Ask</div>
                <div className="font-medium">{fmtPct(effBid)} / {fmtPct(effAsk)}</div>
                <div className="text-[11px] text-gray-500">Spread {spreadTxt}</div>
              </div>
              <div>
                <div className="text-[11px] text-gray-500">Updated</div>
                <div className="font-medium">{fmtTs(lastTick?.t)}</div>
              </div>
              <div>
                <div className="text-[11px] text-gray-500">Market</div>
                <div className="font-medium truncate" title={market?.ticker || market?.slug || market?.market_id}>
                  {market?.ticker || market?.slug || market?.market_id}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="px-5 py-3 border-t bg-gray-50 rounded-b-xl">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-xs text-gray-600">
              <label htmlFor="tf" className="text-gray-600">Timeframe</label>
              <select id="tf" value={timeframe} onChange={(e) => setTimeframe(e.target.value as any)}
                className="border rounded px-2 py-1 text-xs bg-white hover:bg-gray-50">
                <option value="24h">24h</option>
                <option value="7d">7d</option>
                <option value="30d">30d</option>
              </select>
            </div>
            <div className="flex flex-col gap-2 text-xs text-gray-600 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${wsStatusColor}`} aria-hidden="true" />
                <span>{wsStatusLabel}</span>
                {wsEventCount > 0 && <span>Events {wsEventCount}</span>}
                {wsLastEvent?.event && <span>{wsLastEvent.event}</span>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={connectWs}
                  disabled={!wsPayload || wsState !== "disconnected"}
                  className="px-3 py-2 rounded text-xs border bg-white hover:bg-gray-50 disabled:opacity-60"
                >
                  Start Live
                </button>
                <button
                  onClick={() => {
                    disconnectWs();
                  }}
                  disabled={wsState === "disconnected"}
                  className="px-3 py-2 rounded text-xs border bg-white hover:bg-gray-50 disabled:opacity-60"
                >
                  Stop Live
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={fetchOnce}
                disabled={loading}
                className={`px-3 py-2 rounded text-sm border ${loading ? "bg-gray-100 text-gray-400" : "bg-white hover:bg-gray-50"}`}
              >
                {loading ? "Refreshing…" : "Refresh"}
              </button>
              <button onClick={onClose} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm">Close</button>
            </div>
          </div>
          {wsError && <div className="mt-2 text-xs text-red-600">{wsError}</div>}
        </div>
      </div>
    </div>
  );
}
