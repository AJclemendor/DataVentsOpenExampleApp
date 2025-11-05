"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useHistory } from "./HistoryStore";
import { getWsUrl } from "../lib/config";

type ConnectionState = "disconnected" | "connecting" | "connected";

type WsEventEnvelope = {
  vendor?: string;
  event?: string;
  market?: string | null;
  ts?: number;
  data?: Record<string, unknown>;
};

const deriveWsUrl = () => getWsUrl();

const DEFAULT_PAYLOAD = JSON.stringify(
  {
    type: "subscribe",
    provider: "kalshi",
    market: { provider: "kalshi", ticker: "KXNFLGAME-25NOV02KCBUF" },
  },
  null,
  2,
);

export default function DvWsPanel() {
  const wsRef = useRef<WebSocket | null>(null);
  const historyEntryId = useRef<string | null>(null);
  const messageCountRef = useRef(0);
  const stateRef = useRef<ConnectionState>("disconnected");
  const lastEventRef = useRef<WsEventEnvelope | null>(null);

  const { add, update } = useHistory();

  const [state, setState] = useState<ConnectionState>("disconnected");
  const [error, setError] = useState<string>("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [payload, setPayload] = useState<string>(DEFAULT_PAYLOAD);
  const [lastEvent, setLastEvent] = useState<WsEventEnvelope | null>(null);

  const wsUrl = useMemo(() => deriveWsUrl(), []);

  const reset = useCallback(() => {
    messageCountRef.current = 0;
    setLastEvent(null);
    lastEventRef.current = null;
    setError("");
    historyEntryId.current = null;
  }, []);

  const closeSocket = useCallback((opts?: { sendUnsubscribe?: boolean }) => {
    const ws = wsRef.current;
    if (!ws) return;
    if (opts?.sendUnsubscribe && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "unsubscribe" }));
      } catch {}
    }
    try {
      ws.close();
    } catch {}
    wsRef.current = null;
  }, []);

  const disconnect = useCallback(() => {
    closeSocket({ sendUnsubscribe: true });
    stateRef.current = "disconnected";
    setState("disconnected");
  }, [closeSocket]);

  const handleMessage = useCallback(
    (ev: MessageEvent<string>) => {
      messageCountRef.current += 1;
      try {
        const parsed = JSON.parse(ev.data) as WsEventEnvelope;
        lastEventRef.current = parsed;
        setLastEvent(parsed);
        if (historyEntryId.current) {
          update(historyEntryId.current, {
            summary: `WS stream ${parsed.vendor ?? "unknown"} (${messageCountRef.current} events)`,
            meta: {
              lastEvent: parsed,
              totalEvents: messageCountRef.current,
            },
          });
        }
      } catch (parseErr) {
        setError(`Failed to parse event: ${(parseErr as Error).message}`);
      }
    },
    [update],
  );

  const connect = useCallback(() => {
    if (state === "connecting" || state === "connected") {
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      setError(`Payload must be valid JSON: ${(err as Error).message}`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || parsed.type !== "subscribe") {
      setError("Payload must be a subscribe message object");
      return;
    }

    setError("");
    setState("connecting");
    stateRef.current = "connecting";
    messageCountRef.current = 0;
    setLastEvent(null);

    try {
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;

      socket.addEventListener("open", () => {
        setState("connected");
        stateRef.current = "connected";
        try {
          socket.send(JSON.stringify(parsed));
        } catch (sendErr) {
          setError(`Failed to send subscribe: ${(sendErr as Error).message}`);
        }

        const summaryParts: string[] = [];
        if (typeof parsed.provider === "string") {
          summaryParts.push(parsed.provider);
        }
        if (parsed?.market?.ticker) summaryParts.push(parsed.market.ticker);
        if (parsed?.market?.market_id) summaryParts.push(`market:${parsed.market.market_id}`);
        if (parsed?.market?.slug) summaryParts.push(`slug:${parsed.market.slug}`);
        const summarySuffix = summaryParts.filter(Boolean).join(" · ");
        historyEntryId.current = add({
          kind: "ws",
          summary: `WS subscribe${summarySuffix ? ` · ${summarySuffix}` : ""}`,
          method: "WS",
          url: wsUrl,
          meta: {
            payload: parsed,
            connectedAt: Date.now(),
          },
        });
      });

      socket.addEventListener("message", handleMessage as EventListener);

      socket.addEventListener("close", (ev) => {
        wsRef.current = null;
        const currentlyConnected = stateRef.current !== "disconnected";
        stateRef.current = "disconnected";
        setState("disconnected");
        if (currentlyConnected && historyEntryId.current) {
          update(historyEntryId.current, {
            summary: `WS closed (${messageCountRef.current} events)`,
            meta: {
              lastEvent: lastEventRef.current,
              totalEvents: messageCountRef.current,
              closeCode: ev.code,
              closeReason: ev.reason,
            },
          });
        }
      });

      socket.addEventListener("error", (err) => {
        setError("WebSocket error");
        if (historyEntryId.current) {
          update(historyEntryId.current, {
            summary: "WS error",
            meta: {
              error: String(err),
              totalEvents: messageCountRef.current,
            },
          });
        }
      });
    } catch (err) {
      setState("disconnected");
      stateRef.current = "disconnected";
      setError(`Failed to open websocket: ${(err as Error).message}`);
      reset();
    }
  }, [add, handleMessage, lastEvent, payload, reset, state, update, wsUrl]);

  useEffect(() => {
    return () => {
      closeSocket();
    };
  }, [closeSocket]);

  const statusColor = state === "connected" ? "bg-emerald-500" : state === "connecting" ? "bg-amber-500" : "bg-gray-300";
  const statusLabel = state === "connected" ? "Connected" : state === "connecting" ? "Connecting" : "Disconnected";

  return (
    <div className="relative">
      <button
        type="button"
        className="text-xs px-2 py-1 border rounded hover:bg-gray-50 flex items-center gap-1"
        onClick={() => setPanelOpen((v) => !v)}
        aria-expanded={panelOpen}
      >
        <span className={`inline-block h-2 w-2 rounded-full ${statusColor}`} aria-hidden="true" />
        <span>DV WS · {statusLabel}</span>
      </button>

      {panelOpen && (
        <div className="absolute right-0 mt-2 w-80 rounded-xl border bg-white shadow-lg z-50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500">DV WebSocket</h3>
            <button
              type="button"
              className="text-[11px] text-gray-500 hover:text-gray-900"
              onClick={() => {
                setPanelOpen(false);
              }}
            >
              Close
            </button>
          </div>
          <div className="text-xs text-gray-500 break-all">URL: {wsUrl}</div>
          <label className="block text-xs font-medium text-gray-700">
            Subscribe Payload (JSON)
            <textarea
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              rows={6}
              spellCheck={false}
              className="mt-1 w-full rounded-lg border border-gray-300 px-2 py-1 text-xs font-mono"
              disabled={state === "connected" || state === "connecting"}
            />
          </label>
          <div className="flex items-center justify-between">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg bg-black px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-black/90 disabled:opacity-60"
              onClick={connect}
              disabled={state !== "disconnected"}
            >
              Connect
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              onClick={() => {
                disconnect();
                reset();
              }}
              disabled={state !== "connected" && state !== "connecting"}
            >
              Disconnect
            </button>
          </div>
          {error && <div className="text-xs text-red-600" role="alert">{error}</div>}
          {lastEvent && (
            <div className="text-xs text-gray-600 space-y-1">
              <div className="font-semibold">Last Event</div>
              <pre className="max-h-40 overflow-auto rounded border bg-gray-50 p-2 text-[11px]">
                {JSON.stringify(lastEvent, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

