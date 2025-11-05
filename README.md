# DataVentsOpenExampleApp

Minimal, end‑to‑end example of a markets data explorer:
- Backend: small Flask service that proxies a provider‑agnostic SDK and exposes REST + WebSocket endpoints
- Frontend: simple Next.js UI for search, charts, and live events

This project aims to be slim and easy to run. Comments in code are intentionally minimal; usage details live in this README and in per‑folder READMEs.

## Quick Start

### Requirements
- Python 3.11+ (3.12 recommended)
- Node 18+ (or Bun) for the frontend

### Backend
Option A — pip + venv
```bash
cd backend
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python main.py  # serves on http://localhost:8000
```

Option B — uv (if installed)
```bash
cd backend
uv pip install -r requirements.txt
uv run python main.py
```

Environment variables (optional): copy `backend/.env.example` to `backend/.env` and adjust. For public data, no secrets are required. WebSocket streams that require provider auth are opt‑in and documented in the backend README section below.

### Frontend
```bash
cd frontend
npm install
npm run dev:local  # uses http://localhost:8000 for the API
```
Open http://localhost:3000.

## Repository Structure
- `backend/` — Flask service exposing `/api/*` HTTP routes and `/api/ws/dv` WebSocket
- `frontend/` — Next.js app that talks to the backend

## Common Tasks
- Start backend: `make dev` (from repo root) or `cd backend && python main.py`
- Start frontend: `cd frontend && npm run dev:local`

## Configuration
- Frontend reads `NEXT_PUBLIC_DATAVENTS_BASE_URL` and optional `NEXT_PUBLIC_DATAVENTS_WS_URL`. See `frontend/README.md`.
- Backend reads `.env` if present. See `backend/.env.example` for variables.

## Contributing
See `CONTRIBUTING.md` for guidelines. Please do not commit secrets; `.gitignore` blocks common patterns, and sensitive example values live in `.env.example` only.

## License
MIT — see `LICENSE`.
