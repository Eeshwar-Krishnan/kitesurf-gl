export interface CookieParam {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface SessionSnapshot {
  url: string;
  viewport: { width: number; height: number; deviceScaleFactor?: number };
  userAgent?: string;
  extraHeaders?: Record<string, string>;
  cookies: CookieParam[];
  /** Keyed by origin (e.g. "https://example.com") */
  localStorage: Record<string, Record<string, string>>;
  sessionStorage: Record<string, Record<string, string>>;
  action: "screenshot" | "html" | "screencast";
  timeoutMs?: number;
}

export interface BrowseRequest {
  url: string;
  cookies?: CookieParam[];
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  userAgent?: string;
  extraHeaders?: Record<string, string>;
  action: "screenshot" | "html" | "screencast";
  timeoutMs?: number;
}

export interface RenderResult {
  engine: "kitesurf" | "chromium";
  action: "screenshot" | "html";
  contentType: string;
  data: string;
  escalated: boolean;
  escalationReason?: string;
  durationMs: number;
  handoffMs?: number;
}

export interface Env {
  CHROMIUM_POOL: DurableObjectNamespace;
  KITESURF_CDP_URL?: string;
  MAX_POOLS?: string;
  FORCE_CHROMIUM_PATTERNS?: string;
}

export const ESCALATION_BINDING_NAME = "__escalateWebGL";

export const WEBGL_ESCALATION_HOOK_SCRIPT = `(() => {
  if (globalThis.__webglEscalationHookInstalled) return;
  globalThis.__webglEscalationHookInstalled = true;

  var triggered = false;
  var WEBGL_TYPES = {
    webgl: true,
    webgl2: true,
    "experimental-webgl": true
  };

  function notifyEscalation(contextType) {
    if (triggered) return;
    triggered = true;
    try {
      var binding = globalThis["${ESCALATION_BINDING_NAME}"];
      if (typeof binding === "function") {
        binding(
          JSON.stringify({
            reason: "getContext:" + contextType,
            contextType: contextType,
            href: typeof location !== "undefined" ? location.href : ""
          })
        );
      }
    } catch (_) {
      // Ignore binding invocation errors inside page context
    }
  }

  function wrapGetContext(proto) {
    if (!proto || typeof proto.getContext !== "function") return;
    var originalGetContext = proto.getContext;
    proto.getContext = function (contextType) {
      try {
        var normalized = typeof contextType === "string" ? contextType.toLowerCase() : "";
        if (WEBGL_TYPES[normalized]) {
          notifyEscalation(normalized);
        }
      } catch (_) {
        // Never break page execution on hook inspection errors
      }
      return originalGetContext.apply(this, arguments);
    };
  }

  if (typeof HTMLCanvasElement !== "undefined") {
    wrapGetContext(HTMLCanvasElement.prototype);
  }
  if (typeof OffscreenCanvas !== "undefined") {
    wrapGetContext(OffscreenCanvas.prototype);
  }
})();`;
