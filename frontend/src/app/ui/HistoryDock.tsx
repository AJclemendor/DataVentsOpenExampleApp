"use client";

import { useState, useEffect } from "react";
import { useHistory, type HistoryEntry } from "./HistoryStore";

function HistoryModal({ entry, onClose }: { entry: HistoryEntry; onClose: () => void }) {
  useEffect(() => {
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const parseUrlParams = (url?: string) => {
    if (!url) return null;
    try {
      let urlObj: URL;
      if (url.startsWith("http://") || url.startsWith("https://")) {
        urlObj = new URL(url);
      } else {
        urlObj = new URL(url, window.location.origin);
      }
      const params: Record<string, string> = {};
      urlObj.searchParams.forEach((value, key) => {
        params[key] = value;
      });
      return params;
    } catch {
      try {
        const parts = url.split("?");
        if (parts.length < 2) return null;
        const params: Record<string, string> = {};
        parts[1].split("&").forEach((param) => {
          const [key, value] = param.split("=");
          if (key) params[key] = decodeURIComponent(value || "");
        });
        return params;
      } catch {
        return null;
      }
    }
  };

  const formatSummary = (summary: string) => {
    if (entry.kind === "search") {
      const parts = summary.split(" · ");
      const searchPart = parts[0];
      const rest = parts.slice(1);
      
      return { searchQuery: searchPart.replace(/^Search: "/, "").replace(/"$/, ""), tags: rest };
    }
    return null;
  };

  const urlParams = parseUrlParams(entry.url);
  const summaryParts = formatSummary(entry.summary);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white rounded-xl shadow-2xl border max-w-4xl w-full max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between p-6 border-b bg-gradient-to-r from-sky-600 to-cyan-600 text-white rounded-t-xl">
          <h2 className="text-lg font-semibold">Request Details</h2>
          <button
            onClick={onClose}
            className="text-white/90 hover:text-white text-2xl leading-none"
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <div className="p-6 space-y-4">
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">ID</div>
            <div className="text-sm font-mono text-gray-900">{entry.id}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Timestamp</div>
            <div className="text-sm text-gray-900">{new Date(entry.ts).toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Kind</div>
            <div className="text-sm text-gray-900 capitalize">{entry.kind}</div>
          </div>
          {entry.provider && (
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Provider</div>
              <div className="text-sm text-gray-900 capitalize">{entry.provider}</div>
            </div>
          )}
          {entry.method && (
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Method</div>
              <div className="text-sm font-mono text-gray-900">{entry.method}</div>
            </div>
          )}
          {entry.url && (
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">URL</div>
              <div className="text-sm font-mono text-gray-900 break-all bg-gray-50 px-2 py-1 rounded">{entry.url}</div>
            </div>
          )}
          {urlParams && Object.keys(urlParams).length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Parameters</div>
              <div className="space-y-1.5">
                {Object.entries(urlParams).map(([key, value]) => (
                  <div key={key} className="flex items-start gap-2 text-sm">
                    <span className="font-mono font-semibold text-gray-700 min-w-[80px]">{key}:</span>
                    <span className="text-gray-900 break-all">{decodeURIComponent(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Summary</div>
            {summaryParts ? (
              <div className="space-y-2">
                <div className="text-sm font-medium text-gray-900">"{summaryParts.searchQuery}"</div>
                {summaryParts.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {summaryParts.tags.map((tag, idx) => (
                      <span
                        key={idx}
                        className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm text-gray-900">{entry.summary}</div>
            )}
          </div>
          {entry.meta && Object.keys(entry.meta).length > 0 && (
            <div>
              <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Metadata</div>
              <pre className="text-xs bg-gray-50 border rounded p-3 overflow-auto max-h-64">
                {JSON.stringify(entry.meta, null, 2)}
              </pre>
            </div>
          )}
        </div>
        <div className="p-6 border-t flex justify-end bg-gray-50 rounded-b-xl">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-sky-600 hover:bg-sky-700 text-white rounded text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function InnerDock() {
  const { entries, clear } = useHistory();
  const [collapsed, setCollapsed] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<HistoryEntry | null>(null);

  const items = entries.slice(0, 50);

  return (
    <>
      {selectedEntry && (
        <HistoryModal entry={selectedEntry} onClose={() => setSelectedEntry(null)} />
      )}
      <aside className={`w-80 border-l bg-white h-[calc(100vh-var(--nav-h))] sticky top-[var(--nav-h)] flex flex-col ${collapsed ? "translate-x-72" : ""} transition-transform duration-200 ease-out z-20`}
        aria-label="Request history">
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <div className="text-sm font-medium">History</div>
          <div className="flex items-center gap-2">
            <button
              className="text-xs text-gray-600 hover:text-gray-900"
              onClick={() => clear()}
              title="Clear history"
            >
              Clear
            </button>
            <button
              className="text-xs text-gray-600 hover:text-gray-900"
              onClick={() => setCollapsed((v) => !v)}
              title={collapsed ? "Expand" : "Collapse"}
            >
              {collapsed ? "←" : "→"}
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {items.length === 0 ? (
            <div className="p-4 text-xs text-gray-500">No requests yet.</div>
          ) : (
            <ul className="divide-y">
              {items.map((e) => (
                <li
                  key={e.id}
                  className="px-4 py-3 hover:bg-transparent cursor-pointer transition-colors"
                  onClick={() => setSelectedEntry(e)}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] uppercase tracking-wide text-gray-500">{e.kind}</span>
                    <span className="text-[11px] text-gray-400">{new Date(e.ts).toLocaleTimeString()}</span>
                  </div>
                  <div className="mt-1 text-sm leading-snug truncate" title={e.summary}>{e.summary}</div>
                  {e.url && (
                    <div className="mt-1 text-[11px] text-gray-500 truncate" title={e.url}>{e.method ?? ""} {e.url}</div>
                  )}
                  {e.provider && (
                    <div className="mt-1 text-[11px] text-gray-500">{e.provider}</div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

export default function HistoryDock() {
  return <InnerDock />;
}
