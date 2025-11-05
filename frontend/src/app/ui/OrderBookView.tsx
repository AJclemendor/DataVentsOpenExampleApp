"use client";

import React, { useMemo } from "react";

export type OrderBookLevel = { price: number; size?: number };

function formatCents(prob: number | null | undefined): string {
  if (prob == null || !Number.isFinite(prob)) return "-";
  return `${(prob * 100).toFixed(1)}¢`;
}

function formatSize(size: number | null | undefined): string {
  if (size == null || !Number.isFinite(size)) return "-";
  return String(size);
}

export default function OrderBookView({
  bids,
  asks,
}: {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}) {
  const topBids = useMemo(() => {
    const sorted = [...(bids || [])].filter(Boolean).sort((a, b) => b.price - a.price);
    return sorted.slice(0, 10);
  }, [bids]);

  const topAsks = useMemo(() => {
    const sorted = [...(asks || [])].filter(Boolean).sort((a, b) => a.price - b.price);
    return sorted.slice(0, 10);
  }, [asks]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="border rounded-lg overflow-hidden">
        <div className="px-3 py-2 text-xs font-semibold text-green-700 bg-green-50 border-b">Bids</div>
        <div className="divide-y">
          {topBids.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-500">No bids</div>
          ) : (
            topBids.map((lvl, idx) => (
              <div key={`bid-${idx}-${lvl.price}`} className="px-3 py-2 text-sm flex items-center justify-between">
                <div className="font-medium text-green-700">{formatCents(lvl.price)}</div>
                <div className="text-gray-600 text-xs">{formatSize(lvl.size)}</div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="border rounded-lg overflow-hidden">
        <div className="px-3 py-2 text-xs font-semibold text-red-700 bg-red-50 border-b">Asks</div>
        <div className="divide-y">
          {topAsks.length === 0 ? (
            <div className="px-3 py-3 text-xs text-gray-500">No asks</div>
          ) : (
            topAsks.map((lvl, idx) => (
              <div key={`ask-${idx}-${lvl.price}`} className="px-3 py-2 text-sm flex items-center justify-between">
                <div className="font-medium text-red-700">{formatCents(lvl.price)}</div>
                <div className="text-gray-600 text-xs">{formatSize(lvl.size)}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}


