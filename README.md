# Kitesurf-gl: Kitesurf + Warm Chromium WebGL Escalation

A Cloudflare Workers + Containers browser execution layer that runs standard pages on **Kitesurf** (fast path) and automatically escalates pages requiring **WebGL / WebGL2** to a warm, multiplexed **Headless Chromium** instance inside a Cloudflare Container (slow path), preserving session state (cookies, `localStorage`, `sessionStorage`, viewport, headers) via CDP serdes.

## Architecture

```
Client Request (POST /render | WS /screencast)
       │
       ▼
Orchestrator Worker (src/worker.ts)
 ├── Matches FORCE_CHROMIUM_PATTERNS? ──────────────────────────┐
 └── Fast Path (Kitesurf over CDP)                              │
      ├── Injects __escalateWebGL hook before navigation        │
      ├── No WebGL? ──► Execute action on Kitesurf ──► Return   │
      └── WebGL detected?                                       │
           ├── Abort Kitesurf                                   │
           ├── Extract SessionSnapshot (cookies + storage)      │
           └── Close Kitesurf session                           │
                                                                ▼
                                           ChromiumPoolDO (src/chromium-pool-do.ts)
                                            ├── Sharded pool (pool-${hash % MAX_POOLS})
                                            ├── Concurrency guard (MAX_CONTEXTS_PER_CONTAINER = 6)
                                            ├── Warm lifecycle (sleepAfter = "5m")
                                            └── 503 crash-recovery retry + WS /screencast proxy
                                                                │
                                                                ▼
                                           Cloudflare Container (container/)
                                            ├── Supervised Chromium daemon (SwiftShader WebGL, :9222)
                                            └── Node Sidecar API (:8080)
                                                 ├── Isolated incognito BrowserContext (disposeOnDetach)
                                                 ├── Hydrate cookies, storage, viewport, UA, headers
                                                 ├── Wait for load + network idle + 2 rAF ticks
                                                 └── Capture PNG / HTML / Screencast & dispose context
```

## Repo Layout

```
├── wrangler.jsonc             # Cloudflare Workers + Containers + DO SQLite migrations
├── src/
│   ├── worker.ts              # Ingress, Kitesurf CDP runner, WebGL hook, serdes, routing
│   ├── chromium-pool-do.ts    # Container DO wrapper, concurrency limiter, 503 retry, WS proxy
│   ├── cdp-client.ts          # Zero-dependency CDP WebSocket client
│   └── types.ts               # SessionSnapshot, RPC types, Env, WebGL hook script
├── container/
│   ├── Dockerfile             # node:22-slim + headless Chromium & minimal libs
│   ├── entrypoint.sh          # Supervised Chromium daemon + Node sidecar launcher
│   ├── server.ts              # Sidecar HTTP/WS server + CDP BrowserContext multiplexer
│   └── package.json           # Sidecar dependencies
└── test/
    └── escalation.test.ts     # Vitest suite covering all acceptance criteria
```

## Getting Started

### Prerequisites

- Node.js 22+
- Wrangler CLI (`npm install` installs it locally)
- Docker (for building/deploying the Cloudflare Container)

### Install Dependencies

```bash
npm install
cd container && npm install
```

### Typecheck & Test

```bash
npm run typecheck
npm test
```

### Local Development & Deployment

```bash
# Local dev
npm run dev

# Deploy Worker + Container to Cloudflare
npm run deploy
```

## API

### `GET /health`
Returns `{ "status": "ok" }`.

### `POST /render`
Request body:

```json
{
  "url": "https://example.com",
  "action": "screenshot",
  "viewport": { "width": 1280, "height": 720, "deviceScaleFactor": 1 },
  "cookies": [],
  "timeoutMs": 15000
}
```

- `action`: `"screenshot"` | `"html"` | `"screencast"`

### `GET /screencast?url=...`
WebSocket upgrade endpoint that streams CDP `Page.screencastFrame` payloads directly from the container sidecar.

## Configuration

Configured in `wrangler.jsonc`:

- `MAX_POOLS`: Number of sharded `ChromiumPoolDO` instances (default: `"4"`).
- `KITESURF_CDP_URL`: WebSocket URL for the Kitesurf CDP endpoint.
- `FORCE_CHROMIUM_PATTERNS`: Optional comma-separated URL patterns to bypass Kitesurf and route directly to Chromium (in addition to defaults: `threejs.org`, `shadertoy.com`, `webglsamples.org`).
- Container `instance_type`: `standard-2` (2 vCPU / 4 GiB RAM) to prevent SwiftShader frame drops and OOMs.
