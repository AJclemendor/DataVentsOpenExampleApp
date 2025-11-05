# Contributing

Thanks for your interest in improving this example! Please keep changes small and focused so the project stays easy to read and reuse.

- Use clear, self‑explanatory code. Prefer removing comments over adding them; move explanations to docs when needed.
- Follow existing structure and naming. Avoid introducing new build tools unless necessary.
- Do not commit secrets, keys, or personal data. Use `.env` locally and `.env.example` for docs.
- Add or update minimal docs when behavior changes.
- Keep dependencies minimal.

## Development
- Backend: Python 3.11+, `pip install -r backend/requirements.txt`, run `python backend/main.py`.
- Frontend: Node 18+, `cd frontend && npm install && npm run dev:local`.

## Pull Requests
- Describe the problem and the solution briefly.
- Include before/after notes when refactoring.
- Ensure basic run paths still work for both backend and frontend.

## Security
Report vulnerabilities via the process in `SECURITY.md`.

