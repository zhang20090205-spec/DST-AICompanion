import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { GatewayConfig } from "./config.js";
import type { GatewayCore, GatewayEvent } from "./gateway.js";

interface AiriEvent {
  type: string;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

const RECONNECT_DELAY_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const STATE_PUSH_INTERVAL_MS = 2_000;

export class AiriBridge {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private stopped = false;
  private ready = false;
  private authenticated = false;
  private lastStatePushAt = 0;
  private readonly instanceId = `dst-${randomUUID()}`;
  private unsubscribe?: () => void;

  constructor(
    private readonly config: GatewayConfig,
    private readonly core: GatewayCore,
  ) {}

  start(): void {
    if (this.unsubscribe) {
      return;
    }
    this.stopped = false;
    this.core.setControllerMode("airi");
    this.unsubscribe = this.core.subscribe((event) => this.handleGatewayEvent(event));
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ready = false;
    this.authenticated = false;
    this.clearTimers();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.socket?.close(1000, "gateway shutdown");
    this.socket = undefined;
    this.core.setControllerState(false, false);
  }

  status(): Record<string, unknown> {
    return {
      airiConfigured: Boolean(this.config.airiAuthToken),
      airiConnected: this.ready,
      airiAuthenticated: this.authenticated,
      airiWsUrl: this.config.airiWsUrl,
      airiModuleName: this.config.airiModuleName,
    };
  }

  private connect(): void {
    if (this.stopped || this.socket) {
      return;
    }
    const socket = new WebSocket(this.config.airiWsUrl);
    this.socket = socket;

    socket.on("open", () => {
      if (this.config.airiAuthToken) {
        this.send("module:authenticate", { token: this.config.airiAuthToken });
      } else {
        this.authenticated = true;
        this.announce();
      }
    });
    socket.on("message", (data) => this.handleMessage(String(data)));
    socket.on("error", () => {
      // The close handler owns fail-closed state and reconnect scheduling.
    });
    socket.on("close", () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = undefined;
      this.ready = false;
      this.authenticated = false;
      this.clearHeartbeat();
      this.core.setControllerState(false, false);
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: string): void {
    let event: AiriEvent;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return;
      }
      // Airi's server-runtime serializes outbound messages with superjson, so
      // the real event ({type,data,metadata}) is nested under `.json`. Unwrap it
      // when present; inbound plain objects (older/simple messages) pass through.
      const container = parsed as Record<string, unknown>;
      const inner = container.json && typeof container.json === "object" && !Array.isArray(container.json)
        ? container.json as Record<string, unknown>
        : container;
      event = inner as unknown as AiriEvent;
    } catch {
      return;
    }

    if (event.type === "transport:connection:heartbeat") {
      const kind = event.data?.kind;
      if (kind === "ping") {
        this.send("transport:connection:heartbeat", { kind: "pong", message: "💛", at: Date.now() });
      }
      this.core.touchController();
      return;
    }
    if (event.type === "module:authenticated") {
      if (event.data?.authenticated === true) {
        this.authenticated = true;
        this.announce();
      } else {
        this.socket?.close(1008, "Airi authentication rejected");
      }
      return;
    }
    if (event.type === "extension:module:announced" && this.isSelfAnnouncement(event.data)) {
      this.markReady();
      return;
    }
    if (event.type === "registry:modules:sync") {
      const modules = Array.isArray(event.data?.modules) ? event.data.modules : [];
      if (modules.some((entry) => entry && typeof entry === "object" && this.isSelfAnnouncement(entry as Record<string, unknown>))) {
        this.markReady();
      }
      return;
    }
    if (event.type === "error") {
      this.socket?.close(1008, "Airi protocol error");
    }
  }

  private announce(): void {
    this.send("extension:module:announce", {
      name: this.config.airiModuleName,
      identity: {
        id: this.instanceId,
        extension: { id: "dst-companion-gateway", version: "0.1.0" },
      },
      possibleEvents: [
        "context:update",
        "input:text",
        "transport:connection:heartbeat",
      ],
      dependencies: [{ role: "llm:orchestrator", optional: false }],
    });
  }

  private markReady(): void {
    if (this.ready) {
      return;
    }
    this.ready = true;
    this.authenticated = true;
    this.core.setControllerState(true, true);
    this.startHeartbeat();
  }

  private handleGatewayEvent(event: GatewayEvent): void {
    if (!this.ready) {
      return;
    }
    if (event.type === "player-input") {
      const data = event.data as Record<string, unknown>;
      if (event.companionId && data.route === "airi" && typeof data.text === "string") {
        this.sendPlayerInput(event.companionId, data.text);
      }
      return;
    }
    if (event.companionId && event.type === "game-state" && Date.now() - this.lastStatePushAt >= STATE_PUSH_INTERVAL_MS) {
      this.lastStatePushAt = Date.now();
      this.sendContext(event.companionId);
    }
  }

  private sendPlayerInput(companionId: string, text: string): void {
    this.send("input:text", {
      text,
      textRaw: text,
      overrides: { messagePrefix: "[DST] " },
      contextUpdates: [this.contextUpdate(companionId)],
    });
  }

  private sendContext(companionId: string): void {
    this.send("context:update", this.contextUpdate(companionId));
  }

  private contextUpdate(companionId: string): Record<string, unknown> {
    const snapshot = this.core.companionSnapshot(companionId);
    return {
      id: randomUUID(),
      contextId: `dst:${companionId}:live-state`,
      lane: "dst:game",
      strategy: "replace-self",
      text: `DST companion live state. Use dst_observe before every action. ${JSON.stringify(snapshot)}`,
      hints: ["Use only registered dst_* tools", "Never claim completion before a terminal tool result"],
      metadata: { companionId },
    };
  }

  private send(type: string, data: Record<string, unknown>): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    const source = {
      kind: "plugin",
      id: this.instanceId,
      extension: { id: "dst-companion-gateway", version: "0.1.0" },
      plugin: { id: "dst-companion-gateway" },
    };
    this.socket.send(JSON.stringify({
      type,
      data,
      metadata: { source, event: { id: randomUUID() } },
    }));
    return true;
  }

  private isSelfAnnouncement(data: Record<string, unknown>): boolean {
    const identity = data.identity && typeof data.identity === "object" ? data.identity as Record<string, unknown> : {};
    return data.name === this.config.airiModuleName && identity.id === this.instanceId;
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.send("transport:connection:heartbeat", { kind: "ping", message: "🩵", at: Date.now() })) {
        this.core.touchController();
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, RECONNECT_DELAY_MS);
    this.reconnectTimer.unref();
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
