# Frontend Configuration

The example UI talks to a DataVents HTTP service and a WebSocket endpoint for streaming.

Environment variables (all prefixed with `NEXT_PUBLIC_` so they are available in the browser):

- `NEXT_PUBLIC_DATAVENTS_BASE_URL`
  - Root URL of the HTTP API. Default: `http://localhost:8000`.
  - Examples:
    - Local dev: `http://localhost:8000`
    - Hosted: `https://api.yourdomain.com`

- `NEXT_PUBLIC_DATAVENTS_WS_URL` (optional)
  - Full WebSocket URL. If omitted, it is derived from `BASE_URL` by replacing the scheme and appending `/api/ws/dv`.
  - Examples:
    - `wss://api.yourdomain.com/api/ws/dv`
    - `ws://localhost:8000/api/ws/dv`

Convenience scripts:

```bash
# Uses http://localhost:8000 by default
npm run dev:local

# Override for a remote API
NEXT_PUBLIC_DATAVENTS_BASE_URL=https://api.yourdomain.com npm run dev
```

