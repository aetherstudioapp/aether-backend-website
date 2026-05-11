# Aether Website Backend

Standalone Node/Express API for the public Aether website.

This backend is intentionally separate from the Electron app. It contains only web-safe routes and does not import Electron, app windows, file dialogs, auto updates, local desktop storage, Touch ID, or IPC.

## Routes

- `GET /api/system`
- `GET /api/search?q=...`
- `GET /api/metadata?url=...`
- `GET /api/lyrics?track=...&artist=...&duration=...`
- `GET /api/proxy?url=...`
- `GET /api/queue/:id`
- `POST /api/add/:id`
- `POST /api/control/:id`
- `POST /api/heartbeat/:id`

## Local Run

```bash
npm install
npm run dev
```

Then test:

```bash
curl http://localhost:3333/api/system
```

## Render

Create a Render Web Service from this repo.

```text
Build Command: npm install
Start Command: npm run start:web
```

Environment:

```text
NODE_ENV=production
PORT=10000
AETHER_WEB_ORIGIN=https://aetherstudio.me
```

Then set the website frontend build variable:

```text
VITE_API_BASE_URL=https://your-render-service.onrender.com
```

or, after adding a custom domain:

```text
VITE_API_BASE_URL=https://api.aetherstudio.me
```

## Notes

Render free services can sleep after inactivity. That is okay for search/lyrics/metadata, but first request after sleep may be slow. For truly always-on playback/streaming, use a small VPS, Fly.io, Railway, or a paid Render instance.
