export type Level = { price: number; size?: number; delta?: number };

function normProb(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 1 && n >= 0) return n;
  if (n > 1 && n <= 100) return n / 100;
  if (n > 100 && n <= 10000) return n / 10000;
  return Math.max(0, Math.min(1, n));
}

function getDataBlock(raw: any): any {
  try {
    if (raw && typeof raw === "object") {
      if (raw.data && typeof raw.data === "object") return raw.data;
      if (raw.msg && typeof raw.msg === "object") return raw.msg;
    }
  } catch {}
  return raw;
}

function coerceLevelFromArray(arr: any[]): Level | null {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const price = normProb(arr[0]);
  const sizeVal = Number(arr[1]);
  const size = Number.isFinite(sizeVal) ? sizeVal : undefined;
  if (price == null) return null;
  return { price, size };
}

function coerceLevelFromObject(obj: Record<string, any>): Level | null {
  if (!obj || typeof obj !== "object") return null;
  const price = normProb(obj.price ?? obj.yes_price ?? obj.p ?? obj.level);
  const sizeVal = Number(
    obj.size ?? obj.quantity ?? obj.qty ?? obj.q ?? obj.available ?? obj.amount,
  );
  const size = Number.isFinite(sizeVal) ? sizeVal : undefined;
  if (price == null) return null;
  return { price, size };
}

function parseSideValue(delta: any): "bid" | "ask" | null {
  if (typeof delta?.is_bid === "boolean") return delta.is_bid ? "bid" : "ask";
  if (typeof delta?.isBuy === "boolean") return delta.isBuy ? "bid" : "ask";
  const s = String(delta?.side || delta?.s || "").trim().toLowerCase();
  if (!s) return null;
  if (s === "bid" || s === "buy" || s === "b") return "bid";
  if (s === "ask" || s === "sell" || s === "s") return "ask";
  return null;
}

export function parseOrderbookLevels(
  vendor: "kalshi" | "polymarket",
  raw: any,
): { bids: Level[]; asks: Level[]; snapshot?: boolean } {
  const data = getDataBlock(raw);

  const ob = ((): any => {
    if (data && typeof data === "object") {
      if (data.orderbook && typeof data.orderbook === "object") return data.orderbook;
      if (data.book && typeof data.book === "object") return data.book;
    }
    return data;
  })();

  const bidsOut: Level[] = [];
  const asksOut: Level[] = [];

  const trySnapshot = (obj: any): boolean => {
    if (!obj || typeof obj !== "object") return false;
    const hasB = Array.isArray(obj.bids);
    const hasA = Array.isArray(obj.asks);
    if (!hasB && !hasA) return false;

    if (hasB) {
      for (const it of obj.bids as any[]) {
        if (Array.isArray(it)) {
          const lvl = coerceLevelFromArray(it);
          if (lvl) bidsOut.push(lvl);
        } else if (it && typeof it === "object") {
          const lvl = coerceLevelFromObject(it);
          if (lvl) bidsOut.push(lvl);
        }
      }
    }
    if (hasA) {
      for (const it of obj.asks as any[]) {
        if (Array.isArray(it)) {
          const lvl = coerceLevelFromArray(it);
          if (lvl) asksOut.push(lvl);
        } else if (it && typeof it === "object") {
          const lvl = coerceLevelFromObject(it);
          if (lvl) asksOut.push(lvl);
        }
      }
    }
    return true;
  };

  if (trySnapshot(ob)) {
    return { bids: bidsOut, asks: asksOut, snapshot: true };
  }

  const updates: any[] =
    (Array.isArray((data as any)?.deltas) && (data as any).deltas) ||
    (Array.isArray((data as any)?.updates) && (data as any).updates) ||
    (Array.isArray((data as any)?.changes) && (data as any).changes) ||
    (Array.isArray((data as any)?.delta) && (data as any).delta) ||
    [];

  if (updates.length > 0) {
    for (const u of updates) {
      if (!u || typeof u !== "object") continue;
      const side = parseSideValue(u);
      const price = normProb(u.price ?? u.yes_price ?? u.p ?? u.level);
      let size = Number(u.size ?? u.quantity ?? u.qty ?? u.q ?? u.available ?? u.amount);
      const action = String(u.action || u.op || "").toLowerCase();
      if (!Number.isFinite(size)) size = NaN;
      if (action === "delete" || action === "remove") size = 0;
      if (price == null || !side) continue;
      const lvl: Level = Number.isFinite(size) ? { price, size } : { price };
      if (side === "bid") bidsOut.push(lvl);
      else asksOut.push(lvl);
    }
    return { bids: bidsOut, asks: asksOut, snapshot: false };
  }

  if (
    vendor === "kalshi" &&
    data &&
    typeof (data as any).price !== "undefined" &&
    typeof (data as any).delta === "number"
  ) {
    const price = normProb((data as any).price);
    const deltaVal = Number((data as any).delta);
    const sideRaw = String((data as any).side || "").toLowerCase();
    if (price != null && Number.isFinite(deltaVal)) {
      const lvl: Level = { price, delta: deltaVal };
      if (sideRaw === "yes") {
        bidsOut.push(lvl);
      } else if (sideRaw === "no") {
        asksOut.push(lvl);
      } else {
        // Fallback: unknown side → treat as bid update to ensure visibility
        bidsOut.push(lvl);
      }
      return { bids: bidsOut, asks: asksOut, snapshot: false };
    }
  }

  return { bids: [], asks: [], snapshot: false };
}

