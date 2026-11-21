export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?(type: string, listener: (event: any) => void): void;
  removeEventListener?(type: string, listener: (event: any) => void): void;
  onopen?: ((event: any) => void) | null;
  onmessage?: ((event: any) => void) | null;
  onclose?: ((event: any) => void) | null;
  onerror?: ((event: any) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike | Promise<WebSocketLike>;

export interface CDPClientOptions {
  /** Default timeout in milliseconds for `send()` calls. Defaults to 30000. */
  defaultTimeoutMs?: number;
  /** Optional custom WebSocket factory (useful for testing or custom transports). */
  webSocketFactory?: WebSocketFactory;
}

export type CDPEventHandler<T = any> = (params: T, sessionId?: string) => void;

export class CDPError extends Error {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = "CDPError";
    this.code = code;
    this.data = data;
  }
}

interface PendingRequest {
  method: string;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const WS_OPEN = 1;

/**
 * Lightweight, zero-dependency Chrome DevTools Protocol (CDP) client over standard WebSocket.
 * Compatible with Cloudflare Workers, Node 22+, and browsers.
 */
export class CDPClient {
  private readonly url: string;
  private readonly defaultTimeoutMs: number;
  private readonly webSocketFactory: WebSocketFactory;

  private ws: WebSocketLike | null = null;
  private nextId = 1;
  private closed = false;
  private pending = new Map<number, PendingRequest>();
  private listeners = new Map<string, Set<CDPEventHandler>>();
  private connectPromise: Promise<void> | null = null;
  private cleanupSocketListeners: (() => void) | null = null;

  constructor(url: string, options: CDPClientOptions = {}) {
    this.url = url;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
    this.webSocketFactory = options.webSocketFactory ?? ((targetUrl) => new WebSocket(targetUrl));
  }

  static async connect(url: string, options: CDPClientOptions = {}): Promise<CDPClient> {
    const client = new CDPClient(url, options);
    await client.connect();
    return client;
  }

  get isConnected(): boolean {
    return !this.closed && this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("CDPClient is closed");
    }
    if (this.isConnected) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>(async (resolve, reject) => {
      let settled = false;
      const settleResolve = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const settleReject = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };

      try {
        const ws = await this.webSocketFactory(this.url);
        if (this.closed) {
          try {
            ws.close(1000, "Client closed before connect completed");
          } catch {
            // ignore
          }
          settleReject(new Error("CDPClient was closed while connecting"));
          return;
        }

        this.ws = ws;

        const onOpen = () => {
          settleResolve();
        };

        const onMessage = (event: any) => {
          this.handleMessage(event?.data ?? event);
        };

        const onError = (event: any) => {
          const message =
            event?.message ||
            event?.error?.message ||
            "WebSocket error on CDP connection";
          const err = new Error(message);
          if (!settled) {
            settleReject(err);
          }
          this.rejectAllPending(err);
        };

        const onClose = (event: any) => {
          const code = event?.code ?? 1006;
          const reason = event?.reason || "WebSocket closed";
          const err = new Error(`CDP WebSocket closed (${code}): ${reason}`);
          if (!settled) {
            settleReject(err);
          }
          this.closed = true;
          this.rejectAllPending(err);
        };

        if (typeof ws.addEventListener === "function") {
          ws.addEventListener("open", onOpen);
          ws.addEventListener("message", onMessage);
          ws.addEventListener("error", onError);
          ws.addEventListener("close", onClose);
          this.cleanupSocketListeners = () => {
            if (typeof ws.removeEventListener === "function") {
              ws.removeEventListener("open", onOpen);
              ws.removeEventListener("message", onMessage);
              ws.removeEventListener("error", onError);
              ws.removeEventListener("close", onClose);
            }
          };
        } else {
          ws.onopen = onOpen;
          ws.onmessage = onMessage;
          ws.onerror = onError;
          ws.onclose = onClose;
          this.cleanupSocketListeners = () => {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
          };
        }

        if (ws.readyState === WS_OPEN) {
          settleResolve();
        }
      } catch (err) {
        settleReject(err instanceof Error ? err : new Error(String(err)));
      }
    }).finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  async send<TResult = any>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs: number = this.defaultTimeoutMs
  ): Promise<TResult> {
    if (this.closed) {
      throw new Error(`Cannot send CDP command "${method}": client is closed`);
    }
    if (!this.isConnected) {
      await this.connect();
    }
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error(`Cannot send CDP command "${method}": WebSocket is not open`);
    }

    const id = this.nextId++;
    const payload: Record<string, unknown> = {
      id,
      method,
      params: params ?? {},
    };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });

      try {
        this.ws!.send(JSON.stringify(payload));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  on<T = any>(event: string, handler: CDPEventHandler<T>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as CDPEventHandler);
    return () => this.off(event, handler);
  }

  off<T = any>(event: string, handler: CDPEventHandler<T>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler as CDPEventHandler);
    if (set.size === 0) {
      this.listeners.delete(event);
    }
  }

  close(code = 1000, reason = "CDPClient closed"): void {
    if (this.closed) return;
    this.closed = true;

    this.rejectAllPending(new Error("CDPClient closed"));

    if (this.cleanupSocketListeners) {
      this.cleanupSocketListeners();
      this.cleanupSocketListeners = null;
    }

    if (this.ws) {
      try {
        this.ws.close(code, reason);
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }

    this.listeners.clear();
  }

  private handleMessage(rawData: unknown): void {
    let text: string;
    if (typeof rawData === "string") {
      text = rawData;
    } else if (rawData instanceof ArrayBuffer) {
      text = new TextDecoder().decode(rawData);
    } else if (ArrayBuffer.isView(rawData)) {
      text = new TextDecoder().decode(rawData);
    } else {
      return;
    }

    let message: any;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof message?.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(
          new CDPError(
            message.error.message || `CDP error in "${pending.method}"`,
            message.error.code,
            message.error.data
          )
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message?.method === "string") {
      const handlers = this.listeners.get(message.method);
      if (!handlers || handlers.size === 0) return;
      for (const handler of [...handlers]) {
        try {
          handler(message.params, message.sessionId);
        } catch {
          // isolate listener errors
        }
      }
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}
