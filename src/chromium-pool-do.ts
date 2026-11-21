import { Container } from "@cloudflare/containers";

export const MAX_CONTEXTS_PER_CONTAINER = 6;
const RETRY_BACKOFF_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildContainerRequest(request: Request, targetPath?: string): Request {
  if (!targetPath) {
    return request;
  }
  const url = new URL(request.url);
  url.pathname = targetPath;
  return new Request(url.toString(), request);
}

/**
 * Durable Object backed by a Cloudflare Container running headless Chromium + Playwright sidecar.
 * Enforces per-container concurrency limits, forwards screencast WebSockets to `/screencast`,
 * and performs single-retry recovery on transient 503 container/browser crashes.
 */
export class ChromiumPoolDO extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";

  private inFlight = 0;

  get activeContexts(): number {
    return this.inFlight;
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.inFlight >= MAX_CONTEXTS_PER_CONTAINER) {
      return new Response(
        JSON.stringify({
          error: "Too Many Requests",
          message: `Chromium pool container reached max concurrency (${MAX_CONTEXTS_PER_CONTAINER})`,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "1",
          },
        }
      );
    }

    const isWebSocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    const forwardRequest = isWebSocket
      ? buildContainerRequest(request, "/screencast")
      : request;

    this.inFlight += 1;
    let handedOffToWebSocket = false;

    try {
      let response = await this.forwardWithRetry(forwardRequest, isWebSocket);

      if (isWebSocket && response.status === 101) {
        const bridged = this.bridgeWebSocketIfSupported(response);
        if (bridged) {
          handedOffToWebSocket = true;
          return bridged;
        }
      }

      return response;
    } finally {
      if (!handedOffToWebSocket) {
        this.inFlight = Math.max(0, this.inFlight - 1);
      }
    }
  }

  private async forwardWithRetry(request: Request, isWebSocket: boolean): Promise<Response> {
    const attemptRequest = isWebSocket ? request : (request.clone() as unknown as Request);
    let response = await super.fetch(request);

    if (response.status === 503) {
      // Cancel/drain the failed response body before retrying.
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      await sleep(RETRY_BACKOFF_MS);
      response = await super.fetch(attemptRequest);
    }

    return response;
  }

  private bridgeWebSocketIfSupported(upstreamResponse: Response): Response | null {
    const upstreamWs = (upstreamResponse as unknown as { webSocket?: WebSocket }).webSocket;
    const PairCtor = (globalThis as unknown as { WebSocketPair?: new () => { 0: WebSocket; 1: WebSocket } }).WebSocketPair;

    if (!upstreamWs || typeof PairCtor !== "function") {
      return null;
    }

    const pair = new PairCtor();
    const clientWs = pair[0];
    const serverWs = pair[1] as WebSocket & { accept(): void };

    (upstreamWs as WebSocket & { accept(): void }).accept();
    serverWs.accept();

    let released = false;
    const releaseSlot = () => {
      if (released) return;
      released = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
    };

    const safeClose = (ws: WebSocket, code?: number, reason?: string) => {
      try {
        if (ws.readyState === 0 || ws.readyState === 1) {
          ws.close(code && code >= 1000 && code <= 4999 ? code : 1000, reason);
        }
      } catch {
        // ignore close errors
      }
    };

    serverWs.addEventListener("message", (event: MessageEvent) => {
      try {
        upstreamWs.send(event.data);
      } catch {
        safeClose(upstreamWs, 1011, "Upstream send failed");
        safeClose(serverWs, 1011, "Upstream send failed");
        releaseSlot();
      }
    });

    upstreamWs.addEventListener("message", (event: MessageEvent) => {
      try {
        serverWs.send(event.data);
      } catch {
        safeClose(serverWs, 1011, "Client send failed");
        safeClose(upstreamWs, 1011, "Client send failed");
        releaseSlot();
      }
    });

    serverWs.addEventListener("close", (event: CloseEvent) => {
      safeClose(upstreamWs, event.code, event.reason);
      releaseSlot();
    });

    upstreamWs.addEventListener("close", (event: CloseEvent) => {
      safeClose(serverWs, event.code, event.reason);
      releaseSlot();
    });

    serverWs.addEventListener("error", () => {
      safeClose(upstreamWs, 1011, "Client WebSocket error");
      releaseSlot();
    });

    upstreamWs.addEventListener("error", () => {
      safeClose(serverWs, 1011, "Upstream WebSocket error");
      releaseSlot();
    });

    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    } as ResponseInit & { webSocket: WebSocket });
  }
}
