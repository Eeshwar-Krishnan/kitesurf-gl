import { CDPClient, type WebSocketFactory } from "./cdp-client";
import { ChromiumPoolDO } from "./chromium-pool-do";
import {
  ESCALATION_BINDING_NAME,
  WEBGL_ESCALATION_HOOK_SCRIPT,
  type BrowseRequest,
  type CookieParam,
  type Env,
  type RenderResult,
  type SessionSnapshot,
} from "./types";

export { ChromiumPoolDO };

export const FORCE_CHROMIUM_PATTERNS: readonly string[] = [
  "threejs.org",
  "shadertoy.com",
  "webglsamples.org",
];

const DEFAULT_VIEWPORT = {
  width: 1280,
  height: 720,
  deviceScaleFactor: 1,
} as const;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_POOLS = 4;
const NETWORK_IDLE_SETTLE_MS = 500;

export interface RunOnKitesurfOptions {
  webSocketFactory?: WebSocketFactory;
  cdpClient?: CDPClient;
  networkIdleMs?: number;
}

export class WebGLEscalationError extends Error {
  readonly snapshot: SessionSnapshot;
  readonly reason: string;
  readonly handoffMs: number;

  constructor(reason: string, snapshot: SessionSnapshot, handoffMs: number) {
    super(`WebGL escalation triggered: ${reason}`);
    this.name = "WebGLEscalationError";
    this.reason = reason;
    this.snapshot = snapshot;
    this.handoffMs = handoffMs;
  }
}

export type KitesurfRunOutcome =
  | { escalated: false; result: RenderResult }
  | { escalated: true; reason: string; snapshot: SessionSnapshot; handoffMs: number };

function jsonResponse(body: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

function parseMaxPools(env: Env): number {
  const parsed = Number.parseInt(env.MAX_POOLS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_POOLS;
}

/**
 * Deterministically hashes a URL string into a pool index in [0, maxPools).
 * Uses FNV-1a 32-bit hashing for fast, uniform distribution across URLs/origins.
 */
export function hashUrlToPoolId(url: string, maxPools: number = DEFAULT_MAX_POOLS): number {
  const safeMax = Number.isFinite(maxPools) && maxPools > 0 ? Math.floor(maxPools) : DEFAULT_MAX_POOLS;
  let hash = 0x811c9dc5;
  for (let i = 0; i < url.length; i += 1) {
    hash ^= url.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % safeMax;
}

/**
 * Checks whether a target URL should bypass Kitesurf and route directly to ChromiumPoolDO.
 */
export function shouldForceChromium(url: string, envPatterns?: string): boolean {
  const patterns: string[] = [...FORCE_CHROMIUM_PATTERNS];
  if (envPatterns) {
    for (const raw of envPatterns.split(",")) {
      const trimmed = raw.trim();
      if (trimmed) {
        patterns.push(trimmed);
      }
    }
  }

  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }

  const normalizedUrl = url.toLowerCase();
  const hostname = parsed?.hostname.toLowerCase() ?? "";

  return patterns.some((pattern) => {
    const p = pattern.toLowerCase();
    if (hostname && (hostname === p || hostname.endsWith(`.${p}`))) {
      return true;
    }
    return normalizedUrl.includes(p);
  });
}

function mapCdpCookiesToParams(rawCookies: unknown): CookieParam[] {
  if (!Array.isArray(rawCookies)) {
    return [];
  }
  const cookies: CookieParam[] = [];
  for (const c of rawCookies) {
    if (!c || typeof c !== "object") continue;
    const item = c as Record<string, unknown>;
    if (typeof item.name !== "string" || typeof item.value !== "string") continue;

    const cookie: CookieParam = {
      name: item.name,
      value: item.value,
      domain: typeof item.domain === "string" ? item.domain : "",
      path: typeof item.path === "string" ? item.path : "/",
    };

    if (typeof item.expires === "number" && item.expires > 0) {
      cookie.expires = item.expires;
    }
    if (typeof item.httpOnly === "boolean") {
      cookie.httpOnly = item.httpOnly;
    }
    if (typeof item.secure === "boolean") {
      cookie.secure = item.secure;
    }
    if (item.sameSite === "Strict" || item.sameSite === "Lax" || item.sameSite === "None") {
      cookie.sameSite = item.sameSite;
    }
    cookies.push(cookie);
  }
  return cookies;
}

/**
 * Extracts cookies, localStorage, and sessionStorage from an active CDP session
 * so the page session can be reconstructed on ChromiumPoolDO.
 */
export async function extractSessionSnapshot(
  cdp: CDPClient,
  req: BrowseRequest,
  sessionId?: string
): Promise<SessionSnapshot> {
  const viewport = {
    width: req.viewport?.width ?? DEFAULT_VIEWPORT.width,
    height: req.viewport?.height ?? DEFAULT_VIEWPORT.height,
    deviceScaleFactor: req.viewport?.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
  };

  const [cookieResult, storageResult] = await Promise.all([
    cdp.send<{ cookies?: unknown[] }>("Network.getAllCookies", {}, sessionId).catch(() => ({ cookies: [] })),
    cdp
      .send<{ result?: { value?: { origin?: string; local?: Record<string, string>; session?: Record<string, string> } } }>(
        "Runtime.evaluate",
        {
          expression: `(() => {
            var origin = typeof location !== "undefined" ? location.origin : "";
            var local = {};
            var session = {};
            try {
              if (typeof localStorage !== "undefined") {
                for (var i = 0; i < localStorage.length; i++) {
                  var k = localStorage.key(i);
                  if (k !== null) local[k] = String(localStorage.getItem(k));
                }
              }
            } catch (_) {}
            try {
              if (typeof sessionStorage !== "undefined") {
                for (var j = 0; j < sessionStorage.length; j++) {
                  var sk = sessionStorage.key(j);
                  if (sk !== null) session[sk] = String(sessionStorage.getItem(sk));
                }
              }
            } catch (_) {}
            return { origin: origin, local: local, session: session };
          })()`,
          returnByValue: true,
        },
        sessionId
      )
      .catch(() => ({ result: { value: undefined } })),
  ]);

  const storageVal = storageResult?.result?.value;
  let origin = storageVal?.origin || "";
  if (!origin) {
    try {
      origin = new URL(req.url).origin;
    } catch {
      origin = "";
    }
  }

  const localStorageMap: Record<string, Record<string, string>> = {};
  const sessionStorageMap: Record<string, Record<string, string>> = {};

  if (origin) {
    if (storageVal?.local && Object.keys(storageVal.local).length > 0) {
      localStorageMap[origin] = storageVal.local;
    }
    if (storageVal?.session && Object.keys(storageVal.session).length > 0) {
      sessionStorageMap[origin] = storageVal.session;
    }
  }

  const cookies = mapCdpCookiesToParams(cookieResult?.cookies);
  if (cookies.length === 0 && req.cookies?.length) {
    cookies.push(...req.cookies);
  }

  return {
    url: req.url,
    viewport,
    userAgent: req.userAgent,
    extraHeaders: req.extraHeaders,
    cookies,
    localStorage: localStorageMap,
    sessionStorage: sessionStorageMap,
    action: req.action,
    timeoutMs: req.timeoutMs,
  };
}

function parseEscalationReason(payload: unknown): string {
  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload) as { reason?: string };
      if (parsed && typeof parsed.reason === "string") {
        return parsed.reason;
      }
    } catch {
      return payload;
    }
    return payload;
  }
  return "webgl_context_requested";
}

function createInitialSnapshot(req: BrowseRequest): SessionSnapshot {
  return {
    url: req.url,
    viewport: {
      width: req.viewport?.width ?? DEFAULT_VIEWPORT.width,
      height: req.viewport?.height ?? DEFAULT_VIEWPORT.height,
      deviceScaleFactor: req.viewport?.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
    },
    userAgent: req.userAgent,
    extraHeaders: req.extraHeaders,
    cookies: req.cookies ? [...req.cookies] : [],
    localStorage: {},
    sessionStorage: {},
    action: req.action,
    timeoutMs: req.timeoutMs,
  };
}

function getPoolStub(env: Env, url: string): DurableObjectStub {
  const maxPools = parseMaxPools(env);
  const poolIndex = hashUrlToPoolId(url, maxPools);
  const id = env.CHROMIUM_POOL.idFromName(`pool-${poolIndex}`);
  return env.CHROMIUM_POOL.get(id);
}

/**
 * Executes a browse/render request against the fast-path Kitesurf CDP engine.
 * Races navigation + network idle against the `__escalateWebGL` runtime binding.
 * Always closes the Kitesurf CDP session/page in `finally`.
 */
export async function runOnKitesurf(
  req: BrowseRequest,
  env: Env,
  options: RunOnKitesurfOptions = {}
): Promise<KitesurfRunOutcome> {
  const cdpUrl = env.KITESURF_CDP_URL;
  if (!cdpUrl && !options.cdpClient) {
    throw new Error("KITESURF_CDP_URL is not configured");
  }

  const startTime = Date.now();
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const networkIdleMs = options.networkIdleMs ?? NETWORK_IDLE_SETTLE_MS;

  const cdp =
    options.cdpClient ??
    (await CDPClient.connect(cdpUrl!, {
      defaultTimeoutMs: timeoutMs,
      webSocketFactory: options.webSocketFactory,
    }));

  let sessionId: string | undefined;
  let targetId: string | undefined;

  const cleanupListeners: Array<() => void> = [];

  try {
    // Attempt to create/attach to an isolated target if Browser target endpoints are used;
    // gracefully fall back to page-level CDP connection if Target.createTarget is unsupported.
    try {
      const created = await cdp.send<{ targetId?: string }>("Target.createTarget", { url: "about:blank" });
      if (created?.targetId) {
        targetId = created.targetId;
        const attached = await cdp.send<{ sessionId?: string }>("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        if (attached?.sessionId) {
          sessionId = attached.sessionId;
        }
      }
    } catch {
      // Page-level CDP WebSocket does not require Target.createTarget
    }

    await Promise.all([
      cdp.send("Page.enable", {}, sessionId),
      cdp.send("Runtime.enable", {}, sessionId),
      cdp.send("Network.enable", {}, sessionId),
    ]);

    await cdp.send("Runtime.addBinding", { name: ESCALATION_BINDING_NAME }, sessionId);
    await cdp.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: WEBGL_ESCALATION_HOOK_SCRIPT },
      sessionId
    );

    const viewport = {
      width: req.viewport?.width ?? DEFAULT_VIEWPORT.width,
      height: req.viewport?.height ?? DEFAULT_VIEWPORT.height,
      deviceScaleFactor: req.viewport?.deviceScaleFactor ?? DEFAULT_VIEWPORT.deviceScaleFactor,
      mobile: false,
    };
    await cdp.send("Emulation.setDeviceMetricsOverride", viewport, sessionId);

    if (req.userAgent) {
      await cdp.send("Network.setUserAgentOverride", { userAgent: req.userAgent }, sessionId);
    }

    if (req.extraHeaders && Object.keys(req.extraHeaders).length > 0) {
      await cdp.send("Network.setExtraHTTPHeaders", { headers: req.extraHeaders }, sessionId);
    }

    if (req.cookies && req.cookies.length > 0) {
      await cdp.send(
        "Network.setCookies",
        {
          cookies: req.cookies.map((c) => ({
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path,
            expires: c.expires,
            httpOnly: c.httpOnly,
            secure: c.secure,
            sameSite: c.sameSite,
          })),
        },
        sessionId
      );
    }

    let escalated = false;
    let escalationReason = "";

    const escalationPromise = new Promise<{ type: "escalated"; reason: string }>((resolve) => {
      const off = cdp.on<{ name?: string; payload?: unknown }>(
        "Runtime.bindingCalled",
        (params, evtSessionId) => {
          if (sessionId && evtSessionId && evtSessionId !== sessionId) return;
          if (params?.name === ESCALATION_BINDING_NAME && !escalated) {
            escalated = true;
            escalationReason = parseEscalationReason(params.payload);
            resolve({ type: "escalated", reason: escalationReason });
          }
        }
      );
      cleanupListeners.push(off);
    });

    const loadAndIdlePromise = new Promise<{ type: "loaded" }>((resolve, reject) => {
      let inFlightRequests = 0;
      let pageLoaded = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let settled = false;

      const clearTimers = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimers();
        resolve({ type: "loaded" });
      };

      const scheduleIdleCheck = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (pageLoaded && inFlightRequests <= 0) {
          idleTimer = setTimeout(finish, networkIdleMs);
        }
      };

      cleanupListeners.push(() => {
        settled = true;
        clearTimers();
      });

      cleanupListeners.push(
        cdp.on("Network.requestWillBeSent", (_params, evtSessionId) => {
          if (sessionId && evtSessionId && evtSessionId !== sessionId) return;
          inFlightRequests += 1;
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        })
      );

      const onRequestDone = (_params: unknown, evtSessionId?: string) => {
        if (sessionId && evtSessionId && evtSessionId !== sessionId) return;
        inFlightRequests = Math.max(0, inFlightRequests - 1);
        scheduleIdleCheck();
      };

      cleanupListeners.push(cdp.on("Network.loadingFinished", onRequestDone));
      cleanupListeners.push(cdp.on("Network.loadingFailed", onRequestDone));

      cleanupListeners.push(
        cdp.on("Page.loadEventFired", (_params, evtSessionId) => {
          if (sessionId && evtSessionId && evtSessionId !== sessionId) return;
          pageLoaded = true;
          scheduleIdleCheck();
        })
      );

      timeoutTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          clearTimers();
          reject(new Error(`Kitesurf navigation timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
    });

    await cdp.send("Page.navigate", { url: req.url }, sessionId);

    const raceOutcome = await Promise.race([escalationPromise, loadAndIdlePromise]);

    if (raceOutcome.type === "escalated") {
      const snapshot = await extractSessionSnapshot(cdp, req, sessionId);
      const handoffMs = Date.now() - startTime;
      return {
        escalated: true,
        reason: raceOutcome.reason,
        snapshot,
        handoffMs,
      };
    }

    if (req.action === "screencast") {
      await cdp.send(
        "Page.startScreencast",
        { format: "jpeg", quality: 80, everyNthFrame: 1 },
        sessionId
      );
      return {
        escalated: false,
        result: {
          engine: "kitesurf",
          action: "html",
          contentType: "application/json",
          data: JSON.stringify({ status: "screencast_started", url: req.url }),
          escalated: false,
          durationMs: Date.now() - startTime,
        },
      };
    }

    if (req.action === "screenshot") {
      const screenshot = await cdp.send<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png" },
        sessionId
      );
      return {
        escalated: false,
        result: {
          engine: "kitesurf",
          action: "screenshot",
          contentType: "image/png",
          data: screenshot.data,
          escalated: false,
          durationMs: Date.now() - startTime,
        },
      };
    }

    const htmlEval = await cdp.send<{ result?: { value?: string } }>(
      "Runtime.evaluate",
      {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
      },
      sessionId
    );

    return {
      escalated: false,
      result: {
        engine: "kitesurf",
        action: "html",
        contentType: "text/html",
        data: htmlEval?.result?.value ?? "",
        escalated: false,
        durationMs: Date.now() - startTime,
      },
    };
  } finally {
    for (const off of cleanupListeners) {
      try {
        off();
      } catch {
        // ignore listener cleanup errors
      }
    }

    if (targetId) {
      try {
        await cdp.send("Target.closeTarget", { targetId });
      } catch {
        // ignore target close errors
      }
    } else {
      try {
        await cdp.send("Page.close", {}, sessionId);
      } catch {
        // ignore page close errors
      }
    }

    cdp.close();
  }
}

async function forwardSnapshotToChromiumPool(
  env: Env,
  snapshot: SessionSnapshot,
  escalationReason?: string,
  handoffMs?: number
): Promise<Response> {
  const stub = getPoolStub(env, snapshot.url);
  const doResponse = await stub.fetch("https://chromium-pool/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });

  if (!doResponse.ok) {
    return doResponse;
  }

  const contentType = doResponse.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    const result = (await doResponse.json()) as Partial<RenderResult>;
    const merged: RenderResult = {
      engine: "chromium",
      action: result.action ?? (snapshot.action === "screenshot" ? "screenshot" : "html"),
      contentType:
        result.contentType ??
        (snapshot.action === "screenshot" ? "image/png" : "text/html"),
      data: result.data ?? "",
      escalated: escalationReason !== undefined ? true : Boolean(result.escalated),
      escalationReason: escalationReason ?? result.escalationReason,
      durationMs: typeof result.durationMs === "number" ? result.durationMs : 0,
      handoffMs: handoffMs ?? result.handoffMs,
    };
    return jsonResponse(merged, 200);
  }

  if (contentType.includes("image/png")) {
    const buf = new Uint8Array(await doResponse.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buf.length; i += 1) {
      binary += String.fromCharCode(buf[i]);
    }
    const base64 = btoa(binary);
    const merged: RenderResult = {
      engine: "chromium",
      action: "screenshot",
      contentType: "image/png",
      data: base64,
      escalated: escalationReason !== undefined ? true : false,
      escalationReason,
      durationMs: handoffMs ?? 0,
      handoffMs,
    };
    return jsonResponse(merged, 200);
  }

  if (contentType.includes("text/html")) {
    const html = await doResponse.text();
    const merged: RenderResult = {
      engine: "chromium",
      action: "html",
      contentType: "text/html",
      data: html,
      escalated: escalationReason !== undefined ? true : false,
      escalationReason,
      durationMs: handoffMs ?? 0,
      handoffMs,
    };
    return jsonResponse(merged, 200);
  }

  return doResponse;
}

async function handleRender(request: Request, env: Env): Promise<Response> {
  let body: BrowseRequest;
  try {
    body = (await request.json()) as BrowseRequest;
  } catch {
    return jsonResponse({ error: "Invalid JSON request body" }, 400);
  }

  if (!body || typeof body.url !== "string" || !body.url) {
    return jsonResponse({ error: "Missing required 'url' field" }, 400);
  }

  if (body.action !== "screenshot" && body.action !== "html" && body.action !== "screencast") {
    return jsonResponse(
      { error: "Invalid 'action' field; expected 'screenshot', 'html', or 'screencast'" },
      400
    );
  }

  if (shouldForceChromium(body.url, env.FORCE_CHROMIUM_PATTERNS)) {
    const snapshot = createInitialSnapshot(body);
    return forwardSnapshotToChromiumPool(env, snapshot, "force_chromium_pattern", 0);
  }

  const outcome = await runOnKitesurf(body, env);
  if (!outcome.escalated) {
    return jsonResponse(outcome.result, 200);
  }

  return forwardSnapshotToChromiumPool(
    env,
    outcome.snapshot,
    outcome.reason,
    outcome.handoffMs
  );
}

async function handleScreencast(request: Request, env: Env): Promise<Response> {
  const urlObj = new URL(request.url);
  const targetUrl = urlObj.searchParams.get("url");
  if (!targetUrl) {
    return jsonResponse({ error: "Missing required 'url' query parameter" }, 400);
  }

  const upgrade = request.headers.get("upgrade")?.toLowerCase();
  if (upgrade !== "websocket") {
    return jsonResponse({ error: "Expected WebSocket upgrade for /screencast" }, 426);
  }

  const stub = getPoolStub(env, targetUrl);
  return stub.fetch(request);
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: "ok" }, 200);
    }

    if (request.method === "POST" && url.pathname === "/render") {
      return handleRender(request, env);
    }

    if (request.method === "GET" && url.pathname === "/screencast") {
      return handleScreencast(request, env);
    }

    return jsonResponse({ error: "Not Found" }, 404);
  },
};
