import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
// @ts-ignore root devDependencies do not include @types/ws; runtime resolves ws cleanly
import { WebSocketServer, WebSocket } from "ws";

type WsClient = {
  readyState: number;
  send(data: string): void;
  terminate(): void;
  on(event: string, listener: (...args: any[]) => void): void;
};
type WsData = string | Buffer | ArrayBuffer | Buffer[];

// ---------------------------------------------------------------------------
// Mock `cloudflare:workers` and `@cloudflare/containers` Container runtime
// so ChromiumPoolDO can be instantiated and tested directly inside Vitest/Node.
// ---------------------------------------------------------------------------

type ContainerFetchHandler = (request: Request) => Promise<Response> | Response;

let activeContainerFetchHandler: ContainerFetchHandler = async () =>
  new Response("Mock container not configured", { status: 500 });

const containerSuperFetchSpy = vi.fn(async (request: Request) => {
  return activeContainerFetchHandler(request);
});

vi.mock("cloudflare:workers", () => {
  class DurableObject<E = unknown> {
    ctx: any;
    env: E;
    constructor(ctx: any, env: E) {
      this.ctx = ctx;
      this.env = env;
    }
  }
  class WorkerEntrypoint<E = unknown> {
    ctx: any;
    env: E;
    constructor(ctx: any, env: E) {
      this.ctx = ctx;
      this.env = env;
    }
  }
  return { DurableObject, WorkerEntrypoint };
});

vi.mock("@cloudflare/containers", async () => {
  class MockContainer {
    defaultPort?: number;
    sleepAfter: string | number = "10m";
    ctx: any;
    env: any;

    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }

    async fetch(request: Request): Promise<Response> {
      return containerSuperFetchSpy(request);
    }
  }

  return {
    Container: MockContainer,
  };
});

import worker, {
  FORCE_CHROMIUM_PATTERNS,
  hashUrlToPoolId,
  shouldForceChromium,
} from "../src/worker";
import {
  ChromiumPoolDO,
  MAX_CONTEXTS_PER_CONTAINER,
} from "../src/chromium-pool-do";
import {
  ESCALATION_BINDING_NAME,
  type Env,
  type RenderResult,
  type SessionSnapshot,
} from "../src/types";
import { createSidecarServer } from "../container/server";

// Valid minimal non-blank 1x1 PNG (RGBA red pixel)
const SAMPLE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

function isPngBuffer(buf: Buffer): boolean {
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return buf.length > pngSig.length && buf.subarray(0, 8).equals(pngSig);
}

// ---------------------------------------------------------------------------
// Mock Kitesurf CDP Server (WebSocket-based)
// ---------------------------------------------------------------------------
interface MockKitesurfPageConfig {
  html?: string;
  triggerWebGL?: boolean;
  webglContextType?: string;
  cookies?: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>;
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
  screenshotBase64?: string;
}

interface MockKitesurfServerHandle {
  wsUrl: string;
  commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }>;
  closedTargets: string[];
  closedPages: number;
  connectionCount: number;
  close: () => Promise<void>;
}

async function startMockKitesurfServer(
  getPageConfig: (url: string) => MockKitesurfPageConfig
): Promise<MockKitesurfServerHandle> {
  const server = http.createServer();
  const wss = new WebSocketServer({ server });

  const commands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const closedTargets: string[] = [];
  let closedPages = 0;
  let connectionCount = 0;
  let targetCounter = 0;
  let sessionCounter = 0;

  wss.on("connection", (ws: WsClient) => {
    connectionCount += 1;
    let currentUrl = "about:blank";
    let currentConfig: MockKitesurfPageConfig = {};
    let bindingRegistered = false;

    ws.on("message", (raw: WsData) => {
      const msg = JSON.parse(raw.toString("utf8")) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      const params = msg.params ?? {};
      commands.push({ method: msg.method, params, sessionId: msg.sessionId });

      const sendResult = (result: Record<string, unknown> = {}) => {
        ws.send(JSON.stringify({ id: msg.id, result }));
      };

      const sendEvent = (method: string, evtParams: Record<string, unknown> = {}, sessionId?: string) => {
        ws.send(JSON.stringify({ method, params: evtParams, sessionId }));
      };

      switch (msg.method) {
        case "Target.createTarget": {
          targetCounter += 1;
          sendResult({ targetId: `ks-target-${targetCounter}` });
          break;
        }
        case "Target.attachToTarget": {
          sessionCounter += 1;
          sendResult({ sessionId: `ks-session-${sessionCounter}` });
          break;
        }
        case "Target.closeTarget": {
          if (typeof params.targetId === "string") {
            closedTargets.push(params.targetId);
          }
          sendResult({ success: true });
          break;
        }
        case "Page.close": {
          closedPages += 1;
          sendResult({});
          break;
        }
        case "Runtime.addBinding": {
          if (params.name === ESCALATION_BINDING_NAME) {
            bindingRegistered = true;
          }
          sendResult({});
          break;
        }
        case "Page.navigate": {
          currentUrl = String(params.url ?? "about:blank");
          currentConfig = getPageConfig(currentUrl);
          sendResult({ frameId: "frame-1" });

          const evtSessionId = msg.sessionId;
          queueMicrotask(() => {
            if (ws.readyState !== WebSocket.OPEN) return;

            if (currentConfig.triggerWebGL && bindingRegistered) {
              // Simulate the page running scripts that set cookie + storage,
              // then calling canvas.getContext('webgl2'), triggering __escalateWebGL.
              sendEvent(
                "Runtime.bindingCalled",
                {
                  name: ESCALATION_BINDING_NAME,
                  payload: JSON.stringify({
                    reason: `getContext:${currentConfig.webglContextType ?? "webgl2"}`,
                    contextType: currentConfig.webglContextType ?? "webgl2",
                    href: currentUrl,
                  }),
                },
                evtSessionId
              );
            } else {
              sendEvent("Network.requestWillBeSent", { requestId: "req-1" }, evtSessionId);
              sendEvent("Network.loadingFinished", { requestId: "req-1" }, evtSessionId);
              sendEvent("Page.loadEventFired", { timestamp: Date.now() / 1000 }, evtSessionId);
            }
          });
          break;
        }
        case "Network.getAllCookies": {
          sendResult({ cookies: currentConfig.cookies ?? [] });
          break;
        }
        case "Runtime.evaluate": {
          const expr = String(params.expression ?? "");
          if (expr.includes("localStorage") && expr.includes("sessionStorage")) {
            let origin = "";
            try {
              origin = new URL(currentUrl).origin;
            } catch {
              origin = "";
            }
            sendResult({
              result: {
                value: {
                  origin,
                  local: currentConfig.localStorage ?? {},
                  session: currentConfig.sessionStorage ?? {},
                },
              },
            });
          } else if (expr.includes("outerHTML")) {
            sendResult({
              result: {
                value: currentConfig.html ?? "<html><body><h1>Kitesurf Fast Path</h1></body></html>",
              },
            });
          } else {
            sendResult({ result: { value: null } });
          }
          break;
        }
        case "Page.captureScreenshot": {
          sendResult({ data: currentConfig.screenshotBase64 ?? SAMPLE_PNG_BASE64 });
          break;
        }
        default: {
          sendResult({});
          break;
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;

  return {
    wsUrl: `ws://127.0.0.1:${addr.port}`,
    commands,
    closedTargets,
    closedPages,
    get connectionCount() {
      return connectionCount;
    },
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Chromium CDP Server (HTTP /json/version + WebSocket CDP)
// Tracks active browserContexts, targets, cookies, and init scripts.
// ---------------------------------------------------------------------------
interface MockChromiumCdpHandle {
  cdpHttpUrl: string;
  activeContexts: Set<string>;
  activeTargets: Set<string>;
  createdContextsCount: number;
  disposedContextsCount: number;
  recordedCommands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }>;
  setCookiesCalls: Array<{ sessionId?: string; cookies: unknown[] }>;
  addInitScriptCalls: Array<{ sessionId?: string; source: string }>;
  setAvailable: (available: boolean) => void;
  close: () => Promise<void>;
}

async function startMockChromiumCdpServer(options?: {
  navigationDelayMs?: number;
  screenshotBase64?: string;
}): Promise<MockChromiumCdpHandle> {
  let available = true;
  let contextSeq = 0;
  let targetSeq = 0;
  let sessionSeq = 0;

  const activeContexts = new Set<string>();
  const activeTargets = new Set<string>();
  const targetToContext = new Map<string, string>();
  const recordedCommands: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const setCookiesCalls: Array<{ sessionId?: string; cookies: unknown[] }> = [];
  const addInitScriptCalls: Array<{ sessionId?: string; source: string }> = [];
  let createdContextsCount = 0;
  let disposedContextsCount = 0;

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname === "/json/version") {
      if (!available) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Chromium CDP unavailable" }));
        return;
      }
      const addr = server.address() as AddressInfo;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          Browser: "HeadlessChrome/135.0.0.0",
          webSocketDebuggerUrl: `ws://127.0.0.1:${addr.port}/devtools/browser/mock`,
        })
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!available) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws: WsClient) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WsClient) => {
    ws.on("message", (raw: WsData) => {
      const msg = JSON.parse(raw.toString("utf8")) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      const params = msg.params ?? {};
      recordedCommands.push({ method: msg.method, params, sessionId: msg.sessionId });

      const sendResult = (result: Record<string, unknown> = {}) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: msg.id, result }));
        }
      };

      const sendEvent = (method: string, evtParams: Record<string, unknown> = {}, sessionId?: string) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ method, params: evtParams, sessionId }));
        }
      };

      switch (msg.method) {
        case "Target.createBrowserContext": {
          contextSeq += 1;
          createdContextsCount += 1;
          const browserContextId = `ctx-${contextSeq}`;
          activeContexts.add(browserContextId);
          sendResult({ browserContextId });
          break;
        }
        case "Target.disposeBrowserContext": {
          const browserContextId = String(params.browserContextId ?? "");
          if (activeContexts.delete(browserContextId)) {
            disposedContextsCount += 1;
          }
          // Disposing a browser context also closes any remaining targets belonging to it
          for (const [tid, cid] of targetToContext.entries()) {
            if (cid === browserContextId) {
              activeTargets.delete(tid);
              targetToContext.delete(tid);
            }
          }
          sendResult({});
          break;
        }
        case "Target.createTarget": {
          targetSeq += 1;
          const targetId = `target-${targetSeq}`;
          activeTargets.add(targetId);
          if (typeof params.browserContextId === "string") {
            targetToContext.set(targetId, params.browserContextId);
          }
          sendResult({ targetId });
          break;
        }
        case "Target.closeTarget": {
          const targetId = String(params.targetId ?? "");
          activeTargets.delete(targetId);
          targetToContext.delete(targetId);
          sendResult({ success: true });
          break;
        }
        case "Target.attachToTarget": {
          sessionSeq += 1;
          sendResult({ sessionId: `session-${sessionSeq}` });
          break;
        }
        case "Network.setCookies": {
          setCookiesCalls.push({
            sessionId: msg.sessionId,
            cookies: Array.isArray(params.cookies) ? params.cookies : [],
          });
          sendResult({});
          break;
        }
        case "Page.addScriptToEvaluateOnNewDocument": {
          addInitScriptCalls.push({
            sessionId: msg.sessionId,
            source: String(params.source ?? ""),
          });
          sendResult({ identifier: "script-1" });
          break;
        }
        case "Page.navigate": {
          const evtSessionId = msg.sessionId;
          sendResult({ frameId: "frame-1" });
          const delay = options?.navigationDelayMs ?? 0;
          const emitLoad = () => {
            sendEvent("Network.requestWillBeSent", { requestId: "r-1" }, evtSessionId);
            sendEvent("Network.loadingFinished", { requestId: "r-1" }, evtSessionId);
            sendEvent("Page.loadEventFired", { timestamp: Date.now() / 1000 }, evtSessionId);
          };
          if (delay > 0) {
            setTimeout(emitLoad, delay);
          } else {
            queueMicrotask(emitLoad);
          }
          break;
        }
        case "Runtime.evaluate": {
          const expr = String(params.expression ?? "");
          if (expr.includes("outerHTML")) {
            sendResult({ result: { value: "<html><body><canvas id='gl'></canvas></body></html>" } });
          } else {
            sendResult({ result: { value: undefined } });
          }
          break;
        }
        case "Page.captureScreenshot": {
          sendResult({ data: options?.screenshotBase64 ?? SAMPLE_PNG_BASE64 });
          break;
        }
        default: {
          sendResult({});
          break;
        }
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;

  return {
    cdpHttpUrl: `http://127.0.0.1:${addr.port}`,
    activeContexts,
    activeTargets,
    get createdContextsCount() {
      return createdContextsCount;
    },
    get disposedContextsCount() {
      return disposedContextsCount;
    },
    recordedCommands,
    setCookiesCalls,
    addInitScriptCalls,
    setAvailable: (next: boolean) => {
      available = next;
    },
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ---------------------------------------------------------------------------
// Helper to bind a real ChromiumPoolDO + HTTP Sidecar Server
// ---------------------------------------------------------------------------
function createChromiumPoolStub(doInstance: ChromiumPoolDO) {
  const recordedSnapshots: SessionSnapshot[] = [];
  return {
    recordedSnapshots,
    fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.method === "POST") {
        try {
          recordedSnapshots.push((await req.clone().json()) as SessionSnapshot);
        } catch {
          // ignore non-JSON bodies
        }
      }
      return doInstance.fetch(req);
    }),
  };
}

function createMockNamespace(doInstance: ChromiumPoolDO) {
  const stub = createChromiumPoolStub(doInstance);
  const idFromName = vi.fn((name: string) => ({ toString: () => name, name }));
  const get = vi.fn((_id: DurableObjectId) => stub as unknown as DurableObjectStub);
  return {
    namespace: {
      idFromName,
      get,
    } as unknown as DurableObjectNamespace,
    idFromName,
    get,
    stub,
  };
}

function createDoInstance(): ChromiumPoolDO {
  const ctx = {
    id: { toString: () => "pool-0" },
    storage: {},
    waitUntil: vi.fn(),
  } as unknown as DurableObjectState<{}>;
  return new ChromiumPoolDO(ctx, {} as Env);
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------
describe("Hybrid Kitesurf + Warm Chromium WebGL Escalation", () => {
  const cleanupCallbacks: Array<() => Promise<void>> = [];

  beforeEach(() => {
    containerSuperFetchSpy.mockClear();
  });

  afterEach(async () => {
    while (cleanupCallbacks.length > 0) {
      const fn = cleanupCallbacks.pop()!;
      await fn();
    }
  });

  it("1. Fast Path (Kitesurf): completes standard HTML/JS page on Kitesurf without touching ChromiumPoolDO", async () => {
    const kitesurf = await startMockKitesurfServer(() => ({
      triggerWebGL: false,
      html: "<html><body><h1>Standard Fast Page</h1></body></html>",
    }));
    cleanupCallbacks.push(kitesurf.close);

    const doInstance = createDoInstance();
    const pool = createMockNamespace(doInstance);

    const env: Env = {
      CHROMIUM_POOL: pool.namespace,
      KITESURF_CDP_URL: kitesurf.wsUrl,
      MAX_POOLS: "4",
    };

    const req = new Request("https://worker.example/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/article",
        action: "html",
      }),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);

    const body = (await res.json()) as RenderResult;
    expect(body.engine).toBe("kitesurf");
    expect(body.escalated).toBe(false);
    expect(body.action).toBe("html");
    expect(body.contentType).toBe("text/html");
    expect(body.data).toContain("Standard Fast Page");

    // 0 calls to Container DO
    expect(pool.get).not.toHaveBeenCalled();
    expect(pool.stub.fetch).not.toHaveBeenCalled();
    expect(containerSuperFetchSpy).not.toHaveBeenCalled();

    // Kitesurf target was properly closed
    expect(kitesurf.closedTargets.length).toBe(1);
  });

  it("2. Escalation & Render + Serdes Fidelity: aborts Kitesurf, extracts cookies/localStorage/sessionStorage, hydrates Chromium sidecar, returns non-blank PNG", async () => {
    const targetOrigin = "https://webgl-app.example.com";
    const targetUrl = `${targetOrigin}/scene`;

    const expectedCookies = [
      {
        name: "session_token",
        value: "tok_abc123",
        domain: "webgl-app.example.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
      {
        name: "theme",
        value: "dark",
        domain: "webgl-app.example.com",
        path: "/",
      },
    ];
    const expectedLocalStorage = {
      auth_user: "alice",
      shader_quality: "high",
    };
    const expectedSessionStorage = {
      camera_preset: "orbit-1",
      tab_id: "tab-42",
    };

    const kitesurf = await startMockKitesurfServer(() => ({
      triggerWebGL: true,
      webglContextType: "webgl2",
      cookies: expectedCookies,
      localStorage: expectedLocalStorage,
      sessionStorage: expectedSessionStorage,
    }));
    cleanupCallbacks.push(kitesurf.close);

    const cdpServer = await startMockChromiumCdpServer();
    cleanupCallbacks.push(cdpServer.close);

    const sidecar = createSidecarServer({
      cdpHttpUrl: cdpServer.cdpHttpUrl,
      networkIdleMs: 5,
      maxNetworkIdleWaitMs: 50,
    });
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", () => resolve()));
    cleanupCallbacks.push(
      () => new Promise<void>((resolve) => sidecar.close(() => resolve()))
    );
    const sidecarAddr = sidecar.address() as AddressInfo;
    const sidecarBaseUrl = `http://127.0.0.1:${sidecarAddr.port}`;

    // Wire Container base super.fetch -> live sidecar HTTP server
    activeContainerFetchHandler = async (request: Request) => {
      const target = new URL(request.url);
      const forwardUrl = `${sidecarBaseUrl}${target.pathname}${target.search}`;
      const res = await fetch(forwardUrl, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      });
      return new Response(res.body, {
        status: res.status,
        headers: res.headers,
      });
    };

    const doInstance = createDoInstance();
    const pool = createMockNamespace(doInstance);

    const env: Env = {
      CHROMIUM_POOL: pool.namespace,
      KITESURF_CDP_URL: kitesurf.wsUrl,
      MAX_POOLS: "4",
    };

    const req = new Request("https://worker.example/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: targetUrl,
        action: "screenshot",
        viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      }),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);

    const result = (await res.json()) as RenderResult;
    expect(result.engine).toBe("chromium");
    expect(result.escalated).toBe(true);
    expect(result.escalationReason).toBe("getContext:webgl2");
    expect(result.action).toBe("screenshot");
    expect(result.contentType).toBe("image/png");

    // Verify non-blank valid PNG returned
    const pngBytes = Buffer.from(result.data, "base64");
    expect(isPngBuffer(pngBytes)).toBe(true);
    expect(pngBytes.equals(Buffer.from(SAMPLE_PNG_BASE64, "base64"))).toBe(true);

    // Verify Kitesurf aborted without calling Page.captureScreenshot and closed its target
    const kitesurfMethods = kitesurf.commands.map((c) => c.method);
    expect(kitesurfMethods).toContain("Runtime.addBinding");
    expect(kitesurfMethods).toContain("Network.getAllCookies");
    expect(kitesurfMethods).toContain("Runtime.evaluate");
    expect(kitesurfMethods).not.toContain("Page.captureScreenshot");
    expect(kitesurf.closedTargets.length).toBe(1);

    // Verify snapshot forwarded to ChromiumPoolDO contained extracted state
    expect(pool.stub.fetch).toHaveBeenCalledTimes(1);
    expect(pool.stub.recordedSnapshots.length).toBe(1);
    const forwardedSnapshot = pool.stub.recordedSnapshots[0];
    expect(forwardedSnapshot.cookies).toEqual(expectedCookies);
    expect(forwardedSnapshot.localStorage).toEqual({
      [targetOrigin]: expectedLocalStorage,
    });
    expect(forwardedSnapshot.sessionStorage).toEqual({
      [targetOrigin]: expectedSessionStorage,
    });

    // Verify Chromium sidecar hydrated cookies via Network.setCookies
    expect(cdpServer.setCookiesCalls.length).toBe(1);
    expect(cdpServer.setCookiesCalls[0].cookies).toEqual(expectedCookies);

    // Verify Chromium sidecar hydrated localStorage + sessionStorage via Page.addScriptToEvaluateOnNewDocument guarded by location.origin
    expect(cdpServer.addInitScriptCalls.length).toBe(1);
    const initScript = cdpServer.addInitScriptCalls[0].source;
    expect(initScript).toContain("location.origin");
    expect(initScript).toContain(JSON.stringify(targetOrigin));
    expect(initScript).toContain("window.localStorage.setItem");
    expect(initScript).toContain("window.sessionStorage.setItem");
    expect(initScript).toContain('"auth_user":"alice"');
    expect(initScript).toContain('"shader_quality":"high"');
    expect(initScript).toContain('"camera_preset":"orbit-1"');
    expect(initScript).toContain('"tab_id":"tab-42"');

    // Verify Chromium CDP context was disposed cleanly
    expect(cdpServer.activeContexts.size).toBe(0);
    expect(cdpServer.activeTargets.size).toBe(0);
  });

  it("3. Static Allowlist (FORCE_CHROMIUM_PATTERNS): URLs matching threejs.org bypass Kitesurf completely", async () => {
    expect(FORCE_CHROMIUM_PATTERNS).toContain("threejs.org");
    expect(shouldForceChromium("https://threejs.org/examples/#webgl_animation_keyframes")).toBe(true);
    expect(shouldForceChromium("https://docs.threejs.org/manual/en/creating-a-scene")).toBe(true);
    expect(shouldForceChromium("https://example.com/plain")).toBe(false);

    const kitesurf = await startMockKitesurfServer(() => ({ triggerWebGL: false }));
    cleanupCallbacks.push(kitesurf.close);

    const cdpServer = await startMockChromiumCdpServer();
    cleanupCallbacks.push(cdpServer.close);

    const sidecar = createSidecarServer({
      cdpHttpUrl: cdpServer.cdpHttpUrl,
      networkIdleMs: 5,
      maxNetworkIdleWaitMs: 50,
    });
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", () => resolve()));
    cleanupCallbacks.push(
      () => new Promise<void>((resolve) => sidecar.close(() => resolve()))
    );
    const sidecarAddr = sidecar.address() as AddressInfo;

    activeContainerFetchHandler = async (request: Request) => {
      const target = new URL(request.url);
      const res = await fetch(`http://127.0.0.1:${sidecarAddr.port}${target.pathname}${target.search}`, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
      });
      return new Response(res.body, { status: res.status, headers: res.headers });
    };

    const doInstance = createDoInstance();
    const pool = createMockNamespace(doInstance);

    const env: Env = {
      CHROMIUM_POOL: pool.namespace,
      KITESURF_CDP_URL: kitesurf.wsUrl,
      MAX_POOLS: "4",
    };

    const req = new Request("https://worker.example/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://threejs.org/examples/webgl_geometries.html",
        action: "screenshot",
      }),
    });

    const res = await worker.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);

    const result = (await res.json()) as RenderResult;
    expect(result.engine).toBe("chromium");
    expect(result.escalated).toBe(true);
    expect(result.escalationReason).toBe("force_chromium_pattern");

    // Kitesurf must never be contacted
    expect(kitesurf.connectionCount).toBe(0);
    expect(kitesurf.commands.length).toBe(0);

    // ChromiumPoolDO must be called directly
    expect(pool.get).toHaveBeenCalledTimes(1);
    expect(pool.stub.fetch).toHaveBeenCalledTimes(1);
  });

  it("4. Concurrency Guard (MAX_CONTEXTS_PER_CONTAINER = 6): allows 6 concurrent requests and rejects the 7th with 429 + Retry-After", async () => {
    expect(MAX_CONTEXTS_PER_CONTAINER).toBe(6);

    const doInstance = createDoInstance();
    let releaseHolders: (() => void) | undefined;
    const holdPromise = new Promise<void>((resolve) => {
      releaseHolders = resolve;
    });

    let startedInContainer = 0;
    let allSixStartedResolve: (() => void) | undefined;
    const allSixStarted = new Promise<void>((resolve) => {
      allSixStartedResolve = resolve;
    });

    activeContainerFetchHandler = async () => {
      startedInContainer += 1;
      if (startedInContainer === MAX_CONTEXTS_PER_CONTAINER) {
        allSixStartedResolve?.();
      }
      await holdPromise;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    // Launch 6 concurrent requests that stay in-flight
    const sixRequests = Array.from({ length: MAX_CONTEXTS_PER_CONTAINER }, (_, idx) =>
      doInstance.fetch(
        new Request("https://chromium-pool/render", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: `https://example.com/gl-${idx}`, action: "screenshot" }),
        })
      )
    );

    await allSixStarted;
    expect(doInstance.activeContexts).toBe(MAX_CONTEXTS_PER_CONTAINER);

    // 7th concurrent request must be immediately rejected with 429 + Retry-After
    const seventhRes = await doInstance.fetch(
      new Request("https://chromium-pool/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/gl-overflow", action: "screenshot" }),
      })
    );

    expect(seventhRes.status).toBe(429);
    expect(seventhRes.headers.get("Retry-After")).toBe("1");

    // Release the 6 held requests and verify they all succeed and activeContexts drops back to 0
    releaseHolders?.();
    const results = await Promise.all(sixRequests);
    for (const res of results) {
      expect(res.status).toBe(200);
    }
    expect(doInstance.activeContexts).toBe(0);
  });

  it("5. Isolation & Cleanup: 10 concurrent WebGL /render requests against createSidecarServer leave 0 leaked contexts/targets", async () => {
    const cdpServer = await startMockChromiumCdpServer({ navigationDelayMs: 5 });
    cleanupCallbacks.push(cdpServer.close);

    const sidecar = createSidecarServer({
      cdpHttpUrl: cdpServer.cdpHttpUrl,
      networkIdleMs: 5,
      maxNetworkIdleWaitMs: 50,
    });
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", () => resolve()));
    cleanupCallbacks.push(
      () => new Promise<void>((resolve) => sidecar.close(() => resolve()))
    );
    const sidecarAddr = sidecar.address() as AddressInfo;

    const requests = Array.from({ length: 10 }, (_, idx) =>
      fetch(`http://127.0.0.1:${sidecarAddr.port}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `https://webgl.example.com/scene-${idx}`,
          action: "screenshot",
          viewport: { width: 800, height: 600 },
          localStorage: {
            [`https://webgl.example.com`]: { scene: `s-${idx}` },
          },
        }),
      })
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("image/png");
      const buf = Buffer.from(await res.arrayBuffer());
      expect(isPngBuffer(buf)).toBe(true);
    }

    expect(cdpServer.createdContextsCount).toBe(10);
    expect(cdpServer.disposedContextsCount).toBe(10);
    expect(cdpServer.activeContexts.size).toBe(0);
    expect(cdpServer.activeTargets.size).toBe(0);
  });

  it("6. Crash Recovery: sidecar returns 503 when Chromium CDP is unreachable, and ChromiumPoolDO retries once", async () => {
    const cdpServer = await startMockChromiumCdpServer();
    cleanupCallbacks.push(cdpServer.close);

    const sidecar = createSidecarServer({
      cdpHttpUrl: cdpServer.cdpHttpUrl,
      networkIdleMs: 5,
      maxNetworkIdleWaitMs: 50,
    });
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", () => resolve()));
    cleanupCallbacks.push(
      () => new Promise<void>((resolve) => sidecar.close(() => resolve()))
    );
    const sidecarAddr = sidecar.address() as AddressInfo;

    // 6a. Sidecar directly returns 503 when Chromium CDP is down
    cdpServer.setAvailable(false);
    const directDownRes = await fetch(`http://127.0.0.1:${sidecarAddr.port}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://webgl.example.com/crash-check",
        action: "screenshot",
      }),
    });
    expect(directDownRes.status).toBe(503);

    // 6b. ChromiumPoolDO retries once on 503 and succeeds when Chromium recovers before the retry
    let attempt = 0;
    activeContainerFetchHandler = async (request: Request) => {
      attempt += 1;
      if (attempt === 1) {
        cdpServer.setAvailable(false);
      } else {
        cdpServer.setAvailable(true);
      }

      const target = new URL(request.url);
      const res = await fetch(`http://127.0.0.1:${sidecarAddr.port}${target.pathname}${target.search}`, {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      });
      return new Response(res.body, { status: res.status, headers: res.headers });
    };

    const doInstance = createDoInstance();
    const recoveredRes = await doInstance.fetch(
      new Request("https://chromium-pool/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://webgl.example.com/recover",
          action: "screenshot",
        }),
      })
    );

    expect(attempt).toBe(2);
    expect(containerSuperFetchSpy).toHaveBeenCalledTimes(2);
    expect(recoveredRes.status).toBe(200);
    const recoveredPng = Buffer.from(await recoveredRes.arrayBuffer());
    expect(isPngBuffer(recoveredPng)).toBe(true);

    // 6c. If Chromium remains down across both attempts, ChromiumPoolDO stops after 1 retry (2 total calls) and returns 503
    containerSuperFetchSpy.mockClear();
    cdpServer.setAvailable(false);
    activeContainerFetchHandler = async (request: Request) => {
      const target = new URL(request.url);
      const res = await fetch(`http://127.0.0.1:${sidecarAddr.port}${target.pathname}${target.search}`, {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      });
      return new Response(res.body, { status: res.status, headers: res.headers });
    };

    const stillDownRes = await doInstance.fetch(
      new Request("https://chromium-pool/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: "https://webgl.example.com/still-down",
          action: "screenshot",
        }),
      })
    );
    expect(containerSuperFetchSpy).toHaveBeenCalledTimes(2);
    expect(stillDownRes.status).toBe(503);
    expect(doInstance.activeContexts).toBe(0);
  });

  it("7. Warm Handoff Latency: Kitesurf abort + snapshot extraction + DO handoff overhead completes well under 250 ms", async () => {
    const kitesurf = await startMockKitesurfServer(() => ({
      triggerWebGL: true,
      webglContextType: "webgl",
      cookies: [
        { name: "sid", value: "warm-handoff", domain: "fast-gl.example.com", path: "/" },
      ],
      localStorage: { k: "v" },
      sessionStorage: { s: "1" },
    }));
    cleanupCallbacks.push(kitesurf.close);

    const cdpServer = await startMockChromiumCdpServer();
    cleanupCallbacks.push(cdpServer.close);

    const sidecar = createSidecarServer({
      cdpHttpUrl: cdpServer.cdpHttpUrl,
      networkIdleMs: 0,
      maxNetworkIdleWaitMs: 10,
    });
    await new Promise<void>((resolve) => sidecar.listen(0, "127.0.0.1", () => resolve()));
    cleanupCallbacks.push(
      () => new Promise<void>((resolve) => sidecar.close(() => resolve()))
    );
    const sidecarAddr = sidecar.address() as AddressInfo;

    let handoffCompletedAt = 0;
    activeContainerFetchHandler = async (request: Request) => {
      handoffCompletedAt = performance.now();
      const target = new URL(request.url);
      const res = await fetch(`http://127.0.0.1:${sidecarAddr.port}${target.pathname}${target.search}`, {
        method: request.method,
        headers: request.headers,
        body: await request.arrayBuffer(),
      });
      return new Response(res.body, { status: res.status, headers: res.headers });
    };

    const doInstance = createDoInstance();
    const pool = createMockNamespace(doInstance);

    const env: Env = {
      CHROMIUM_POOL: pool.namespace,
      KITESURF_CDP_URL: kitesurf.wsUrl,
      MAX_POOLS: "4",
    };

    // Warm up hash helper and DO routing check
    expect(hashUrlToPoolId("https://fast-gl.example.com/demo", 4)).toBeGreaterThanOrEqual(0);

    const req = new Request("https://worker.example/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: "https://fast-gl.example.com/demo",
        action: "screenshot",
      }),
    });

    const start = performance.now();
    const res = await worker.fetch(req, env, {} as ExecutionContext);
    const totalMs = performance.now() - start;

    expect(res.status).toBe(200);
    const body = (await res.json()) as RenderResult;
    expect(body.engine).toBe("chromium");
    expect(body.escalated).toBe(true);

    const warmHandoffOverheadMs = handoffCompletedAt - start;
    expect(body.handoffMs).toBeDefined();
    expect(body.handoffMs!).toBeLessThan(250);
    expect(warmHandoffOverheadMs).toBeLessThan(250);
    expect(totalMs).toBeLessThan(250);
  });
});
