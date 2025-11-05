from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from typing import Any, Dict, Iterable, List, Optional, Sequence

from flask import Flask, Response, g, jsonify, request
from flask_cors import CORS
from flask_sock import Sock
import logging

from datavents import (
    DataVentsNoAuthClient,
    DataVentsOrderSortParams,
    DataVentsProviders,
    DataVentsStatusParams,
    normalize_search_response,
    normalize_event,
    normalize_market,
    normalize_market_history,
    EventResponseNormalized,
    MarketResponseNormalized,
    SearchResponseNormalized,
)
from datavents import Provider as ProviderEnum
from datavents import SearchScopeKalshi as _SearchScopeKalshi
from simple_websocket import ConnectionClosed
from datavents import DvSubscription, DvVendors, DvWsClient, NormalizedEvent
from datavents import provider_from_param as _provider_from_param
from datavents import (
    dedupe_preserve as _sdk_dedupe_preserve,
    coerce_string_list as _sdk_coerce_string_list,
    collect_strings as _sdk_collect_strings,
    first_int as _sdk_first_int,
    first_str as _sdk_first_str,
    find_polymarket_asset_ids as _sdk_find_poly_ids,
    _resolve_polymarket_assets_ids as _sdk_resolve_poly_ids,
    extract_vendors as _sdk_extract_vendors,
    json_default as _sdk_json_default,
    event_payload as _sdk_event_payload,
)
from datavents import enum_from_param as _sdk_enum_from_param
_LOG_LEVEL = os.getenv("DV_LOG_LEVEL", "INFO").upper()
logging.basicConfig(
    level=getattr(logging, _LOG_LEVEL, logging.INFO),
    format='%(asctime)s %(levelname)s %(name)s %(message)s'
)
logger = logging.getLogger("datavents.api")

app = Flask(__name__)
sock = Sock(app)
CORS(app, resources={r"/api/*": {"origins": "*"}})


def _providers(value: str) -> DataVentsProviders:
    return _provider_from_param(value, default=DataVentsProviders.ALL)


def _enum_from_param(value: str, enum_cls, default):
    aliases = None
    try:
        if enum_cls is DataVentsOrderSortParams:
            aliases = {}
            for item in enum_cls:
                name = item.name
                suffix = name[len("ORDER_BY_"):] if name.startswith("ORDER_BY_") else name
                aliases[suffix.lower()] = item
        elif enum_cls is DataVentsStatusParams:
            aliases = {
                "open": DataVentsStatusParams.OPEN_MARKETS,
                "closed": DataVentsStatusParams.CLOSED_MARKETS,
                "all": DataVentsStatusParams.ALL_MARKETS,
            }
    except Exception:
        aliases = None
    return _sdk_enum_from_param(value, enum_cls, aliases=aliases, default=default)


class SubscriptionError(Exception):
    def __init__(self, message: str, *, details: Optional[Dict[str, Any]] = None) -> None:
        super().__init__(message)
        self.details = details or {}


def _dedupe_preserve(items: Iterable[str]) -> List[str]:
    return _sdk_dedupe_preserve(items)


def _coerce_string_list(value: Any) -> List[str]:
    return _sdk_coerce_string_list(value)


def _collect_strings(source: Optional[Dict[str, Any]], keys: Sequence[str]) -> List[str]:
    return _sdk_collect_strings(source, keys)


def _first_int(keys: Sequence[str], *sources: Optional[Dict[str, Any]]) -> Optional[int]:
    return _sdk_first_int(keys, *sources)


def _first_str(keys: Sequence[str], *sources: Optional[Dict[str, Any]]) -> Optional[str]:
    return _sdk_first_str(keys, *sources)


def _find_clob_ids_any(obj: Any) -> List[str]:
    return _sdk_find_poly_ids(obj)


def _resolve_polymarket_assets_ids(
    payload: Dict[str, Any],
    market: Dict[str, Any],
    client: DataVentsNoAuthClient,
) -> List[str]:
    return _sdk_resolve_poly_ids(payload, market, client)


def _extract_vendors(payload: Dict[str, Any]) -> List[DvVendors]:
    tokens: List[str] = []

    provider_val = payload.get("provider")
    tokens.extend(_coerce_string_list(provider_val))
    tokens.extend(_coerce_string_list(payload.get("vendors")))

    market = payload.get("market")
    if isinstance(market, dict):
        tokens.extend(_coerce_string_list(market.get("provider")))

    if any(str(tok).strip().lower() in {"all", "both", "*"} for tok in tokens):
        return [DvVendors.KALSHI, DvVendors.POLYMARKET]

    vendors: List[DvVendors] = []
    for token in tokens:
        t = str(token).strip().lower()
        if not t:
            continue
        try:
            vendor = DvVendors(t)
        except ValueError:
            continue
        if vendor not in vendors:
            vendors.append(vendor)
    return vendors


def _build_subscription(payload: Dict[str, Any], client: DataVentsNoAuthClient) -> DvSubscription:
    if not isinstance(payload, dict):
        raise SubscriptionError("subscribe payload must be a JSON object")

    market_obj = payload.get("market")
    if market_obj is not None and not isinstance(market_obj, dict):
        raise SubscriptionError("market must be a JSON object when provided")
    market: Dict[str, Any] = market_obj or {}

    vendors = _extract_vendors(payload)
    if not vendors:
        raise SubscriptionError("provider must identify at least one vendor")

    tickers_or_ids = _dedupe_preserve(
        _coerce_string_list(payload.get("tickers_or_ids"))
        + _coerce_string_list(payload.get("tickersOrIds"))
        + _collect_strings(market, ("tickers_or_ids", "tickersOrIds"))
    )

    kalshi_market_keys = ("kalshi_market_tickers", "kalshiMarketTickers", "kalshi_tickers", "kalshiTickers")
    kalshi_token_keys = ("ticker", "market_ticker", "marketTicker", "kalshi_market_ticker")
    kalshi_market_tickers = _dedupe_preserve(
        _collect_strings(payload, kalshi_market_keys)
        + _collect_strings(market, kalshi_market_keys + kalshi_token_keys)
    )

    kalshi_event_tickers = _dedupe_preserve(
        _collect_strings(payload, ("kalshi_event_tickers", "kalshiEventTickers"))
        + _collect_strings(market, ("kalshi_event_tickers", "kalshiEventTickers", "event_ticker", "eventTicker"))
    )

    polymarket_assets_ids = _dedupe_preserve(
        _collect_strings(payload, ("polymarket_assets_ids", "polymarketAssetsIds", "assets_ids", "assetsIds"))
        + _collect_strings(market, ("polymarket_assets_ids", "polymarketAssetsIds", "assets_ids", "assetsIds"))
    )

    if DvVendors.POLYMARKET in vendors and not polymarket_assets_ids:
        polymarket_assets_ids = _resolve_polymarket_assets_ids(payload, market, client)

    if DvVendors.POLYMARKET in vendors and not (polymarket_assets_ids or tickers_or_ids):
        raise SubscriptionError(
            "polymarket assets_ids required when subscribing to polymarket",
            details={"hint": "include market.asset_id or polymarket_assets_ids"},
        )

    if DvVendors.KALSHI in vendors and not (kalshi_market_tickers or kalshi_event_tickers or tickers_or_ids):
        raise SubscriptionError(
            "kalshi tickers required when subscribing to kalshi",
            details={"hint": "include market.ticker or kalshi_market_tickers"},
        )

    return DvSubscription(
        vendors=tuple(vendors),
        tickers_or_ids=tickers_or_ids or None,
        kalshi_market_tickers=kalshi_market_tickers or None,
        kalshi_event_tickers=kalshi_event_tickers or None,
        polymarket_assets_ids=polymarket_assets_ids or None,
    )


def _json_default(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        try:
            return value.model_dump()
        except Exception:
            pass
    if isinstance(value, (set, frozenset)):
        return list(value)
    if isinstance(value, (bytes, bytearray)):
        try:
            return value.decode("utf-8")
        except Exception:
            return value.decode("utf-8", errors="ignore")
    return str(value)


def _event_payload(ev: NormalizedEvent) -> str:
    return _sdk_event_payload(ev)


def _send_ws_error(ws, code: str, message: str, details: Optional[Dict[str, Any]] = None) -> None:
    payload: Dict[str, Any] = {"type": "error", "error": code, "message": message}
    if details:
        payload["details"] = details
    try:
        ws.send(json.dumps(payload, default=_json_default))
    except ConnectionClosed:
        pass


def _send_ws_info(ws, message: str, **extra: Any) -> None:
    payload: Dict[str, Any] = {"type": "info", "message": message}
    if extra:
        payload.update(extra)
    try:
        ws.send(json.dumps(payload, default=_json_default))
    except ConnectionClosed:
        pass


def _request_stop(ctrl: Dict[str, Any]) -> None:
    loop = ctrl.get("loop")
    stop_event = ctrl.get("stop_event")
    if not loop or not stop_event:
        return
    try:
        if not stop_event.is_set():
            loop.call_soon_threadsafe(stop_event.set)
    except RuntimeError:
        pass


@app.get("/api/health")
def health() -> Response:
    logger.debug("health check")
    return jsonify({"ok": True, "ts": int(time.time())})


@sock.route("/api/ws/dv")
def dv_ws_route(ws) -> None:
    remote = request.remote_addr if request else "unknown"
    logger.info("ws open path=/api/ws/dv remote=%s", remote)

    try:
        first_frame = ws.receive()
    except ConnectionClosed:
        return

    if first_frame is None:
        try:
            ws.close()
        except ConnectionClosed:
            pass
        return

    try:
        payload = json.loads(first_frame)
    except Exception:
        _send_ws_error(ws, "invalid_json", "First message must be JSON", {"frame": first_frame})
        try:
            ws.close()
        except ConnectionClosed:
            pass
        return

    if not isinstance(payload, dict):
        _send_ws_error(ws, "invalid_payload", "First message must be a JSON object")
        try:
            ws.close()
        except ConnectionClosed:
            pass
        return

    msg_type = str(payload.get("type") or "").strip().lower()
    if msg_type != "subscribe":
        _send_ws_error(ws, "unexpected_message", "First message must be type=subscribe")
        try:
            ws.close()
        except ConnectionClosed:
            pass
        return

    client = DataVentsNoAuthClient()
    try:
        subscription = _build_subscription(payload, client)
    except SubscriptionError as exc:
        _send_ws_error(ws, "invalid_subscribe", str(exc), exc.details)
        try:
            ws.close()
        except ConnectionClosed:
            pass
        return

    _send_ws_info(ws, "subscribed", vendors=[v.value for v in subscription.vendors])

    ctrl: Dict[str, Any] = {}
    ready = threading.Event()
    worker_error: Dict[str, Any] = {}

    def _worker() -> None:
        loop = asyncio.new_event_loop()
        ctrl["loop"] = loop
        asyncio.set_event_loop(loop)
        stop_event = asyncio.Event()
        ctrl["stop_event"] = stop_event
        ready.set()

        dv_client = DvWsClient()

        async def _on_event(ev: NormalizedEvent) -> None:
            if stop_event.is_set():
                return
            payload_json = _event_payload(ev)
            try:
                await loop.run_in_executor(None, ws.send, payload_json)
            except ConnectionClosed:
                stop_event.set()

        async def _run() -> None:
            try:
                await dv_client.run(subscription, _on_event, stop_event=stop_event)
            except Exception as exc:
                worker_error["error"] = exc
                logger.exception("dv.ws upstream error: %s", exc)
                _send_ws_error(ws, "upstream_failure", "Upstream websocket error", {"error": str(exc)})
                stop_event.set()

        try:
            loop.run_until_complete(_run())
        finally:
            ctrl["done"] = True
            try:
                ws.close()
            except ConnectionClosed:
                pass
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            except Exception:
                pass
            loop.close()

    worker = threading.Thread(target=_worker, name="dv-ws-client", daemon=True)
    worker.start()

    if not ready.wait(timeout=5):
        _send_ws_error(ws, "internal_error", "Failed to initialize websocket client")
        _request_stop(ctrl)
        worker.join(timeout=1)
        return

    try:
        while True:
            try:
                frame = ws.receive()
            except ConnectionClosed:
                break
            if frame is None:
                break
            try:
                message = json.loads(frame)
            except Exception:
                _send_ws_error(ws, "invalid_json", "Messages must be JSON", {"frame": frame})
                continue
            if not isinstance(message, dict):
                _send_ws_error(ws, "invalid_payload", "Messages must be JSON objects")
                continue
            msg_type = str(message.get("type") or "").strip().lower()
            if msg_type == "unsubscribe":
                _send_ws_info(ws, "unsubscribed")
                _request_stop(ctrl)
                break
            _send_ws_error(ws, "unsupported_message", "Only unsubscribe is supported after subscribe")
    finally:
        _request_stop(ctrl)
        worker.join(timeout=5)
        try:
            ws.close()
        except ConnectionClosed:
            pass
        if worker_error.get("error"):
            logger.info("dv.ws client closed with error: %s", worker_error["error"])


@app.before_request
def _before_request_logging():
    g._t0 = time.time()
    logger.info(
        "request start method=%s path=%s qs=%s", request.method, request.path, request.query_string.decode("utf-8", errors="ignore")
    )


@app.after_request
def _after_request_logging(response: Response):
    try:
        dt = (time.time() - getattr(g, "_t0", time.time())) * 1000.0
        logger.info(
            "request end method=%s path=%s status=%s duration_ms=%.2f", request.method, request.path, getattr(response, 'status_code', 'n/a'), dt
        )
    except Exception:
        pass
    return response


@app.get("/api/search")
def search() -> Response:
    q = (request.args.get("q") or "").strip()
    limit = int(request.args.get("limit") or 10)
    page = int(request.args.get("page") or 1)
    provider = _providers(request.args.get("provider") or "all")
    order = _enum_from_param(request.args.get("order"), DataVentsOrderSortParams, DataVentsOrderSortParams.ORDER_BY_TRENDING)
    status = _enum_from_param(request.args.get("status"), DataVentsStatusParams, DataVentsStatusParams.OPEN_MARKETS)
    exclude_sports = str(request.args.get("exclude_sports") or "").strip().lower() in ("1", "true", "yes", "on")
    excluded_categories = ["Sports"] if exclude_sports else []
    kalshi_scope_req = (request.args.get("kalshi_scope") or "series").strip().lower()
    if kalshi_scope_req not in ("events", "series"):
        kalshi_scope_req = "series"
    # If a specific status is requested, prefer Kalshi events search to honor it
    kalshi_scope_eff = ("events" if (kalshi_scope_req == "series" and _enum_from_param(request.args.get("status"), DataVentsStatusParams, DataVentsStatusParams.OPEN_MARKETS) != DataVentsStatusParams.ALL_MARKETS) else kalshi_scope_req)
    normalized = str(request.args.get("normalized") or "").strip().lower() in ("1", "true", "yes", "on")

    client = DataVentsNoAuthClient()
    # Use search endpoints for both providers
    logger.info(
        "search params provider=%s order=%s status=%s q=%r excluded_categories=%s kalshi_scope_req=%s kalshi_scope_eff=%s limit=%s page=%s",
        provider.value, order.name, status.name, q, ",".join(excluded_categories) if excluded_categories else "",
        kalshi_scope_req, kalshi_scope_eff, limit, page,
    )

    results: List[Dict[str, Any]] = client.search_events(
        provider=provider,
        query=q,
        limit=max(1, min(50, limit)),
        page=max(1, page),
        order_sort_params=order,
        status_params=status,
        kalshi_params={"excluded_categories": excluded_categories, "scope": kalshi_scope_req},
    )
    if not normalized:
        return jsonify({
            "results": results,
            "meta": {
                "provider": provider.value,
                "order": order.name,
                "status": status.name,
                "page": page,
                "limit": limit,
                "exclude_sports": exclude_sports,
                "excluded_categories": excluded_categories,
                "kalshi_scope": kalshi_scope_req,
            }
        })

    # Normalized output across provider(s)
    combined = []
    for r in results:
        pv = str(r.get("provider"))
        raw = r.get("data") or {}
        try:
            sr = normalize_search_response(
                ProviderEnum(pv),
                raw,
                q=q,
                order=order.name,
                status=status.name,
                page=max(1, page),
                limit=max(1, min(50, limit)),
                exclude_sports=exclude_sports,
                kalshi_scope=_SearchScopeKalshi(kalshi_scope_eff) if pv == "kalshi" else None,
            )
            combined.extend(sr.results)
        except Exception as e:
            logger.warning("normalize search failed for provider=%s: %s", pv, e)

    # Apply a server-side status filter to normalized items to ensure
    # consistent behavior across providers and Kalshi scopes. In particular,
    # Kalshi series search does not support a `status` parameter, so we filter
    # the normalized results here when a non-ALL status is requested.
    if status != DataVentsStatusParams.ALL_MARKETS:
        def _norm_status(item: Any) -> str:
            try:
                s = getattr(item, "status", None)
                # Pydantic models in this codebase use enum values directly
                # (use_enum_values=True), so `status` is a lowercase string.
                if s is None:
                    return ""
                return str(s).lower()
            except Exception:
                return ""

        if status == DataVentsStatusParams.OPEN_MARKETS:
            combined = [it for it in combined if _norm_status(it) == "open"]
        elif status == DataVentsStatusParams.CLOSED_MARKETS:
            # Treat both closed and settled as "closed" for filtering semantics
            combined = [it for it in combined if _norm_status(it) in ("closed", "settled")]

    normalized_out = SearchResponseNormalized(
        results=combined,
        meta={
            "provider": provider.value,
            "order": order.name,
            "status": status.name,
            "page": page,
            "limit": limit,
            "exclude_sports": exclude_sports,
            "excluded_categories": excluded_categories,
            "kalshi_scope": (_SearchScopeKalshi(kalshi_scope_eff) if provider in (DataVentsProviders.KALSHI, DataVentsProviders.ALL) else None),
        },
    )
    return jsonify(normalized_out.model_dump())


@app.get("/api/event")
def get_event_route() -> Response:
    """Fetch a single event with its submarkets for a provider.

    Query params:
    - provider: kalshi|polymarket (required)
    - For kalshi: event_ticker (required)
      Optional: with_nested_markets=1 (default true)
    - For polymarket: id or slug (one required)
      Optional: include_chat=0, include_template=0
    """
    provider = _providers(request.args.get("provider") or "")
    if provider not in (DataVentsProviders.KALSHI, DataVentsProviders.POLYMARKET):
        return jsonify({"error": "provider must be 'kalshi' or 'polymarket'"}), 400

    client = DataVentsNoAuthClient()
    normalized = str(request.args.get("normalized") or "").strip().lower() in ("1", "true", "yes", "on")
    if provider == DataVentsProviders.KALSHI:
        event_ticker = (request.args.get("event_ticker") or "").strip()
        with_nested = str(request.args.get("with_nested_markets") or "1").lower() in ("1", "true", "yes", "on")
        if not event_ticker:
            return jsonify({"error": "event_ticker required for provider=kalshi"}), 400
        res = client.get_event(
            provider=provider,
            kalshi_event_ticker=event_ticker,
            with_nested_markets=with_nested,
        )
        # client returns a list; for provider-specific call it's length 1
        out = res[0] if isinstance(res, list) and res else {"provider": "kalshi", "data": None}
        if not normalized:
            return jsonify(out)
        try:
            ev = normalize_event(ProviderEnum.kalshi, out.get("data") or {})
            return jsonify(EventResponseNormalized(provider=ProviderEnum.kalshi, data=ev).model_dump())
        except Exception as e:
            logger.warning("normalize kalshi event failed: %s", e)
            return jsonify(out)
    else:
        # Polymarket
        pid_raw = request.args.get("id")
        slug = (request.args.get("slug") or "").strip()
        include_chat = False
        include_template = False
        pid = int(pid_raw) if pid_raw and pid_raw.isdigit() else None
        if pid is None and not slug:
            return jsonify({"error": "id or slug required for provider=polymarket"}), 400
        res = client.get_event(
            provider=provider,
            polymarket_id=pid,
            polymarket_slug=slug or None,
            include_chat=include_chat,
            include_template=include_template,
        )
        out = res[0] if isinstance(res, list) and res else {"provider": "polymarket", "data": None}
        if not normalized:
            return jsonify(out)


@app.post("/api/event")
def post_event_route() -> Response:
    """Provider-agnostic event fetch via JSON body.

    Body may include:
      {"provider": "kalshi"|"polymarket", "event_ticker"?: str, "id"?: int, "slug"?: str,
       "with_nested_markets"?: bool, "include_chat"?: bool, "include_template"?: bool,
       "normalized"?: bool}
    """
    try:
        body = request.get_json(force=True, silent=True) or {}
    except Exception:
        body = {}

    provider = _providers(str(body.get("provider") or "").strip())
    if provider not in (DataVentsProviders.KALSHI, DataVentsProviders.POLYMARKET):
        return jsonify({"error": "provider must be 'kalshi' or 'polymarket'"}), 400

    normalized = bool(body.get("normalized") in (True, 1, "1", "true", "yes", "on"))
    client = DataVentsNoAuthClient()

    if provider == DataVentsProviders.KALSHI:
        et = str(body.get("event_ticker") or body.get("eventId") or body.get("event_id") or "").strip()
        if not et:
            return jsonify({"error": "event_ticker required for provider=kalshi"}), 400
        with_nested = bool(body.get("with_nested_markets") in (True, 1, "1", "true", "yes", "on"))
        res = client.get_event(provider=provider, kalshi_event_ticker=et, with_nested_markets=with_nested)
        out = res[0] if isinstance(res, list) and res else {"provider": "kalshi", "data": None}
        if not normalized:
            return jsonify(out)
        try:
            ev = normalize_event(ProviderEnum.kalshi, out.get("data") or {})
            return jsonify({"provider": "kalshi", "data": ev.model_dump(), "version": "v1"})
        except Exception as e:
            logger.warning("normalize kalshi event failed: %s", e)
            return jsonify(out)

    # Polymarket
    pid_raw = body.get("id") or body.get("eventId") or body.get("event_id")
    slug = str(body.get("slug") or body.get("eventSlug") or body.get("event_slug") or "").strip()
    try:
        pid = int(pid_raw) if pid_raw is not None and str(pid_raw).strip() != "" else None
    except Exception:
        pid = None
    if pid is None and not slug:
        return jsonify({"error": "id or slug required for provider=polymarket"}), 400

    include_chat = bool(body.get("include_chat") in (True, 1, "1", "true", "yes", "on"))
    include_template = bool(body.get("include_template") in (True, 1, "1", "true", "yes", "on"))
    res = client.get_event(provider=provider, polymarket_id=pid, polymarket_slug=(slug or None), include_chat=include_chat, include_template=include_template)
    out = res[0] if isinstance(res, list) and res else {"provider": "polymarket", "data": None}
    if not normalized:
        return jsonify(out)
    try:
        ev = normalize_event(ProviderEnum.polymarket, out.get("data") or {})
        return jsonify({"provider": "polymarket", "data": ev.model_dump(), "version": "v1"})
    except Exception as e:
        logger.warning("normalize polymarket event failed: %s", e)
        return jsonify(out)


@app.get("/api/market")
def get_market_route() -> Response:
    """Fetch a single market by provider identifier.

    Query params:
    - provider: kalshi|polymarket (required)
    - For kalshi: ticker (required)
    - For polymarket: id or slug (one required)
    """
    provider = _providers(request.args.get("provider") or "")
    if provider not in (DataVentsProviders.KALSHI, DataVentsProviders.POLYMARKET):
        return jsonify({"error": "provider must be 'kalshi' or 'polymarket'"}), 400

    client = DataVentsNoAuthClient()
    normalized = str(request.args.get("normalized") or "").strip().lower() in ("1", "true", "yes", "on")
    if provider == DataVentsProviders.KALSHI:
        ticker = (request.args.get("ticker") or "").strip()
        if not ticker:
            return jsonify({"error": "ticker required for provider=kalshi"}), 400
        res = client.get_market(provider=provider, kalshi_ticker=ticker)
        out = res[0] if isinstance(res, list) and res else {"provider": "kalshi", "data": None}
        if not normalized:
            return jsonify(out)
        try:
            mk = normalize_market(ProviderEnum.kalshi, out.get("data") or {})
            return jsonify(MarketResponseNormalized(provider=ProviderEnum.kalshi, data=mk).model_dump())
        except Exception as e:
            logger.warning("normalize kalshi market failed: %s", e)
            return jsonify(out)
    else:
        pid_raw = request.args.get("id")
        slug = (request.args.get("slug") or "").strip()
        pid = int(pid_raw) if pid_raw and pid_raw.isdigit() else None
        if pid is None and not slug:
            return jsonify({"error": "id or slug required for provider=polymarket"}), 400
        res = client.get_market(
            provider=provider,
            polymarket_id=pid,
            polymarket_slug=slug or None,
        )
        out = res[0] if isinstance(res, list) and res else {"provider": "polymarket", "data": None}
        if not normalized:
            return jsonify(out)
        try:
            mk = normalize_market(ProviderEnum.polymarket, out.get("data") or {})
            return jsonify(MarketResponseNormalized(provider=ProviderEnum.polymarket, data=mk).model_dump())
        except Exception as e:
            logger.warning("normalize polymarket market failed: %s", e)
            return jsonify(out)


@app.get("/api/market/history")
def get_market_history_route() -> Response:
    """Historical price series for a single market.

    Query params:
    - provider: kalshi|polymarket (required)
    - For kalshi: ticker (required), optional series_ticker
      Optional: start, end (epoch seconds or ms), interval (seconds)
        Defaults: last 24h, interval=300s
    - For polymarket: id or slug (one required)
    """
    provider = _providers(request.args.get("provider") or "")
    if provider not in (DataVentsProviders.KALSHI, DataVentsProviders.POLYMARKET):
        return jsonify({"error": "provider must be 'kalshi' or 'polymarket'"}), 400

    # Time range parsing (defaults: last 24h @ 5m)
    try:
        def _to_epoch_s(v: Optional[str]) -> Optional[int]:
            if v is None or str(v).strip() == "":
                return None
            s = str(v).strip()
            # Allow ms or seconds epoch
            iv = int(float(s))
            if iv > 10_000_000_000:  # ms
                iv = iv // 1000
            return max(0, iv)

        now_s = int(time.time())
        end_s = _to_epoch_s(request.args.get("end")) or now_s
        start_s = _to_epoch_s(request.args.get("start")) or (end_s - 24 * 3600)
        interval_s = int(request.args.get("interval") or 300)
        # Clamp to reasonable bounds
        interval_s = min(max(interval_s, 10), 24 * 3600)
        # Ensure start < end
        if start_s >= end_s:
            start_s = max(end_s - 3600, end_s - 24 * 3600)
    except Exception as e:
        return jsonify({"error": f"invalid time range: {e}"}), 400

    if provider == DataVentsProviders.KALSHI:
        ticker = (request.args.get("ticker") or "").strip()
        series_ticker = (request.args.get("series_ticker") or "").strip()
        market_id = (request.args.get("market_id") or "").strip()
        if not ticker:
            return jsonify({"error": "ticker required for provider=kalshi"}), 400

        # Resolve series_ticker / market_id if not provided by fetching the event from v1
        if not series_ticker or not market_id:
            try:
                import requests
                base_v1 = "https://api.elections.kalshi.com/v1"
                # Derive event_ticker candidate from market ticker by removing the last dash segment
                event_guess = ticker.rsplit("-", 1)[0] if "-" in ticker else ticker
                r = requests.get(f"{base_v1}/events/{event_guess}", timeout=10)
                if r.status_code == 200:
                    ev = r.json() or {}
                    evd = ev.get("event") or {}
                    if not series_ticker:
                        st = evd.get("series_ticker")
                        if isinstance(st, str) and st:
                            series_ticker = st
                    # Find matching market id by ticker_name
                    mlist = evd.get("markets") or []
                    for it in mlist:
                        if isinstance(it, dict) and (it.get("ticker_name") == ticker or it.get("ticker") == ticker):
                            mid = it.get("id")
                            if isinstance(mid, str) and mid:
                                market_id = mid
                                break
                # If still missing, try series search to get the canonical event ticker then re-fetch
                if (not market_id or not series_ticker) and series_ticker:
                    r2 = requests.get(
                        f"{base_v1}/search/series",
                        params={"query": series_ticker, "page_size": 1},
                        timeout=10,
                    )
                    if r2.status_code == 200:
                        js = r2.json() or {}
                        page = (js.get("current_page") or [])
                        evt = page[0] if page else {}
                        ev_tkr = evt.get("event_ticker")
                        if isinstance(ev_tkr, str) and ev_tkr:
                            r3 = requests.get(f"{base_v1}/events/{ev_tkr}", timeout=10)
                            if r3.status_code == 200:
                                ev2 = r3.json() or {}
                                evd2 = ev2.get("event") or {}
                                if not series_ticker:
                                    st2 = evd2.get("series_ticker")
                                    if isinstance(st2, str) and st2:
                                        series_ticker = st2
                                for it in (evd2.get("markets") or []):
                                    if isinstance(it, dict) and (it.get("ticker_name") == ticker or it.get("ticker") == ticker):
                                        mid2 = it.get("id")
                                        if isinstance(mid2, str) and mid2:
                                            market_id = mid2
                                            break
            except Exception as e:
                logger.warning("could not resolve identifiers via v1 events/search for %s: %s", ticker, e)

        # Final fallback: ask Kalshi v2 markets endpoint for this ticker and extract identifiers
        if not (series_ticker and market_id):
            try:
                dv_client = DataVentsNoAuthClient()
                resp = dv_client.get_market(provider=DataVentsProviders.KALSHI, kalshi_ticker=ticker)
                raw = (resp[0].get("data") if isinstance(resp, list) and resp else None) or {}
                mobj = raw
                # Accept common wrappers: {"market": {...}} or {"markets": [{...}]}
                if isinstance(raw, dict) and isinstance(raw.get("market"), dict):
                    mobj = raw.get("market")
                elif isinstance(raw, dict) and isinstance(raw.get("markets"), list) and raw["markets"]:
                    # pick the one matching our ticker if present
                    arr = [it for it in raw["markets"] if isinstance(it, dict)]
                    picked = None
                    for it in arr:
                        t1 = it.get("ticker") or it.get("ticker_name")
                        if isinstance(t1, str) and t1.strip() == ticker:
                            picked = it
                            break
                    mobj = picked or arr[0]
                if isinstance(mobj, dict):
                    if not series_ticker:
                        st = mobj.get("series_ticker") or mobj.get("seriesTicker")
                        if isinstance(st, str) and st:
                            series_ticker = st
                    if not market_id:
                        midv = mobj.get("id") or mobj.get("market_id")
                        if isinstance(midv, (str, int)) and str(midv).strip():
                            market_id = str(midv).strip()
                if not (series_ticker and market_id):
                    logger.info("kalshi v2 fallback did not yield both identifiers for %s (series=%s id=%s)", ticker, series_ticker, market_id)
            except Exception as e:
                logger.warning("kalshi v2 markets fallback failed for %s: %s", ticker, e)
        if not series_ticker:
            # Heuristic: series is prefix before first '-' or '_' in market ticker
            try:
                raw = str(ticker)
                guess = raw.split("-", 1)[0]
                if not guess:
                    guess = raw.split("_", 1)[0]
                guess = guess.strip()
                if guess:
                    series_ticker = guess
                    logger.info("derived series_ticker=%s from ticker=%s", series_ticker, ticker)
            except Exception:
                pass

        # If still missing, do not error — continue with trades fallback using just `ticker`.
        if not (series_ticker and market_id):
            if not series_ticker:
                try:
                    s_guess = ticker.split("-", 1)[0] or ticker.split("_", 1)[0]
                    series_ticker = s_guess.strip() if s_guess else series_ticker
                except Exception:
                    pass
            logger.info(
                "history: identifiers incomplete for %s; series=%s market_id=%s — using trades fallback",
                ticker,
                series_ticker,
                market_id,
            )

        # Prefer Elections API v1 forecast_history (needs both identifiers); fall back to trades aggregation
        points: list[dict] = []
        err_primary: Optional[str] = None
        if series_ticker and market_id:
            try:
                import requests
                base_v1 = "https://api.elections.kalshi.com/v1"
                url = f"{base_v1}/series/{series_ticker}/markets/{market_id}/forecast_history"
                r = requests.get(
                    url,
                    params={
                        "start_ts": start_s,
                        "end_ts": end_s,
                        "period_interval": interval_s,
                        "candlestick_function": request.args.get("fn") or "mean_price",
                    },
                    timeout=10,
                )
                r.raise_for_status()
                j = r.json() or {}
                items = j.get("forecast_history") or []
                for it in items:
                    if not isinstance(it, dict):
                        continue
                    ts = it.get("end_period_ts") or it.get("ts") or it.get("timestamp")
                    val = it.get("numerical_forecast") or it.get("raw_numerical_forecast")
                    if ts is None or val is None:
                        continue
                    try:
                        ts_i = int(ts)
                        v_f = float(val)
                    except Exception:
                        continue
                    # numerical_forecast is in percent
                    p = v_f / 100.0
                    if ts_i < 10_000_000_000:
                        ts_i *= 1000
                    points.append({"t": ts_i, "p": p})
            except Exception as e:
                err_primary = str(e)
                logger.warning("kalshi v1 forecast_history failed: %s", e)

        if not points:
            # Fallback 2: aggregate from trades API
            try:
                from datavents.providers.kalshi.kalshi_rest_noauth import KalshiRestNoAuth
                import datetime as _dt
                rest = KalshiRestNoAuth()
                cursor = None
                buckets: Dict[int, float] = {}
                loops = 0
                while True:
                    loops += 1
                    if loops > 20:  # safety limit (~2k trades if 100 each)
                        break
                    raw = rest.get_trades(
                        ticker=ticker,
                        cursor=cursor,
                        limit=100,
                        min_ts=start_s,
                        max_ts=end_s,
                    )
                    if not isinstance(raw, dict):
                        break
                    trades = raw.get("trades") or []
                    cursor = raw.get("cursor") or None
                    if not trades:
                        break
                    for tr in trades:
                        if not isinstance(tr, dict):
                            continue
                        ct = tr.get("created_time") or tr.get("timestamp")
                        price = tr.get("price")
                        if ct is None or price is None:
                            continue
                        try:
                            s = str(ct)
                            if s.endswith("Z"):
                                s = s[:-1] + "+00:00"
                            ts_i = int(_dt.datetime.fromisoformat(s).timestamp())
                            p = float(price)
                        except Exception:
                            continue
                        if ts_i < start_s or ts_i > end_s:
                            continue
                        # bucket to interval end
                        b = ts_i - (ts_i % interval_s) + interval_s
                        buckets[b] = p  # keep last seen in bucket
                    if not cursor:
                        break
                for b in sorted(buckets.keys()):
                    points.append({"t": (b if b >= 10_000_000_000 else b) * 1000, "p": buckets[b]})
            except Exception as e3:
                logger.exception("kalshi trades fallback failed: %s (primary=%s)", e3, err_primary)
                return jsonify({"error": f"kalshi history error: {err_primary or e3}"}), 502

        # Sort ascending by time and return via normalizer
        points.sort(key=lambda d: d.get("t", 0))
        normalized = normalize_market_history(
            ProviderEnum.kalshi,
            identifiers={"ticker": ticker, "series_ticker": series_ticker, "market_id": market_id},
            start=start_s,
            end=end_s,
            interval=interval_s,
            points=points,
        )
        return jsonify(normalized.model_dump())

    # Polymarket history via clob.prices-history
    pid_raw = request.args.get("id")
    slug = (request.args.get("slug") or "").strip()
    if pid_raw is None and not slug:
        return jsonify({"error": "id or slug required for provider=polymarket"}), 400

    try:
        client = DataVentsNoAuthClient()
        # Fetch market to resolve clob token id(s)
        if pid_raw is not None and str(pid_raw).strip() != "":
            try:
                pid = int(str(pid_raw))
            except Exception:
                pid = None
        else:
            pid = None

        res = client.get_market(
            provider=DataVentsProviders.POLYMARKET,
            polymarket_id=pid,
            polymarket_slug=(slug or None),
        )
        data = (res[0].get("data") if isinstance(res, list) and res else None) or {}

        # Extract clob token id(s) from common shapes
        def _extract_clob_ids(obj: Dict[str, Any]) -> list[str]:
            ids: list[str] = []
            raw = obj.get("clob_token_ids")
            if isinstance(raw, list):
                ids.extend([str(x) for x in raw if isinstance(x, (str, int))])
            elif isinstance(raw, str) and raw.strip():
                # Sometimes stored as JSON string
                try:
                    arr = json.loads(raw)
                    if isinstance(arr, list):
                        ids.extend([str(x) for x in arr if isinstance(x, (str, int))])
                except Exception:
                    pass
            # CamelCase variant
            raw2 = obj.get("clobTokenIds")
            if isinstance(raw2, list):
                ids.extend([str(x) for x in raw2 if isinstance(x, (str, int))])
            elif isinstance(raw2, str) and raw2.strip():
                try:
                    arr = json.loads(raw2)
                    if isinstance(arr, list):
                        ids.extend([str(x) for x in arr if isinstance(x, (str, int))])
                except Exception:
                    pass
            # Deduplicate
            out: list[str] = []
            seen = set()
            for v in ids:
                s = str(v)
                if s and s not in seen:
                    out.append(s)
                    seen.add(s)
            return out

        clob_ids = []
        if isinstance(data, dict):
            clob_ids = _extract_clob_ids(data)
        if not clob_ids and isinstance(data, dict):
            # Some shapes embed market in a key
            for k in ("market", "data"):
                v = data.get(k)
                if isinstance(v, dict):
                    clob_ids = _extract_clob_ids(v)
                    if clob_ids:
                        break

        if not clob_ids:
            return jsonify({"provider": "polymarket", "error": "no clob_token_ids found for market"}), 404

        clob_id = clob_ids[0]

        # Use explicit time-bounded query with minute fidelity so long ranges (e.g., 30d) are returned.
        # Polymarket's prices-history supports startTs/endTs + fidelity (minutes). Avoid the old interval string.
        def _fidelity_minutes(sec: int) -> int:
            try:
                # Round to nearest minute; clamp to at least 1 minute
                m = int(max(1, round(sec / 60)))
                # Cap to 1 day buckets for sanity
                return min(m, 1440)
            except Exception:
                return 1

        fidelity_min = _fidelity_minutes(interval_s)
        poly_interval = None  # kept for response compatibility; no longer sent upstream
        url = "https://clob.polymarket.com/prices-history"
        import requests as _rq
        # Chunk long ranges to respect upstream limit (max ~15d per request)
        MAX_CHUNK_SEC = 15 * 24 * 3600
        cur = start_s
        points = []
        while cur < end_s:
            chunk_end = min(cur + MAX_CHUNK_SEC, end_s)
            r = _rq.get(
                url,
                params={
                    "market": clob_id,
                    "startTs": cur,
                    "endTs": chunk_end,
                    # do not pass fidelity with start/end — upstream rejects for large windows
                },
                timeout=15,
            )
            r.raise_for_status()
            js = r.json() or {}
            items = js.get("history") or []
            for it in items:
                if not isinstance(it, dict):
                    continue
                ts = it.get("t")
                p = it.get("p")
                if ts is None or p is None:
                    continue
                try:
                    ts_i = int(ts)
                    pv = float(p)
                except Exception:
                    continue
                if ts_i < start_s or ts_i > end_s:
                    continue
                if ts_i < 10_000_000_000:
                    ts_i *= 1000
                points.append({"t": ts_i, "p": pv})
            cur = chunk_end
        # Deduplicate by timestamp in case of boundary overlaps
        seen_ts = set()
        deduped = []
        for pt in sorted(points, key=lambda d: d.get("t", 0)):
            t = pt.get("t")
            if t in seen_ts:
                continue
            seen_ts.add(t)
            deduped.append(pt)
        points = deduped

        # If empty, fallback to two-point series from market snapshot
        if not points and isinstance(data, dict):
            last_price = data.get("lastTradePrice") or data.get("lastPrice") or data.get("price") or data.get("mid")
            try:
                pv = float(last_price) if last_price is not None else None
            except Exception:
                pv = None
            if pv is not None:
                t_now = int(time.time()) * 1000
                points = [
                    {"t": t_now - 3600 * 1000, "p": pv},
                    {"t": t_now, "p": pv},
                ]

        points.sort(key=lambda d: d.get("t", 0))
        normalized = normalize_market_history(
            ProviderEnum.polymarket,
            identifiers={"market_id": pid, "slug": slug or None, "clob_token_id": clob_id},
            start=start_s,
            end=end_s,
            interval=interval_s,
            points=points,
            poly_interval=(f"chunked<=15d"),
        )
        return jsonify(normalized.model_dump())
    except Exception as e:
        logger.exception("error fetching polymarket history: %s", e)
        return jsonify({"error": f"polymarket history error: {e}"}), 502


@app.post("/api/history")
def get_history_normalized() -> Response:
    """Unified normalized history endpoint.

    Body JSON shape (minimal):
      {
        "provider": "kalshi"|"polymarket",
        "market": { "provider": ..., "market_id": str, "ticker"?: str, "slug"?: str, "vendor_market_id"?: str },
        "start": int (epoch seconds),
        "end": int (epoch seconds),
        "interval": int (seconds)
      }
    Returns MarketHistoryResponseNormalized.
    """
    try:
        body = request.get_json(force=True, silent=True) or {}
    except Exception:
        body = {}

    provider_raw = (body.get("provider") or body.get("market", {}).get("provider") or "").strip().lower()
    provider = _providers(provider_raw)
    if provider not in (DataVentsProviders.KALSHI, DataVentsProviders.POLYMARKET):
        return jsonify({"error": "provider must be 'kalshi' or 'polymarket'"}), 400

    def _to_epoch_s(v: Any, default: Optional[int]) -> int:
        try:
            iv = int(float(v))
            if iv > 10_000_000_000:
                iv = iv // 1000
            return iv
        except Exception:
            return int(default or int(time.time()))

    now_s = int(time.time())
    start_s = _to_epoch_s(body.get("start"), now_s - 24 * 3600)
    end_s = _to_epoch_s(body.get("end"), now_s)
    interval_s = int(body.get("interval") or 300)
    interval_s = min(max(interval_s, 10), 24 * 3600)

    market = body.get("market") or {}
    client = DataVentsNoAuthClient()

    if provider == DataVentsProviders.KALSHI:
        # Prefer explicit ticker
        ticker = (market.get("ticker") or market.get("market_ticker") or "").strip()
        market_id = (market.get("vendor_market_id") or market.get("market_id") or "").strip()
        series_ticker = (market.get("series_ticker") or market.get("series_id") or "").strip()

        if not ticker:
            return jsonify({"error": "kalshi ticker is required in market.ticker"}), 400

        # Reuse logic from /api/market/history to resolve series_ticker & market_id when missing
        try:
            import requests as _rq
            if not (series_ticker and market_id):
                base_v1 = "https://api.elections.kalshi.com/v1"
                event_guess = ticker.rsplit("-", 1)[0] if "-" in ticker else ticker
                r = _rq.get(f"{base_v1}/events/{event_guess}", timeout=10)
                if r.status_code == 200:
                    ev = r.json() or {}
                    evd = ev.get("event") or {}
                    if not series_ticker:
                        st = evd.get("series_ticker")
                        if isinstance(st, str) and st:
                            series_ticker = st
                    for it in (evd.get("markets") or []):
                        if isinstance(it, dict) and (it.get("ticker_name") == ticker or it.get("ticker") == ticker):
                            mid = it.get("id")
                            if isinstance(mid, str) and mid:
                                market_id = mid
                                break
            # Try Kalshi v2 markets fallback if still missing
            if not (series_ticker and market_id):
                try:
                    dv_client = DataVentsNoAuthClient()
                    resp = dv_client.get_market(provider=DataVentsProviders.KALSHI, kalshi_ticker=ticker)
                    raw = (resp[0].get("data") if isinstance(resp, list) and resp else None) or {}
                    mobj = raw
                    if isinstance(raw, dict) and isinstance(raw.get("market"), dict):
                        mobj = raw.get("market")
                    elif isinstance(raw, dict) and isinstance(raw.get("markets"), list) and raw["markets"]:
                        arr = [it for it in raw["markets"] if isinstance(it, dict)]
                        picked = None
                        for it in arr:
                            t1 = it.get("ticker") or it.get("ticker_name")
                            if isinstance(t1, str) and t1.strip() == ticker:
                                picked = it
                                break
                        mobj = picked or arr[0]
                    if isinstance(mobj, dict):
                        if not series_ticker:
                            st = mobj.get("series_ticker") or mobj.get("seriesTicker")
                            if isinstance(st, str) and st:
                                series_ticker = st
                        if not market_id:
                            midv = mobj.get("id") or mobj.get("market_id")
                            if isinstance(midv, (str, int)) and str(midv).strip():
                                market_id = str(midv).strip()
                except Exception as _e:
                    logger.info("kalshi v2 markets fallback failed for %s: %s", ticker, _e)
        except Exception:
            pass

        # If still missing, do not error — proceed with trades fallback using just ticker.
        if not (series_ticker and market_id):
            logger.info(
                "history (POST): identifiers incomplete for %s; series=%s market_id=%s — using trades fallback",
                ticker,
                series_ticker,
                market_id,
            )

        # Elections API v1 forecast_history (needs both identifiers); fall back to trades regardless
        points: list[dict] = []
        primary_err = None
        if series_ticker and market_id:
            try:
                import requests as _rq
                base_v1 = "https://api.elections.kalshi.com/v1"
                url = f"{base_v1}/series/{series_ticker}/markets/{market_id}/forecast_history"
                r = _rq.get(url, params={"start_ts": start_s, "end_ts": end_s, "period_interval": interval_s, "candlestick_function": "mean_price"}, timeout=10)
                r.raise_for_status()
                j = r.json() or {}
                items = j.get("forecast_history") or []
                for it in items:
                    if not isinstance(it, dict):
                        continue
                    ts = it.get("end_period_ts") or it.get("ts") or it.get("timestamp")
                    val = it.get("numerical_forecast") or it.get("raw_numerical_forecast")
                    if ts is None or val is None:
                        continue
                    try:
                        ts_i = int(ts)
                        v_f = float(val)
                    except Exception:
                        continue
                    p = v_f / 100.0
                    if ts_i < 10_000_000_000:
                        ts_i *= 1000
                    points.append({"t": ts_i, "p": p})
            except Exception as _e:
                primary_err = str(_e)
                logger.warning("kalshi v1 forecast_history failed: %s", _e)

        # Trades fallback: works with just ticker
        if not points:
            try:
                from datavents.providers.kalshi.kalshi_rest_noauth import KalshiRestNoAuth
                import datetime as _dt
                rest = KalshiRestNoAuth()
                cursor = None
                buckets: Dict[int, float] = {}
                loops = 0
                while True:
                    loops += 1
                    if loops > 20:
                        break
                    raw = rest.get_trades(ticker=ticker, cursor=cursor, limit=100, min_ts=start_s, max_ts=end_s)
                    if not isinstance(raw, dict):
                        break
                    trades = raw.get("trades") or []
                    cursor = raw.get("cursor") or None
                    if not trades:
                        break
                    for tr in trades:
                        if not isinstance(tr, dict):
                            continue
                        ct = tr.get("created_time") or tr.get("timestamp")
                        price = tr.get("price")
                        if ct is None or price is None:
                            continue
                        try:
                            s = str(ct)
                            if s.endswith("Z"):
                                s = s[:-1] + "+00:00"
                            ts_i = int(_dt.datetime.fromisoformat(s).timestamp())
                            p = float(price)
                        except Exception:
                            continue
                        if ts_i < start_s or ts_i > end_s:
                            continue
                        b = ts_i - (ts_i % interval_s) + interval_s
                        buckets[b] = p
                    if not cursor:
                        break
                for b in sorted(buckets.keys()):
                    points.append({"t": (b if b >= 10_000_000_000 else b) * 1000, "p": buckets[b]})
            except Exception as e3:
                logger.exception("kalshi trades fallback failed: %s", e3)
                return jsonify({"error": f"kalshi history error: {primary_err or e3}"}), 502

        points.sort(key=lambda d: d.get("t", 0))
        normalized = normalize_market_history(
            ProviderEnum.kalshi,
            identifiers={"ticker": ticker, "series_ticker": series_ticker, "market_id": market_id},
            start=start_s,
            end=end_s,
            interval=interval_s,
            points=points,
        )
        return jsonify(normalized.model_dump())
        # End KALSHI branch

    # Polymarket
    pid = market.get("market_id")
    slug = market.get("slug")
    try:
        pid_i = int(pid) if pid is not None and str(pid).strip() != "" else None
    except Exception:
        pid_i = None

    try:
        # Helper to recursively collect clob/asset/token ids.
        # Handles common variants and stringified JSON (e.g., "clobTokenIds": "[\"...\", \"...\"]").
        def _find_clob_ids_any(o: Any) -> List[str]:
            out: List[str] = []

            def _extend_from_maybe_json_list(val: Any):
                # Accept list or JSON-string list; append string/int items
                if isinstance(val, list):
                    out.extend([str(i) for i in val if isinstance(i, (str, int))])
                    return
                if isinstance(val, str):
                    s = val.strip()
                    # quick guard for stringified list
                    if s.startswith("[") and s.endswith("]"):
                        try:
                            arr = json.loads(s)
                            if isinstance(arr, list):
                                out.extend([str(i) for i in arr if isinstance(i, (str, int))])
                        except Exception:
                            pass

            def _recurse(x: Any):
                if isinstance(x, dict):
                    for k, v in x.items():
                        kl = str(k).lower()
                        # Singular ids
                        if kl in ("clob_token_id", "clobtokenid", "token_id", "tokenid", "asset_id", "assetid") and isinstance(v, (str, int)):
                            out.append(str(v))
                        # Plural ids (list or JSON-string list)
                        if kl in ("clob_token_ids", "clobtokenids", "token_ids", "tokenids", "asset_ids", "assetids"):
                            _extend_from_maybe_json_list(v)
                        _recurse(v)
                elif isinstance(x, list):
                    for it in x:
                        _recurse(it)

            _recurse(o)
            # dedupe while preserving order
            uniq: List[str] = []
            seen = set()
            for s in out:
                if s and s not in seen:
                    uniq.append(s)
                    seen.add(s)
            return uniq

        # 1) Try incoming normalized market (may include vendor_raw)
        clob_ids = _find_clob_ids_any(market)

        # 2) If still missing, fetch market snapshot via client
        data: Dict[str, Any] = {}
        if not clob_ids:
            res = client.get_market(
                provider=DataVentsProviders.POLYMARKET,
                polymarket_id=pid_i,
                polymarket_slug=(slug if isinstance(slug, str) and slug else None),
            )
            data = (res[0] or {}).get("data") if isinstance(res, list) and res else {}
            clob_ids = _find_clob_ids_any(data)

        if not clob_ids:
            # 3) Last-resort: two-point series from price
            last_price = None
            for src in (market, data):
                if isinstance(src, dict):
                    for key in ("lastTradePrice", "lastPrice", "price", "mid", "last_price"):
                        v = src.get(key)
                        try:
                            if v is not None:
                                last_price = float(v)
                                break
                        except Exception:
                            pass
                if last_price is not None:
                    break
            if last_price is not None:
                t_now = int(time.time()) * 1000
                pts = [
                    {"t": t_now - 3600 * 1000, "p": last_price},
                    {"t": t_now, "p": last_price},
                ]
                normalized = normalize_market_history(
                    ProviderEnum.polymarket,
                    identifiers={"market_id": pid_i, "slug": slug or None, "clob_token_id": None},
                    start=start_s,
                    end=end_s,
                    interval=interval_s,
                    points=pts,
                    poly_interval=None,
                )
                return jsonify(normalized.model_dump())
            return jsonify({"provider": "polymarket", "error": "no clob_token_ids found for market"}), 404
        clob_id = clob_ids[0]

        # Use explicit time-bounded query with minute fidelity so long ranges (e.g., 30d) are returned.
        def _fidelity_minutes(sec: int) -> int:
            try:
                m = int(max(1, round(sec / 60)))
                return min(m, 1440)
            except Exception:
                return 1

        fidelity_min = _fidelity_minutes(interval_s)
        poly_interval = None  # preserved for response shape
        import requests as _rq
        url = "https://clob.polymarket.com/prices-history"
        MAX_CHUNK_SEC = 15 * 24 * 3600
        cur = start_s
        points = []
        while cur < end_s:
            chunk_end = min(cur + MAX_CHUNK_SEC, end_s)
            r = _rq.get(
                url,
                params={
                    "market": clob_id,
                    "startTs": cur,
                    "endTs": chunk_end,
                },
                timeout=15,
            )
            r.raise_for_status()
            js = r.json() or {}
            items = js.get("history") or []
            for it in items:
                if not isinstance(it, dict):
                    continue
                ts = it.get("t"); p = it.get("p")
                if ts is None or p is None:
                    continue
                try:
                    ts_i = int(ts); pv = float(p)
                except Exception:
                    continue
                if ts_i < start_s or ts_i > end_s:
                    continue
                if ts_i < 10_000_000_000:
                    ts_i *= 1000
                points.append({"t": ts_i, "p": pv})
            cur = chunk_end
        # Deduplicate timestamps across chunks
        points.sort(key=lambda d: d.get("t", 0))
        dedup = []
        seen_t = set()
        for pt in points:
            t = pt.get("t")
            if t in seen_t:
                continue
            seen_t.add(t)
            dedup.append(pt)
        points = dedup
        normalized = normalize_market_history(
            ProviderEnum.polymarket,
            identifiers={"market_id": pid_i, "slug": slug or None, "clob_token_id": clob_id},
            start=start_s,
            end=end_s,
            interval=interval_s,
            points=points,
            poly_interval=("chunked<=15d"),
        )
        return jsonify(normalized.model_dump())
    except Exception as e:
        logger.exception("polymarket normalized history error: %s", e)
        return jsonify({"error": f"polymarket history error: {e}"}), 502

def _labelize(name: str) -> str:
    s = name.replace("ORDER_BY_", "").replace("_MARKETS", "")
    s = s.replace("_", " ").title()
    return s


@app.get("/api/search/options")
def search_options() -> Response:
    providers = [
        {"name": m.name, "value": m.value, "label": _labelize(m.name)}
        for m in DataVentsProviders
    ]
    order = [
        {"name": m.name, "label": _labelize(m.name)}
        for m in DataVentsOrderSortParams
    ]
    status = [
        {"name": m.name, "label": _labelize(m.name)}
        for m in DataVentsStatusParams
    ]
    return jsonify({"providers": providers, "order": order, "status": status})


 


# Local dev entrypoint
if __name__ == "__main__":
    import os
    port = int(os.getenv("PORT", "8000"))
    app.run(host="0.0.0.0", port=port, debug=True, threaded=True)
