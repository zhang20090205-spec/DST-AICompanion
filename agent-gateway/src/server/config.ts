import "dotenv/config";

export interface GatewayConfig {
  host: "127.0.0.1";
  port: number;
  apiKey?: string;
  realtimeModel: string;
  realtimeVoice: string;
  databasePath: string;
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DST_GATEWAY_PORT must be a valid TCP port.");
  }
  return port;
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
    realtimeVoice: env.OPENAI_REALTIME_VOICE?.trim() || "marin",
    databasePath: env.DST_GATEWAY_DATABASE?.trim() || "data/dst-gpt-agent.sqlite",
  };
}
