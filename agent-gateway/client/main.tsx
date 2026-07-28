import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, CircleAlert, Loader, Mic, MicOff, Wifi, WifiOff } from "lucide-react";
import { RealtimeBridge, type ConnectionStatus, type RealtimeConnectionDiagnostic, type TranscriptEntry } from "./realtime";
import "./styles.css";

// The status dashboard reads gateway state over loopback HTTP + SSE. In the
// default "realtime" controller mode it also hosts the OpenAI Realtime voice
// companion (microphone + speech-to-speech) via the RealtimeBridge below; the
// bridge owns the OpenAI connection and feeds gateway events back into the same
// handler the SSE stream uses.
interface GatewayEvent {
  type: string;
  companionId?: string;
  data: Record<string, unknown>;
}

interface VisibleState {
  health?: number | null;
  hunger?: number | null;
  sanity?: number | null;
  temperature?: number | null;
  phase?: string;
  action?: string | null;
}

interface CommandLifecycle {
  id?: string;
  kind?: string;
  status?: string;
  terminal?: boolean;
  progress?: Record<string, unknown> | null;
  result?: { status?: string; reason?: string } | null;
}

interface Confirmation {
  id: string;
  prompt?: string;
  kind?: string;
  expiresAt?: number;
}

interface AiriStatus {
  configured: boolean;
  connected: boolean;
  authenticated: boolean;
  mode: string;
  lastActivity: number | null;
}

interface RecentResult {
  key: string;
  label: string;
  tone: "ok" | "warn" | "bad" | "info";
  at: number;
}

interface GatewayHealthCompanion {
  id?: string;
  connected?: boolean;
  confirmation?: (Confirmation & { kind?: string }) | null;
  activeCommand?: CommandLifecycle | null;
}

interface GatewayHealth {
  airiConfigured?: boolean;
  airiConnected?: boolean;
  airiAuthenticated?: boolean;
  controllerMode?: string;
  lastControllerActivity?: number | null;
  companions?: GatewayHealthCompanion[];
  audit?: { event?: string; metadata?: Record<string, unknown> }[];
}

const COMPANION_ID = "default";
const SESSION_REFRESH_MS = 8 * 60_000;
const RECONNECT_DELAY_MS = 2_000;
const SSE_EVENT_TYPES = [
  "controller-state",
  "game-state",
  "command",
  "command-lifecycle",
  "command-progress",
  "command-result",
  "confirmation",
  "interrupt",
  "trusted-gather-message",
];

const STATUS_LABEL: Record<string, string> = {
  queued: "排队",
  dispatched: "已下发",
  started: "执行中",
  progress: "进行中",
  succeeded: "成功",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};

function statusLabel(status: unknown): string {
  return typeof status === "string" ? STATUS_LABEL[status] ?? status : "--";
}

function toneForStatus(status: unknown): RecentResult["tone"] {
  if (status === "succeeded") return "ok";
  if (status === "partial") return "warn";
  if (status === "failed" || status === "cancelled") return "bad";
  return "info";
}

function gatherSummary(gather: Record<string, unknown> | null | undefined): string {
  if (!gather || typeof gather !== "object") {
    return "";
  }
  const prefab = typeof gather.targetPrefab === "string" ? gather.targetPrefab : "目标";
  const completed = Number(gather.completed ?? 0);
  const attempted = Number(gather.attempted ?? 0);
  const remaining = Number(gather.remaining ?? 0);
  const skipped = Number(gather.skipped ?? 0);
  let text = `${prefab} 采集 ${completed}/${attempted}`;
  if (remaining) text += `，剩余 ${remaining}`;
  if (skipped) text += `，跳过 ${skipped}`;
  return text;
}

function App() {
  const [airi, setAiri] = useState<AiriStatus>({
    configured: false,
    connected: false,
    authenticated: false,
    mode: "realtime",
    lastActivity: null,
  });
  const [game, setGame] = useState<VisibleState>({});
  const [gameFresh, setGameFresh] = useState(false);
  const [activeCommand, setActiveCommand] = useState<CommandLifecycle | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [recent, setRecent] = useState<RecentResult[]>([]);
  const [audit, setAudit] = useState<string[]>([]);
  const [sseConnected, setSseConnected] = useState(false);
  const [notice, setNotice] = useState("");

  const [voiceStatus, setVoiceStatus] = useState<ConnectionStatus>("disconnected");
  const [voiceDetail, setVoiceDetail] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [voiceDiag, setVoiceDiag] = useState<RealtimeConnectionDiagnostic | null>(null);

  const recentSeq = useRef(0);
  const bridgeRef = useRef<RealtimeBridge | null>(null);
  const handleEventRef = useRef<(event: GatewayEvent) => void>(() => {});

  const addRecent = (label: string, tone: RecentResult["tone"]) => {
    recentSeq.current += 1;
    setRecent((current) => [{ key: `r-${recentSeq.current}`, label, tone, at: Date.now() }, ...current].slice(0, 10));
  };

  const applyLifecycle = (lifecycle: CommandLifecycle | null | undefined) => {
    if (!lifecycle || typeof lifecycle !== "object") {
      return;
    }
    if (lifecycle.terminal === true) {
      setActiveCommand((current) => (current && current.id === lifecycle.id ? null : current));
    } else if (lifecycle.status !== undefined) {
      setActiveCommand(lifecycle);
    }
  };

  const handleGatewayEvent = (event: GatewayEvent) => {
    const data = event.data ?? {};
    switch (event.type) {
      case "controller-state": {
        setAiri((current) => ({
          ...current,
          mode: typeof data.mode === "string" ? data.mode : current.mode,
          connected: data.connected === true,
          authenticated: data.authenticated === true,
        }));
        break;
      }
      case "game-state": {
        const state = data.state as Record<string, unknown> | undefined;
        if (state) {
          const world = state.world as Record<string, unknown> | undefined;
          setGame({
            health: typeof state.health === "number" ? state.health : null,
            hunger: typeof state.hunger === "number" ? state.hunger : null,
            sanity: typeof state.sanity === "number" ? state.sanity : null,
            temperature: typeof state.temperature === "number" ? state.temperature : null,
            phase: typeof world?.phase === "string" ? world.phase : undefined,
            action: typeof state.currentAction === "string" ? state.currentAction : null,
          });
          setGameFresh(true);
        }
        break;
      }
      case "command": {
        applyLifecycle(data.command as CommandLifecycle | undefined);
        break;
      }
      case "command-lifecycle": {
        applyLifecycle(data as CommandLifecycle);
        break;
      }
      case "command-progress": {
        applyLifecycle(data.lifecycle as CommandLifecycle | undefined);
        break;
      }
      case "command-result": {
        const kind = typeof data.kind === "string" ? data.kind : "动作";
        const result = data.result as { status?: string; reason?: string } | undefined;
        const reason = result?.reason ? `（${result.reason}）` : "";
        addRecent(`${kind} · ${statusLabel(result?.status)}${reason}`, toneForStatus(result?.status));
        applyLifecycle(data.lifecycle as CommandLifecycle | undefined);
        break;
      }
      case "interrupt": {
        const reason = typeof data.reason === "string" ? data.reason : "已打断";
        addRecent(`打断 · ${reason}`, "bad");
        setActiveCommand(null);
        break;
      }
      case "trusted-gather-message": {
        if (data.deferred === true) {
          break;
        }
        const outcome = data.outcome as Record<string, unknown> | undefined;
        const summary = gatherSummary(outcome?.gather as Record<string, unknown> | undefined);
        if (summary) {
          addRecent(`采集 · ${summary}`, toneForStatus(data.status));
        }
        break;
      }
      case "confirmation": {
        if (data.expired || data.cancelled || data.accepted === true || data.accepted === false) {
          setConfirmation(null);
        } else if (typeof data.id === "string") {
          const command = data.command as Record<string, unknown> | undefined;
          setConfirmation({
            id: data.id,
            prompt: typeof data.prompt === "string" ? data.prompt : "需要玩家确认",
            kind: typeof command?.kind === "string" ? command.kind : undefined,
            expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : undefined,
          });
        }
        break;
      }
      default:
        break;
    }
  };

  // Self-managed dashboard session + SSE stream (no OpenAI, no microphone).
  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    let reconnectTimer: number | undefined;
    let refreshTimer: number | undefined;

    const clearReconnect = () => {
      if (reconnectTimer !== undefined) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || reconnectTimer !== undefined) {
        return;
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, RECONNECT_DELAY_MS);
    };

    const connect = async () => {
      if (disposed) {
        return;
      }
      source?.close();
      source = undefined;
      try {
        const response = await fetch("/api/dashboard/session", { method: "POST" });
        if (!response.ok) {
          throw new Error("无法创建本地面板会话。");
        }
        const session = await response.json() as { sessionId?: string };
        if (disposed || typeof session.sessionId !== "string") {
          return;
        }
        const events = new EventSource(`/api/events?sessionId=${encodeURIComponent(session.sessionId)}`);
        source = events;
        events.onopen = () => {
          if (!disposed) {
            setSseConnected(true);
            setNotice("");
          }
        };
        events.onerror = () => {
          if (disposed) {
            return;
          }
          setSseConnected(false);
          events.close();
          if (source === events) {
            source = undefined;
          }
          // The session may have expired (absolute 10-minute TTL). Reconnect
          // always mints a fresh session rather than reusing the old id.
          scheduleReconnect();
        };
        for (const type of SSE_EVENT_TYPES) {
          events.addEventListener(type, (message) => {
            try {
              const parsed = JSON.parse((message as MessageEvent).data) as GatewayEvent;
              if (parsed && typeof parsed.type === "string") {
                handleGatewayEvent(parsed);
              }
            } catch {
              // Ignore malformed frames; the stream stays open.
            }
          });
        }
      } catch (error) {
        if (!disposed) {
          setSseConnected(false);
          setNotice(error instanceof Error ? error.message : "本地面板会话连接失败。");
          scheduleReconnect();
        }
      }
    };

    void connect();
    // Proactively refresh before the absolute session TTL expires.
    refreshTimer = window.setInterval(() => void connect(), SESSION_REFRESH_MS);

    return () => {
      disposed = true;
      clearReconnect();
      if (refreshTimer !== undefined) {
        window.clearInterval(refreshTimer);
      }
      source?.close();
    };
  }, []);

  // Health poll: authoritative 2s snapshot of Airi/controller status, DST
  // freshness, active command, confirmation, and the audit tail.
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/health");
        if (!response.ok || disposed) {
          return;
        }
        const health = await response.json() as GatewayHealth;
        if (disposed) {
          return;
        }
        setAiri((current) => ({
          configured: health.airiConfigured === true,
          connected: health.airiConnected === true,
          authenticated: health.airiAuthenticated === true,
          mode: typeof health.controllerMode === "string" ? health.controllerMode : current.mode,
          lastActivity: typeof health.lastControllerActivity === "number" ? health.lastControllerActivity : null,
        }));
        const companion = health.companions?.find((candidate) => candidate.id === COMPANION_ID);
        setGameFresh(companion?.connected === true);
        setActiveCommand(companion?.activeCommand ?? null);
        setConfirmation((current) => {
          if (companion?.confirmation && typeof companion.confirmation.id === "string") {
            return {
              id: companion.confirmation.id,
              prompt: companion.confirmation.prompt ?? "需要玩家确认",
              kind: companion.confirmation.kind,
              expiresAt: companion.confirmation.expiresAt,
            };
          }
          return companion ? null : current;
        });
        setAudit((health.audit ?? [])
          .map((entry) => (typeof entry.event === "string" ? entry.event : ""))
          .filter(Boolean)
          .slice(0, 8));
      } catch {
        // A failed health poll must never crash the read-only dashboard.
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  // One-shot hydration so the panel is populated before the first SSE frame.
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const response = await fetch(`/api/airi/v1/companions/${COMPANION_ID}/state`);
        if (!response.ok || disposed) {
          return;
        }
        const snapshot = await response.json() as Record<string, unknown>;
        const state = snapshot.state as Record<string, unknown> | undefined;
        if (state) {
          const world = state.world as Record<string, unknown> | undefined;
          setGame({
            health: typeof state.health === "number" ? state.health : null,
            hunger: typeof state.hunger === "number" ? state.hunger : null,
            sanity: typeof state.sanity === "number" ? state.sanity : null,
            temperature: typeof state.temperature === "number" ? state.temperature : null,
            phase: typeof world?.phase === "string" ? world.phase : undefined,
            action: typeof state.currentAction === "string" ? state.currentAction : null,
          });
        }
        setGameFresh(snapshot.stateFresh === true);
        if (snapshot.activeCommand && typeof snapshot.activeCommand === "object") {
          setActiveCommand(snapshot.activeCommand as CommandLifecycle);
        }
      } catch {
        // Hydration is best-effort; the health poll and SSE stream follow.
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // Keep the bridge's event handler pointing at the latest render's closure,
  // and tear the voice session down on unmount.
  useEffect(() => {
    handleEventRef.current = handleGatewayEvent;
  });
  useEffect(() => () => { void bridgeRef.current?.disconnect(); }, []);

  const ensureBridge = () => {
    if (!bridgeRef.current) {
      bridgeRef.current = new RealtimeBridge({
        onStatus: (status, detail) => { setVoiceStatus(status); setVoiceDetail(detail ?? ""); },
        onTranscript: (entry) => setTranscript((current) => {
          const index = current.findIndex((item) => item.id === entry.id);
          if (index >= 0) {
            const next = current.slice();
            next[index] = entry;
            return next;
          }
          return [...current, entry].slice(-50);
        }),
        onGatewayEvent: (event) => handleEventRef.current(event),
        onDiagnostic: (diagnostic) => setVoiceDiag(diagnostic),
      }, COMPANION_ID);
    }
    return bridgeRef.current;
  };

  const toggleVoice = () => {
    const bridge = ensureBridge();
    if (voiceStatus === "connected" || voiceStatus === "connecting") {
      void bridge.disconnect("用户断开语音");
    } else {
      setVoiceDiag(null);
      void bridge.connect().catch((error) => {
        setVoiceStatus("error");
        setVoiceDetail(error instanceof Error ? error.message : String(error));
      });
    }
  };

  const voiceConnected = voiceStatus === "connected";
  const voiceConnecting = voiceStatus === "connecting";

  const airiIndicator = useMemo(() => {
    if (airi.connected && airi.authenticated) return "online";
    if (airi.connected) return "pending";
    return "offline";
  }, [airi.connected, airi.authenticated]);

  const airiLabel = airi.connected
    ? (airi.authenticated ? "Airi 已连接 · 已认证" : "Airi 已连接 · 未认证")
    : (airi.configured ? "Airi 未连接" : "Airi 未配置");

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><Activity size={20} /> <span>DST AI 伙伴 · 状态面板</span></div>
        <div className={`status ${airiIndicator}`}>
          <span className="status-dot" />
          {airi.connected ? <Wifi size={15} /> : <WifiOff size={15} />}
          {airiLabel}
        </div>
        <div className="mode-tag" title="伙伴控制器模式">{airi.mode}</div>
      </header>

      {notice && <div className="notice"><CircleAlert size={16} /><span>{notice}</span></div>}

      <section className={`panel voice ${voiceStatus}`} aria-label="语音伙伴">
        <div className="voice-head">
          <h2>语音伙伴 · OpenAI Realtime</h2>
          <button className={`voice-btn ${voiceStatus}`} onClick={toggleVoice} disabled={voiceConnecting}>
            {voiceConnecting ? <Loader size={15} className="spin" /> : (voiceConnected ? <Mic size={15} /> : <MicOff size={15} />)}
            {voiceConnected ? "断开语音" : voiceConnecting ? "连接中…" : "连接语音"}
          </button>
        </div>
        <p className="voice-status">
          {voiceConnected ? "已连接，直接说话即可；说“停下/停止”可立即打断当前动作。"
            : voiceConnecting ? "正在建立 Realtime 语音连接…"
            : voiceStatus === "error" ? `语音连接出错：${voiceDetail || "未知错误"}`
            : "点击“连接语音”，允许麦克风后即可用自然语言对话并指挥角色。"}
        </p>
        {voiceDiag && <p className={`voice-diag ${voiceDiag.recoverable ? "" : "fatal"}`}>{voiceDiag.detail}</p>}
        {transcript.length > 0 && (
          <ul className="transcript">
            {transcript.map((entry) => (
              <li key={entry.id} className={entry.role}>
                <span className="who">{entry.role === "assistant" ? "AI" : entry.role === "player" ? "你" : "系统"}</span>
                {entry.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="dashboard" aria-label="游戏状态">
        <div className="metric"><span>生命</span><strong>{game.health ?? "--"}</strong></div>
        <div className="metric"><span>饥饿</span><strong>{game.hunger ?? "--"}</strong></div>
        <div className="metric"><span>理智</span><strong>{game.sanity ?? "--"}</strong></div>
        <div className="metric"><span>温度</span><strong>{game.temperature ?? "--"}</strong></div>
        <div className="state-line">
          <span>{game.phase ?? "等待游戏状态"}</span>
          <span>{game.action ?? "待命"}</span>
          <span className={gameFresh ? "fresh" : "stale"}>{gameFresh ? "DST 状态新鲜" : "DST 状态不可用/过期"}</span>
        </div>
      </section>

      <section className="panel" aria-label="当前动作">
        <h2>当前动作</h2>
        {activeCommand ? (
          <div className="active-command">
            <strong>{activeCommand.kind ?? "--"}</strong>
            <span className={`badge ${toneForStatus(activeCommand.status)}`}>{statusLabel(activeCommand.status)}</span>
            {activeCommand.progress && typeof activeCommand.progress === "object" && (
              <span className="progress">{gatherSummary(activeCommand.progress)}</span>
            )}
          </div>
        ) : <p className="empty">当前无进行中的动作</p>}
      </section>

      {confirmation && (
        <section className="confirmation" aria-label="待确认操作">
          <CircleAlert size={18} />
          <span>
            {confirmation.prompt}
            {confirmation.kind ? `（${confirmation.kind}）` : ""} —— 请在游戏内或对 Airi 说 “是/否” 回答。
          </span>
        </section>
      )}

      <section className="panel results" aria-label="最近结果">
        <h2>最近结果</h2>
        {recent.length === 0 ? <p className="empty">暂无结果</p> : (
          <ul>
            {recent.map((entry) => (
              <li key={entry.key} className={entry.tone}>{entry.label}</li>
            ))}
          </ul>
        )}
      </section>

      <footer className="diagnostics" aria-label="诊断">
        <span className={sseConnected ? "fresh" : "stale"}>{sseConnected ? "事件流已连接" : "事件流重连中"}</span>
        <span>控制器活跃：{airi.lastActivity ? new Date(airi.lastActivity).toLocaleTimeString() : "--"}</span>
        <span className="audit-tail">{audit.length === 0 ? "审计为空" : audit.join(" · ")}</span>
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
