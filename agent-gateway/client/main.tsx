import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AudioLines, Check, CircleAlert, CircleStop, LoaderCircle, Mic, MicOff, Send, Timer, X } from "lucide-react";
import {
  type ConnectionStatus,
  type GatewayEvent,
  type RealtimeLatencyEntry,
  type TranscriptEntry,
  RealtimeBridge,
} from "./realtime";
import "./styles.css";

interface VisibleState {
  health?: number | null;
  hunger?: number | null;
  sanity?: number | null;
  temperature?: number | null;
  phase?: string;
  action?: string | null;
  connected?: boolean;
}

interface Confirmation {
  id: string;
  prompt?: string;
  expiresAt?: number;
}

interface GatewayHealthCompanion {
  id?: string;
  connected?: boolean;
  confirmation?: Confirmation | null;
}

interface GatewayAuditEvent {
  event?: string;
  metadata?: Record<string, unknown>;
}

interface GatewayHealth {
  companions?: GatewayHealthCompanion[];
  model?: string;
  reasoningEffort?: string;
  audit?: GatewayAuditEvent[];
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: "未连接",
  connecting: "连接中",
  connected: "语音已连接",
  error: "连接异常",
};

const LATENCY_LABEL: Record<RealtimeLatencyEntry["metric"], string> = {
  speech_to_first_assistant_output: "首响",
  tool_to_command_start: "动作",
  transcript_to_gateway_route: "路由",
  transcript_to_command_start: "下发",
};

function App() {
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [detail, setDetail] = useState("");
  const [input, setInput] = useState("");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [game, setGame] = useState<VisibleState>({});
  const [audit, setAudit] = useState<string[]>([]);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [realtimeMode, setRealtimeMode] = useState<{ model?: string; reasoningEffort?: string }>({});
  const [latency, setLatency] = useState<RealtimeLatencyEntry[]>([]);
  const [gameConnection, setGameConnection] = useState<{ fresh: boolean; reason: string }>({
    fresh: false,
    reason: "等待 DST 上报状态",
  });
  const bridge = useRef<RealtimeBridge | undefined>(undefined);

  const indicator = useMemo(() => status === "connected" ? "online" : status === "connecting" ? "pending" : "offline", [status]);

  const addAudit = (entry: string) => setAudit((current) => [entry, ...current].slice(0, 8));
  const addTranscript = (entry: TranscriptEntry) => setTranscript((current) => [...current, entry].slice(-30));
  const addLatency = (entry: RealtimeLatencyEntry) => setLatency((current) => [entry, ...current].slice(0, 3));

  useEffect(() => {
    let disposed = false;
    const refreshGatewaySnapshot = async () => {
      try {
        const response = await fetch("/api/health");
        if (!response.ok || disposed) {
          return;
        }
        const health = await response.json() as GatewayHealth;
        const companion = health.companions?.find((candidate) => candidate.id === "default");
        const interruption = health.audit?.find((entry) => entry.event === "interrupted" || entry.event === "command_cancelled");
        const interruptionReason = typeof interruption?.metadata?.reason === "string"
          ? interruption.metadata.reason
          : "";
        if (!disposed) {
          setConfirmation(companion?.confirmation ?? null);
          setGame((current) => ({ ...current, connected: companion?.connected === true }));
          setGameConnection(companion?.connected === true
            ? { fresh: true, reason: "DST 状态已连接" }
            : {
                fresh: false,
                reason: interruptionReason
                  ? `DST 状态已过期；最近取消：${interruptionReason}`
                  : "DST 状态未连接或已过期，不能安全下发游戏动作",
              });
          setRealtimeMode({
            model: typeof health.model === "string" ? health.model : undefined,
            reasoningEffort: typeof health.reasoningEffort === "string" ? health.reasoningEffort : undefined,
          });
        }
      } catch {
        // A local health refresh must never tear down the active voice session.
      }
    };

    void refreshGatewaySnapshot();
    const interval = window.setInterval(() => void refreshGatewaySnapshot(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  const handleGatewayEvent = (event: GatewayEvent) => {
    if (event.type === "game-state") {
      const state = event.data.state as Record<string, unknown> | undefined;
      if (state) {
        const world = state.world as Record<string, unknown> | undefined;
        setGame({
          health: typeof state.health === "number" ? state.health : null,
          hunger: typeof state.hunger === "number" ? state.hunger : null,
          sanity: typeof state.sanity === "number" ? state.sanity : null,
          temperature: typeof state.temperature === "number" ? state.temperature : null,
          phase: typeof world?.phase === "string" ? world.phase : undefined,
          action: typeof state.currentAction === "string" ? state.currentAction : null,
          connected: true,
        });
      }
    } else if (event.type === "confirmation") {
      if (event.data.expired || event.data.accepted === true || event.data.accepted === false) {
        setConfirmation(null);
      } else if (typeof event.data.id === "string") {
        setConfirmation({
          id: event.data.id,
          prompt: typeof event.data.prompt === "string" ? event.data.prompt : "需要确认",
          expiresAt: typeof event.data.expiresAt === "number" ? event.data.expiresAt : undefined,
        });
      }
    } else if (event.type === "command" || event.type === "command-result" || event.type === "interrupt") {
      const kind = typeof event.data.kind === "string" ? event.data.kind : event.type;
      addAudit(kind);
    }
  };

  const connect = async () => {
    if (!bridge.current) {
      bridge.current = new RealtimeBridge({
        onStatus: (next, message) => {
          setStatus(next);
          setDetail(message ?? "");
        },
        onTranscript: addTranscript,
        onGatewayEvent: handleGatewayEvent,
        onLatency: addLatency,
      });
    }
    try {
      await bridge.current.connect();
    } catch (error) {
      setDetail(error instanceof Error ? error.message : "语音连接失败。");
    }
  };

  const disconnect = async () => {
    await bridge.current?.disconnect();
    bridge.current = undefined;
  };

  const submit = async (text = input) => {
    const value = text.trim();
    if (!value) {
      return;
    }
    setInput("");
    try {
      await bridge.current?.sendBrowserText(value);
    } catch (error) {
      setDetail(error instanceof Error ? error.message : "消息发送失败。");
      setStatus("error");
    }
  };

  const answerConfirmation = async (answer: "是" | "否") => {
    if (bridge.current) {
      try {
        await bridge.current.sendBrowserConfirmationAnswer(answer);
      } catch (error) {
        setDetail(error instanceof Error ? error.message : "确认发送失败。");
        setStatus("error");
      }
      return;
    }
    try {
      const response = await fetch("/api/dst/v1/companions/default/player-input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: crypto.randomUUID(), source: "browser", text: answer }),
      });
      if (!response.ok) {
        throw new Error("Confirmation was not accepted.");
      }
      setConfirmation(null);
    } catch (error) {
      setDetail(error instanceof Error ? error.message : "确认发送失败。");
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><AudioLines size={20} /> <span>DST AI Companion</span></div>
        <div className="realtime-mode" title="低推理等级优先响应速度；可在 .env 中设置 OPENAI_REALTIME_REASONING_EFFORT=high 获得更深推理和更高延迟。">
          {realtimeMode.model ?? "Realtime"} · 推理 {realtimeMode.reasoningEffort ?? "--"}
        </div>
        {latency.length > 0 && (
          <div className="latency-strip" aria-label="实时延迟">
            <Timer size={14} />
            {latency.map((entry) => (
              <span key={entry.id}>{LATENCY_LABEL[entry.metric]} {entry.elapsedMs}ms</span>
            ))}
          </div>
        )}
        <div className={`status ${indicator}`}><span className="status-dot" />{STATUS_LABEL[status]}</div>
        {status === "connected" ? (
          <button className="icon-button" type="button" title="断开语音" onClick={() => void disconnect()}><MicOff size={18} /></button>
        ) : (
          <button className="icon-button primary" type="button" title="连接语音" onClick={() => void connect()} disabled={status === "connecting"}>
            {status === "connecting" ? <LoaderCircle className="spin" size={18} /> : <Mic size={18} />}
          </button>
        )}
      </header>

      {detail && <div className="notice"><CircleAlert size={16} /><span>{detail}</span><button type="button" title="关闭提示" onClick={() => setDetail("")}><X size={15} /></button></div>}

      <section className="dashboard" aria-label="游戏状态">
        <div className="metric"><span>生命</span><strong>{game.health ?? "--"}</strong></div>
        <div className="metric"><span>饥饿</span><strong>{game.hunger ?? "--"}</strong></div>
        <div className="metric"><span>理智</span><strong>{game.sanity ?? "--"}</strong></div>
        <div className="metric"><span>温度</span><strong>{game.temperature ?? "--"}</strong></div>
        <div className="state-line">
          <span>{game.phase ?? "等待游戏状态"}</span><span>{game.action ?? "待命"}</span>
          <span title={gameConnection.reason}>{gameConnection.fresh ? "DST 已连接" : "DST 状态不可用"}</span>
        </div>
      </section>

      {!gameConnection.fresh && <div className="notice"><CircleAlert size={16} /><span>{gameConnection.reason}</span></div>}

      {confirmation && <section className="confirmation">
        <CircleAlert size={18} /><span>{confirmation.prompt}</span>
        <div className="confirmation-actions">
          <button type="button" title="确认" onClick={() => void answerConfirmation("是")}><Check size={16} /></button>
          <button type="button" title="取消" onClick={() => void answerConfirmation("否")}><X size={16} /></button>
        </div>
      </section>}

      <section className="conversation" aria-live="polite">
        {transcript.length === 0 ? <p className="empty">等待对话</p> : transcript.map((entry) => (
          <div className={`message ${entry.role}`} key={entry.id}><span>{entry.role === "player" ? "你" : entry.role === "assistant" ? "伙伴" : "系统"}</span><p>{entry.text}</p></div>
        ))}
      </section>

      <form className="input-row" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="输入给伙伴的话" maxLength={120} aria-label="发送文字" />
        <button type="submit" title="发送" disabled={!input.trim() || status !== "connected"}><Send size={18} /></button>
        <button type="button" className="stop" title="立即停止伙伴动作" onClick={() => void submit("stop")} disabled={status !== "connected"}><CircleStop size={18} /></button>
      </form>

      <footer className="audit" aria-label="动作记录">
        {audit.length === 0 ? <span>动作记录为空</span> : audit.map((entry, index) => <span key={`${entry}-${index}`}>{entry}</span>)}
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
