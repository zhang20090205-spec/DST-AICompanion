import "dotenv/config";

export interface GatewayConfig {
  host: "127.0.0.1";
  port: number;
  apiKey?: string;
  realtimeModel: string;
  realtimeReasoningEffort: RealtimeReasoningEffort;
  realtimeVoice: string;
  databasePath: string;
}

export type RealtimeReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

const REALTIME_REASONING_EFFORTS = new Set<RealtimeReasoningEffort>([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DST_GATEWAY_PORT must be a valid TCP port.");
  }
  return port;
}

function parseRealtimeReasoningEffort(value: string | undefined): RealtimeReasoningEffort {
  const effort = value?.trim() || "medium";
  if (!REALTIME_REASONING_EFFORTS.has(effort as RealtimeReasoningEffort)) {
    throw new Error("OPENAI_REALTIME_REASONING_EFFORT must be minimal, low, medium, high, or xhigh.");
  }
  return effort as RealtimeReasoningEffort;
}

export function loadConfig(env = process.env): GatewayConfig {
  const requestedHost = env.DST_GATEWAY_HOST ?? "127.0.0.1";
  if (requestedHost !== "127.0.0.1") {
    throw new Error("DST Gateway only supports the loopback host 127.0.0.1.");
  }

  return {
    host: "127.0.0.1",
    port: parsePort(env.DST_GATEWAY_PORT),
    apiKey: env.OPENAI_API_KEY?.trim() || undefined,
    realtimeModel: env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2.1",
    realtimeReasoningEffort: parseRealtimeReasoningEffort(env.OPENAI_REALTIME_REASONING_EFFORT),
    realtimeVoice: env.OPENAI_REALTIME_VOICE?.trim() || "marin",
    databasePath: env.DST_GATEWAY_DATABASE?.trim() || "data/dst-gpt-agent.sqlite",
  };
}
