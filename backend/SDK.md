# DataVents Python SDK (OSS draft)

This repo already contains a usable, provider‑agnostic Python client that unifies public Kalshi and Polymarket data calls and streaming. This document inventories the calls you can make with the DV client — in both raw provider shape and normalized shape — and outlines suggested cleanup before open‑sourcing.

The code lives under `backend/src` and exposes two main surfaces:
- `datavents_client`: REST helpers + normalization models/utilities
- `src/client/dv`: WebSocket client that multiplexes vendors


## Quick Start

- Import the unified client and enums from `datavents_client`.
- For normalized output, pass raw payloads to helpers in `datavents_client.normalize` and use types in `datavents_client.schemas`.

```python
from datavents_client import (
    DataVentsNoAuthClient,
    DataVentsProviders,
    DataVentsOrderSortParams,
    DataVentsStatusParams,
)
from datavents_client.normalize import normalize_search_response, normalize_event, normalize_market
from datavents_client.schemas import Provider

dv = DataVentsNoAuthClient()

# Raw provider responses (Kalshi example)
raw = dv.search_events(
    provider=DataVentsProviders.KALSHI,
    query="election",
    limit=5,
    page=1,
    order_sort_params=DataVentsOrderSortParams.ORDER_BY_TRENDING,
    status_params=DataVentsStatusParams.OPEN_MARKETS,
)

# Normalize those results into typed models
kalshi_raw = raw[0]["data"]
norm = normalize_search_response(Provider.kalshi, kalshi_raw, q="election", page=1, limit=5)
```


## REST: Unified DV Client (raw)

All methods return a list of provider‑tagged objects: `[{"provider": "kalshi|polymarket", "data": <raw dict>}, ...]`. When `provider=ALL`, calls are executed in parallel and both entries are returned.

- `DataVentsNoAuthClient.search_events(provider, query, limit, page, order_sort_params, status_params, **params)`
  - Providers: `KALSHI | POLYMARKET | ALL`
  - Shared params: `query` (string), `limit` (1–50), `page` (1+)
  - Sort/status: use `DataVentsOrderSortParams.*` and `DataVentsStatusParams.*`
  - Extras via `**params`:
    - `kalshi_params={"scope": "series|events", "excluded_categories": ["Sports", ...], ...}`
    - `polymarket_params={...}` (forwarded to public search)

- `DataVentsNoAuthClient.list_events(provider, limit=50, page=0, status_params=..., series_ticker="", with_nested_markets=False, with_milestones=False, query="", order_sort_params=...)`
  - Uses provider search under the hood; keeps inputs simple and stable.

- `DataVentsNoAuthClient.get_event(provider, kalshi_event_ticker=None, polymarket_id=None, polymarket_slug=None, *, with_nested_markets=False, include_chat=False, include_template=False)`
  - One identifier per provider is required (see signature).

- `DataVentsNoAuthClient.list_markets(provider, limit=50, page=0, status_params=..., query="", order_sort_params=..., event_ticker="", series_ticker="")`
  - Kalshi path returns events (with nested markets) from search; Polymarket path returns/derives a top‑level `markets` list.

- `DataVentsNoAuthClient.get_market(provider, kalshi_ticker=None, polymarket_id=None, polymarket_slug=None, *, include_tag=False)`
  - One identifier per provider is required (see signature).

- Provider‑specific helpers (raw only):
  - `DataVentsNoAuthClient.get_event_metadata(event_ticker: str)` → Kalshi only
  - `DataVentsNoAuthClient.get_event_tags(event_id: int)` → Polymarket only
  - `DataVentsNoAuthClient.get_market_tags(market_id: int)` → Polymarket only


## REST: Normalizing Results

Use helpers to convert raw provider payloads into typed, cross‑vendor models. Models and enums live in `datavents_client.schemas`.

- Search (events/series):
  - `normalize_search_response(provider: Provider, raw: dict, *, q, order, status, page, limit, exclude_sports=False, kalshi_scope=None) -> SearchResponseNormalized`
    - `SearchResponseNormalized.results` is a list of `Event | Market | Series` depending on provider/scope.

- Entities:
  - `normalize_event(provider: Provider, raw: dict) -> Event`
  - `normalize_market(provider: Provider, raw: dict) -> Market`

Key schema types (import from `datavents_client.schemas`):
- `Provider` (`"kalshi" | "polymarket"`)
- `StatusNormalized` (`open | closed | settled | upcoming | unknown`)
- `OrderSort`, `StatusFilter`, `SearchScopeKalshi`
- Models: `Event`, `Market`, `Series`, `SearchResponseNormalized`, `MarketHistoryResponseNormalized`, etc.

Example — normalize a market:

```python
from datavents_client.normalize import normalize_market
from datavents_client.schemas import Provider

raw_market = dv.get_market(provider=DataVentsProviders.POLYMARKET, polymarket_slug="some-market")[0]["data"]
market = normalize_market(Provider.polymarket, raw_market)
print(market.provider, market.market_id, market.status)
```


## HTTP API (optional service)

There is a small Flask app exposing HTTP routes with a `normalized=1` flag for the same shapes. See `backend/src/api/flask_app.py`:
- `GET /api/health`
- `GET /api/search` (query params align to the client enums)
- `GET /api/event` and `POST /api/event`
- `GET /api/market`
- `GET /api/market/history` and `POST /api/history` (provider‑specific history resolution normalizes to `MarketHistoryResponseNormalized`)


## WebSockets: Unified DV WS Client

Use the DV WS client to subscribe to Kalshi and/or Polymarket streams with a single subscription structure. Location: `backend/src/client/dv/ws_client.py`.

```python
import asyncio
from src.client.dv.ws_client import DvWsClient, DvVendors, DvSubscription, NormalizedEvent

async def on_event(evt: NormalizedEvent):
    print(evt.vendor, evt.event, evt.market, evt.received_ts)

sub = DvSubscription(
    vendors=(DvVendors.KALSHI, DvVendors.POLYMARKET),
    tickers_or_ids=["KXEXAMPLE-25NOV01HELLO", "0xclob_token_id_here"],
    kalshi_channels=("ticker", "orderbook_delta", "trade"),
)

await DvWsClient().run(sub, on_event)
```

Types:
- `DvSubscription`: vendors, cross‑vendor `tickers_or_ids`, or per‑vendor `kalshi_market_tickers` / `polymarket_assets_ids`. Optional `kalshi_event_tickers` will expand to market tickers via Kalshi REST if credentials are present.
- `NormalizedEvent`: `{ vendor, event: "ticker|orderbook|trade|raw", market: str|None, data: dict, received_ts }`.

Auth/env for WS:
- Kalshi requires `KALSHI_API_KEY` and `KALSHI_PRIVATE_KEY` (or `*_PAPER` for paper) in the environment. See `backend/examples/kalshi_ws_example.py`.
- Polymarket public WS path in this client uses no auth for market data.

Examples: `backend/examples/README.dv_ws.md`, `backend/examples/dv_ws_example.py`.


## Call Reference (at a glance)

- Search
  - Raw: `DataVentsNoAuthClient.search_events(...) -> [{provider, data}]`
  - Normalized: `normalize_search_response(provider, raw, ...) -> SearchResponseNormalized`

- Events
  - Raw: `list_events(...)`, `get_event(...)`
  - Normalized: `normalize_event(provider, raw) -> Event`

- Markets
  - Raw: `list_markets(...)`, `get_market(...)`
  - Normalized: `normalize_market(provider, raw) -> Market`

- Provider extras (raw)
  - Kalshi: `get_event_metadata(event_ticker)`
  - Polymarket: `get_event_tags(event_id)`, `get_market_tags(market_id)`

- Streaming
  - `DvWsClient.run(DvSubscription, on_event)` → emits `NormalizedEvent`


## Known Behaviors and Limits

- Kalshi series search does not support status filtering. The HTTP service applies a server‑side filter to normalized results when a non‑ALL status is requested.
- `list_markets` for Kalshi returns event search payloads containing nested markets; extract and normalize with `normalize_market`.
- Numeric timestamps are normalized to epoch milliseconds in normalized models; provider raw shapes vary.


## Pre‑OSS Cleanup and Additions (recommended)

High‑impact fixes before publishing:
- Package layout and name
  - Promote `datavents_client` (and `client/dv`) into a top‑level package (e.g., `datavents`) with a src‑layout and proper packaging metadata. Project name is `datavents-open-example-app` in this repo.
  - Replace absolute `src.client...` imports with package‑relative imports.

- Public API polish
  - Add a `DataVentsClient` that returns normalized types directly (wrapping today’s `NoAuthClient` + `normalize.*`).
  - Unify duplicate enums: prefer `schemas.OrderSort`/`StatusFilter` everywhere; deprecate `DataVentsOrderSortParams`/`DataVentsStatusParams`.
  - Tighten docstrings (remove TODOs/typos), especially in `noauth_client.py` (search_events docstring) and ensure param docs match behavior.

- Credentials and secrets
  - Remove committed key files (`backend/API-OSS.key`, `backend/API-PAPER.key`) and ensure `.gitignore` covers them.
  - Document env vars clearly for Kalshi/Polymarket WS and any future authenticated REST.

- DX, testing, and CI
  - Add `ruff` + `black` + `mypy` config; run in CI.
  - Split live integration tests from unit tests; guard live tests behind an env flag and record‐replay or mocks by default.
  - Add minimal examples showing raw vs normalized for each method (REST + WS) in a `/examples` or `/docs` folder.

- Stability and ergonomics
  - Introduce provider‑agnostic error types and timeouts/retry policy.
  - Offer async variants (e.g., `httpx`) for higher throughput; keep sync API for simplicity.
  - Add a simple caching layer (optional) for search/list to lower provider load/rate‑limits.
  - Expose normalized WS envelopes as Pydantic models (`WsEnvelope`) instead of the ad‑hoc dataclass to align REST/WS typing.

- Docs and governance
  - Create `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE` (MIT or Apache‑2.0) and a changelog. Include a clear versioning policy for normalized schema (`version: "v1"` appears in responses).


## File Pointers

- Unified REST client: `backend/src/datavents_client/noauth_client.py`
- Normalization helpers: `backend/src/datavents_client/normalize.py`
- Normalized schemas and enums: `backend/src/datavents_client/schemas.py`
- Unified WS client: `backend/src/client/dv/ws_client.py`
- HTTP facade (optional): `backend/src/api/flask_app.py`
- WS examples: `backend/examples/README.dv_ws.md`
