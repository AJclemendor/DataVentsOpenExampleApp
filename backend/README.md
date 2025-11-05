# Backend (Flask API)

Exposes a thin HTTP + WebSocket facade over a provider‑agnostic SDK.

## Run
```bash
pip install -r requirements.txt
python main.py  # http://localhost:8000
```

Environment (optional) — copy `.env.example` to `.env`:
- `DV_LOG_LEVEL`: INFO (default), DEBUG, etc.
- Provider WS credentials if you opt into authenticated streams.

## Endpoints
- `GET /api/health`
- `GET /api/search?provider=all|kalshi|polymarket&q=...&limit=10&page=1&order=ORDER_BY_TRENDING&status=OPEN_MARKETS&exclude_sports=0&kalshi_scope=series&normalized=1`
- `GET /api/event` and `POST /api/event`
- `GET /api/market`
- `GET|POST /api/market/history` (normalized history per provider)
- `GET /api/search/options` (UI selects)
- WebSocket: `GET /api/ws/dv` — send a JSON `{type:"subscribe", ...}` payload then receive normalized events; send `{type:"unsubscribe"}` to stop.

This service focuses on clarity over features; it is not a production API.

