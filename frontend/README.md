# DataVents Frontend Example

Minimal Next.js app showcasing how to use the DataVents SDK service:

- Search normalized markets/events across providers
- View basic market charts and order books
- Connect to a unified WebSocket stream and inspect live events

## Quick Start

- Requirements: Node 18+ (or Bun), pnpm/yarn/npm

```bash
cd frontend
# If running the backend locally at http://localhost:8000, you can use:
npm run dev:local
# Otherwise set the base URL to your deployed API
NEXT_PUBLIC_DATAVENTS_BASE_URL=https://your-api.example.com npm run dev
```

Open http://localhost:3000 and use the Search page.

## Configuration

- `NEXT_PUBLIC_DATAVENTS_BASE_URL`: Root URL of the DataVents HTTP API (defaults to `http://localhost:8000`).
- `NEXT_PUBLIC_DATAVENTS_WS_URL` (optional): Full WebSocket URL. If not set, it is derived from the base URL (`/api/ws/dv`).

See `docs/CONFIG.md` for details.

## What This Shows

- Unified search with normalized results from multiple providers
- Minimal market chart and top-of-book view
- Live WS subscribe/unsubscribe flow with basic event inspection

## Notes

- This app intentionally keeps state and rendering simple to serve as a clear reference. It’s not a production UI.
- The backend service endpoints are documented in the DataVentsOpen repository.

