export type Provider = "kalshi" | "polymarket";

export interface OutcomeNormalized {
  outcome_id?: string;
  name?: string;
  side?: "yes" | "no";
  price?: number | null;
  best_bid?: number | null;
  best_ask?: number | null;
}

export interface MarketNormalized {
  provider: Provider;
  entity: "market";
  market_id: string;
  url?: string | null;
  slug?: string | null;
  ticker?: string | null;
  question?: string | null;
  best_bid?: number | null;
  best_ask?: number | null;
  last_price?: number | null;
  mid_price?: number | null;
  outcomes?: OutcomeNormalized[];
  vendor_market_id?: string | null;
  vendor_fields?: Record<string, any>;
  vendor_raw?: any;
}

export interface EventNormalized {
  provider: Provider;
  entity: "event";
  event_id: string;
  url?: string | null;
  slug?: string | null;
  event_ticker?: string | null; // kalshi
  title?: string | null;
  markets?: MarketNormalized[] | null;
  markets_count?: number | null;
}

export interface SearchResponseNormalized {
  results: Array<EventNormalized | MarketNormalized>;
  meta: {
    provider: Provider | "all";
    page: number;
    limit: number;
    // Optional fields returned by backend for richer client UX
    status?: string;
    order?: string;
    exclude_sports?: boolean;
    kalshi_scope?: "series" | "events" | null;
  };
}
