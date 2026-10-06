# Artboard AI — Tool

Final production UI for **Artboard AI — Resolution Independent**.

This repository is the frontend/gateway only. Vectorization, reconstruction, validation, export, and AI routing remain in the separate Artboard AI engine.

## Production workflow

1. Upload a real JPEG / PNG / WEBP jersey source.
2. Auto-detect or manually select four Front Body corners.
3. Rectify the visible surface to the exact **22 × 31 in** production artboard.
4. Run identity-gated AI reconstruction guidance plus deterministic reconstruction.
5. Run ULTRA true-vector processing.
6. Review vector integrity and production-fidelity results.
7. Generate real EPS / SVG / PDF / PNG files from the validated engine project.

The UI contains no sample project, simulated progress, fake validation metrics, or fabricated output files. UI state advances only from real Artboard engine responses.

## Architecture

Browser → Cloudflare Worker gateway → Artboard AI Engine

The gateway keeps the engine API key server-side and only exposes:

- `/health`
- `/health/ready`
- `/api/artboard/*`

The browser never receives `ENGINE_API_KEY`.

## Local / Cloudflare setup

Install dependencies:

```bash
npm install
```

Configure local Worker secrets in `.dev.vars`:

```env
ENGINE_ORIGIN=https://your-artboard-engine.example
ENGINE_API_KEY=your-engine-api-key
```

Do not commit `.dev.vars`.

Run locally:

```bash
npm run dev
```

## Production configuration

The Worker intentionally does **not** hardcode an engine origin or API key in `wrangler.jsonc`.

Set both as Cloudflare Worker secrets:

```bash
npx wrangler secret put ENGINE_ORIGIN
npx wrangler secret put ENGINE_API_KEY
```

Then deploy:

```bash
npm run deploy
```

## Verification

```bash
npm run check
```

GitHub Actions also verifies JavaScript syntax and the required live-engine workflow routes on every push to `main`.

## Engine contract

The UI expects the dedicated Artboard API:

- `POST /api/artboard/projects`
- `POST /api/artboard/upload`
- `POST /api/artboard/prepare`
- `POST /api/artboard/production`
- `POST /api/artboard/export`
- `GET /api/artboard/jobs/{job_id}`
- `POST /api/artboard/jobs/{job_id}/cancel`
- `GET /api/artboard/projects/{project_id}`
- `GET /api/artboard/projects/{project_id}/artifacts/{artifact_path}`

The UI does not advertise native `.ai` output because the engine does not create a native Adobe Illustrator document. EPS/SVG/PDF remain editable production-vector outputs.
