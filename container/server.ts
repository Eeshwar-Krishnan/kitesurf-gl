import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

export interface SnapshotViewport {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
}

export interface SnapshotCookie {
  name: string;
  value: string;
  url?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
  expires?: number;
}

export interface ScreencastOptions {
  format?: "jpeg" | "png";
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
}

export interface SessionSnapshot {
  url: string;
  action?: "screenshot" | "html";
  viewport?: SnapshotViewport;
  userAgent?: string;
  extraHeaders?: Record<string, string>;
  cookies?: SnapshotCookie[];
  localStorage?: Record<string, string | Record<string, string>>;
  sessionStorage?: Record<string, string | Record<string, string>>;
  screencast?: ScreencastOptions;
  timeoutMs?: number;
}

export interface SidecarServerOptions {
  cdpHttpUrl?: string;
  networkIdleMs?: number;
  maxNetworkIdleWaitMs?: number;
  navigationTimeoutMs?: number;
}

interface CdpVersionResponse {
  webSocketDebuggerUrl?: string;
  Browser?: string;
  [key: string]: unknown;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
  sessionId?: string;
}

class CdpUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdpUnavailableError";
  }
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

class CdpClient {
  private readonly ws: WebSocket;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (result: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();
  private readonly eventListeners = new Set<
    (method: string, params: Record<string, unknown>, sessionId?: string) => void
  >();
  private readonly closeListeners = new Set<(err?: Error) => void>();

  private constructor(ws: WebSocket) {
    this.ws = ws;

    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: CdpMessage;
      try {
        const text = typeof raw === "string" ? raw : raw.toString("utf8");
        msg = JSON.parse(text) as CdpMessage;
      } catch {
        return;
      }

      if (typeof msg.id === "number") {
        const entry = this.pending.get(msg.id);
        if (!entry) return;
        this.pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`CDP error (${msg.error.code ?? "unknown"}): ${msg.error.message ?? "unknown"}`));
        } else {
          entry.resolve(msg.result ?? {});
        }
        return;
      }

      if (msg.method) {
        const params = msg.params ?? {};
        for (const listener of this.eventListeners) {
          listener(msg.method, params, msg.sessionId);
        }
      }
    });

    const handleDisconnect = (err?: Error) => {
      if (this.closed) return;
      this.closed = true;
      const disconnectErr = err ?? new CdpUnavailableError("Chromium CDP WebSocket connection closed");
      for (const [, entry] of this.pending) {
        entry.reject(disconnectErr);
      }
      this.pending.clear();
      for (const listener of this.closeListeners) {
        listener(disconnectErr);
      }
    };

    ws.on("close", () => handleDisconnect());
    ws.on("error", (err: Error) =>
      handleDisconnect(new CdpUnavailableError(`Chromium CDP WebSocket error: ${err.message}`))
    );
  }

  static async connect(wsUrl: string, timeoutMs = 5000): Promise<CdpClient> {
    return new Promise<CdpClient>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(wsUrl);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(new CdpUnavailableError("Timed out connecting to Chromium CDP WebSocket"));
      }, timeoutMs);

      ws.once("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });

      ws.once("error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new CdpUnavailableError(`Failed to connect to Chromium CDP WebSocket: ${err.message}`));
      });
    });
  }

  onEvent(listener: (method: string, params: Record<string, unknown>, sessionId?: string) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onClose(listener: (err?: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  send<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpUnavailableError("Chromium CDP WebSocket is not open"));
    }

    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (result) => resolve(result as T),
        reject,
      });

      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(new CdpUnavailableError(`Failed to send CDP command ${method}: ${err.message}`));
        }
      });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function fetchCdpVersion(cdpHttpUrl: string, timeoutMs = 3000): Promise<CdpVersionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${cdpHttpUrl.replace(/\/$/, "")}/json/version`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new CdpUnavailableError(`Chromium /json/version returned HTTP ${res.status}`);
    }
    const data = (await res.json()) as CdpVersionResponse;
    if (!data.webSocketDebuggerUrl) {
      throw new CdpUnavailableError("Chromium /json/version missing webSocketDebuggerUrl");
    }
    return data;
  } catch (err) {
    if (err instanceof CdpUnavailableError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new CdpUnavailableError(`Failed to reach Chromium CDP at ${cdpHttpUrl}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req: IncomingMessage, maxBytes = 5 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new BadRequestError("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(raw));
      } catch {
        reject(new BadRequestError("Invalid JSON request body"));
      }
    });

    req.on("error", (err: Error) => reject(err));
  });
}

function validateSnapshot(input: unknown): SessionSnapshot {
  if (!input || typeof input !== "object") {
    throw new BadRequestError("SessionSnapshot must be a JSON object");
  }
  const snapshot = input as Partial<SessionSnapshot>;
  if (typeof snapshot.url !== "string" || snapshot.url.trim().length === 0) {
    throw new BadRequestError("SessionSnapshot.url is required");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(snapshot.url);
  } catch {
    throw new BadRequestError("SessionSnapshot.url must be a valid URL");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new BadRequestError("SessionSnapshot.url must use http or https protocol");
  }
  if (snapshot.action !== undefined && snapshot.action !== "screenshot" && snapshot.action !== "html") {
    throw new BadRequestError('SessionSnapshot.action must be "screenshot" or "html"');
  }
  return snapshot as SessionSnapshot;
}

function buildStorageInitScript(
  origin: string,
  localStorageData?: Record<string, string>,
  sessionStorageData?: Record<string, string>
): string | null {
  const hasLocal = localStorageData && Object.keys(localStorageData).length > 0;
  const hasSession = sessionStorageData && Object.keys(sessionStorageData).length > 0;
  if (!hasLocal && !hasSession) {
    return null;
  }

  return `(() => {
    try {
      if (window.location.origin !== ${JSON.stringify(origin)}) return;
      const localEntries = ${JSON.stringify(localStorageData ?? {})};
      for (const [k, v] of Object.entries(localEntries)) {
        window.localStorage.setItem(k, String(v));
      }
      const sessionEntries = ${JSON.stringify(sessionStorageData ?? {})};
      for (const [k, v] of Object.entries(sessionEntries)) {
        window.sessionStorage.setItem(k, String(v));
      }
    } catch (_) {}
  })();`;
}

async function hydrateSession(cdp: CdpClient, sessionId: string, snapshot: SessionSnapshot): Promise<void> {
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);

  if (snapshot.viewport) {
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: snapshot.viewport.width,
        height: snapshot.viewport.height,
        deviceScaleFactor: snapshot.viewport.deviceScaleFactor ?? 1,
        mobile: snapshot.viewport.mobile ?? false,
      },
      sessionId
    );
  }

  if (snapshot.userAgent) {
    await cdp.send(
      "Emulation.setUserAgentOverride",
      {
        userAgent: snapshot.userAgent,
      },
      sessionId
    );
  }

  if (snapshot.extraHeaders && Object.keys(snapshot.extraHeaders).length > 0) {
    await cdp.send(
      "Network.setExtraHTTPHeaders",
      {
        headers: snapshot.extraHeaders,
      },
      sessionId
    );
  }

  if (snapshot.cookies && snapshot.cookies.length > 0) {
    const cookies = snapshot.cookies.map((cookie) => ({
      ...cookie,
      ...(cookie.url || cookie.domain ? {} : { url: snapshot.url }),
    }));
    await cdp.send("Network.setCookies", { cookies }, sessionId);
  }

  const origin = new URL(snapshot.url).origin;
  const localForOrigin = snapshot.localStorage?.[origin] as Record<string, string> | string | undefined;
  const sessionForOrigin = snapshot.sessionStorage?.[origin] as Record<string, string> | string | undefined;
  const resolvedLocal =
    localForOrigin && typeof localForOrigin === "object"
      ? localForOrigin
      : (snapshot.localStorage as Record<string, string> | undefined);
  const resolvedSession =
    sessionForOrigin && typeof sessionForOrigin === "object"
      ? sessionForOrigin
      : (snapshot.sessionStorage as Record<string, string> | undefined);
  const storageScript = buildStorageInitScript(origin, resolvedLocal, resolvedSession);
  if (storageScript) {
    await cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: storageScript,
      },
      sessionId
    );
  }
}

async function navigateAndWait(
  cdp: CdpClient,
  sessionId: string,
  url: string,
  options: { navigationTimeoutMs: number; networkIdleMs: number; maxNetworkIdleWaitMs: number }
): Promise<void> {
  let inflight = 0;
  let loadFired = false;
  let resolveLoad: (() => void) | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveIdle: (() => void) | null = null;

  const scheduleIdleCheck = () => {
    if (!resolveIdle) return;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (inflight <= 0) {
      idleTimer = setTimeout(() => {
        if (resolveIdle) {
          const done = resolveIdle;
          resolveIdle = null;
          done();
        }
      }, options.networkIdleMs);
    }
  };

  const unsubscribeEvents = cdp.onEvent((method, _params, evtSessionId) => {
    if (evtSessionId && evtSessionId !== sessionId) return;

    if (method === "Page.loadEventFired") {
      loadFired = true;
      if (resolveLoad) {
        const done = resolveLoad;
        resolveLoad = null;
        done();
      }
    } else if (method === "Network.requestWillBeSent") {
      inflight++;
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
      inflight = Math.max(0, inflight - 1);
      scheduleIdleCheck();
    }
  });

  try {
    const loadPromise = new Promise<void>((resolve, reject) => {
      if (loadFired) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        resolveLoad = null;
        reject(new Error(`Navigation timed out after ${options.navigationTimeoutMs}ms`));
      }, options.navigationTimeoutMs);

      const unsubClose = cdp.onClose((err) => {
        clearTimeout(timer);
        reject(err ?? new CdpUnavailableError("CDP connection closed during navigation"));
      });

      resolveLoad = () => {
        clearTimeout(timer);
        unsubClose();
        resolve();
      };
    });

    const navResult = await cdp.send<{ errorText?: string }>("Page.navigate", { url }, sessionId);
    if (navResult.errorText) {
      throw new Error(`Page navigation failed: ${navResult.errorText}`);
    }

    await loadPromise;

    await new Promise<void>((resolve) => {
      const capTimer = setTimeout(() => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        resolveIdle = null;
        resolve();
      }, options.maxNetworkIdleWaitMs);

      const unsubClose = cdp.onClose(() => {
        clearTimeout(capTimer);
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        resolveIdle = null;
        resolve();
      });

      resolveIdle = () => {
        clearTimeout(capTimer);
        unsubClose();
        resolve();
      };

      scheduleIdleCheck();
    });

    await cdp.send(
      "Runtime.evaluate",
      {
        expression: "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        awaitPromise: true,
      },
      sessionId
    );
  } finally {
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    unsubscribeEvents();
  }
}

async function disposeContext(cdp: CdpClient | null, browserContextId?: string, targetId?: string): Promise<void> {
  if (!cdp) return;
  if (targetId) {
    try {
      await cdp.send("Target.closeTarget", { targetId });
    } catch {
      // ignore cleanup errors if target or connection already closed
    }
  }
  if (browserContextId) {
    try {
      await cdp.send("Target.disposeBrowserContext", { browserContextId });
    } catch {
      // ignore cleanup errors if context or connection already closed
    }
  }
  cdp.close();
}

export function createSidecarServer(options: SidecarServerOptions = {}): http.Server {
  const cdpHttpUrl = options.cdpHttpUrl ?? process.env.CDP_URL ?? "http://127.0.0.1:9222";
  const defaultNetworkIdleMs = options.networkIdleMs ?? 300;
  const defaultMaxNetworkIdleWaitMs = options.maxNetworkIdleWaitMs ?? 5000;
  const defaultNavigationTimeoutMs = options.navigationTimeoutMs ?? 30000;

  const wss = new WebSocketServer({ noServer: true });

  const server = http.createServer(async (req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && reqUrl.pathname === "/health") {
      try {
        const version = await fetchCdpVersion(cdpHttpUrl);
        sendJson(res, 200, { status: "ok", browser: version });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendJson(res, 503, { status: "unavailable", error: message });
      }
      return;
    }

    if (req.method === "POST" && reqUrl.pathname === "/render") {
      let cdp: CdpClient | null = null;
      let browserContextId: string | undefined;
      let targetId: string | undefined;

      try {
        const body = await readJsonBody(req);
        const snapshot = validateSnapshot(body);
        const action = snapshot.action ?? "screenshot";

        const version = await fetchCdpVersion(cdpHttpUrl);
        cdp = await CdpClient.connect(version.webSocketDebuggerUrl!);

        const createdCtx = await cdp.send<{ browserContextId: string }>("Target.createBrowserContext", {
          disposeOnDetach: true,
        });
        browserContextId = createdCtx.browserContextId;

        const createdTarget = await cdp.send<{ targetId: string }>("Target.createTarget", {
          url: "about:blank",
          browserContextId,
        });
        targetId = createdTarget.targetId;

        const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const sessionId = attached.sessionId;

        await hydrateSession(cdp, sessionId, snapshot);

        await navigateAndWait(cdp, sessionId, snapshot.url, {
          navigationTimeoutMs: snapshot.timeoutMs ?? defaultNavigationTimeoutMs,
          networkIdleMs: defaultNetworkIdleMs,
          maxNetworkIdleWaitMs: defaultMaxNetworkIdleWaitMs,
        });

        if (action === "html") {
          const evalResult = await cdp.send<{ result?: { value?: unknown } }>(
            "Runtime.evaluate",
            {
              expression: "document.documentElement.outerHTML",
              returnByValue: true,
            },
            sessionId
          );
          const html = typeof evalResult.result?.value === "string" ? evalResult.result.value : "";
          const buf = Buffer.from(html, "utf8");
          await disposeContext(cdp, browserContextId, targetId);
          cdp = null;
          browserContextId = undefined;
          targetId = undefined;
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": buf.length,
          });
          res.end(buf);
        } else {
          const shot = await cdp.send<{ data: string }>(
            "Page.captureScreenshot",
            { format: "png" },
            sessionId
          );
          const png = Buffer.from(shot.data, "base64");
          await disposeContext(cdp, browserContextId, targetId);
          cdp = null;
          browserContextId = undefined;
          targetId = undefined;
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Content-Length": png.length,
          });
          res.end(png);
        }
      } catch (err) {
        if (err instanceof BadRequestError) {
          sendJson(res, 400, { error: err.message });
        } else if (err instanceof CdpUnavailableError) {
          sendJson(res, 503, { error: err.message });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          sendJson(res, 500, { error: message });
        }
      } finally {
        await disposeContext(cdp, browserContextId, targetId);
      }
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  server.on("upgrade", (req, socket, head) => {
    const reqUrl = new URL(req.url ?? "/", "http://localhost");
    if (reqUrl.pathname !== "/screencast") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (clientWs) => {
      wss.emit("connection", clientWs, req);
    });
  });

  wss.on("connection", async (clientWs: WebSocket, req: IncomingMessage) => {
    let cdp: CdpClient | null = null;
    let browserContextId: string | undefined;
    let targetId: string | undefined;
    let cleanedUp = false;
    let unsubEvents: (() => void) | null = null;
    let unsubClose: (() => void) | null = null;

    const cleanup = async () => {
      if (cleanedUp) return;
      cleanedUp = true;
      unsubEvents?.();
      unsubClose?.();
      await disposeContext(cdp, browserContextId, targetId);
    };

    clientWs.once("close", () => {
      void cleanup();
    });

    clientWs.once("error", () => {
      void cleanup();
    });

    try {
      const reqUrl = new URL(req.url ?? "/screencast", "http://localhost");
      const rawQuerySnapshot = reqUrl.searchParams.get("snapshot");

      let rawSnapshot: unknown;
      if (rawQuerySnapshot) {
        try {
          rawSnapshot = JSON.parse(rawQuerySnapshot);
        } catch {
          throw new BadRequestError("Invalid JSON in snapshot query parameter");
        }
      } else {
        rawSnapshot = await new Promise<unknown>((resolve, reject) => {
          const onMessage = (data: WebSocket.RawData) => {
            clientWs.off("close", onClose);
            try {
              const text = typeof data === "string" ? data : data.toString("utf8");
              resolve(JSON.parse(text));
            } catch {
              reject(new BadRequestError("Invalid JSON in initial screencast message"));
            }
          };
          const onClose = () => {
            clientWs.off("message", onMessage);
            reject(new BadRequestError("Client disconnected before sending SessionSnapshot"));
          };
          clientWs.once("message", onMessage);
          clientWs.once("close", onClose);
        });
      }

      if (clientWs.readyState !== WebSocket.OPEN) {
        await cleanup();
        return;
      }

      const snapshot = validateSnapshot(rawSnapshot);
      const version = await fetchCdpVersion(cdpHttpUrl);
      cdp = await CdpClient.connect(version.webSocketDebuggerUrl!);

      if (clientWs.readyState !== WebSocket.OPEN) {
        await cleanup();
        return;
      }

      const createdCtx = await cdp.send<{ browserContextId: string }>("Target.createBrowserContext", {
        disposeOnDetach: true,
      });
      browserContextId = createdCtx.browserContextId;

      const createdTarget = await cdp.send<{ targetId: string }>("Target.createTarget", {
        url: "about:blank",
        browserContextId,
      });
      targetId = createdTarget.targetId;

      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const sessionId = attached.sessionId;

      unsubClose = cdp.onClose(() => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close(1013, "Chromium CDP connection lost");
        }
        void cleanup();
      });

      unsubEvents = cdp.onEvent((method, params, evtSessionId) => {
        if (evtSessionId && evtSessionId !== sessionId) return;
        if (method !== "Page.screencastFrame") return;

        const frameAckId = params.sessionId as number | undefined;
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(
            JSON.stringify({
              type: "frame",
              data: params.data,
              metadata: params.metadata,
              sessionId: frameAckId,
            })
          );
        }

        if (typeof frameAckId === "number" && cdp) {
          void cdp.send("Page.screencastFrameAck", { sessionId: frameAckId }, sessionId).catch(() => {
            // ignore ack errors if closing
          });
        }
      });

      await hydrateSession(cdp, sessionId, snapshot);

      const navResult = await cdp.send<{ errorText?: string }>(
        "Page.navigate",
        { url: snapshot.url },
        sessionId
      );
      if (navResult.errorText) {
        throw new Error(`Page navigation failed: ${navResult.errorText}`);
      }

      const screencastParams: Record<string, unknown> = {
        format: snapshot.screencast?.format ?? "jpeg",
        quality: snapshot.screencast?.quality ?? 80,
        everyNthFrame: snapshot.screencast?.everyNthFrame ?? 1,
      };
      const maxWidth = snapshot.screencast?.maxWidth ?? snapshot.viewport?.width;
      const maxHeight = snapshot.screencast?.maxHeight ?? snapshot.viewport?.height;
      if (maxWidth !== undefined) screencastParams.maxWidth = maxWidth;
      if (maxHeight !== undefined) screencastParams.maxHeight = maxHeight;

      await cdp.send("Page.startScreencast", screencastParams, sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "error", error: message }));
        const code = err instanceof BadRequestError ? 1008 : err instanceof CdpUnavailableError ? 1013 : 1011;
        clientWs.close(code, message.slice(0, 120));
      }
      await cleanup();
    }
  });

  server.on("close", () => {
    for (const client of wss.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    wss.close();
  });

  return server;
}

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const server = createSidecarServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`[sidecar] Listening on port ${port}`);
  });

  const shutdown = () => {
    server.close(() => {
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
