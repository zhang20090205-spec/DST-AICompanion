import type { GatewayConfig } from "./config.js";
import { ValidationError } from "./validation.js";

interface ClientSecretResponse {
  value?: string;
  expires_at?: number;
  client_secret?: { value?: string; expires_at?: number };
}

export async function createRealtimeClientSecret(
  config: GatewayConfig,
  safetyIdentifier?: string,
): Promise<{ clientSecret: string; expiresAt: number; model: string }> {
  if (!config.apiKey) {
    throw new ValidationError("OPENAI_API_KEY is missing. Add it to agent-gateway/.env, then restart the Gateway.");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
  };
  if (safetyIdentifier !== undefined) {
    if (!/^dst-[a-f0-9]{64}$/.test(safetyIdentifier)) {
      throw new ValidationError("OpenAI safety identifier is invalid.");
    }
    headers["OpenAI-Safety-Identifier"] = safetyIdentifier;
  }
  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: {
        type: "realtime",
        model: config.realtimeModel,
        reasoning: { effort: "low" },
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { voice: config.realtimeVoice },
        },
      },
    }),
  });
  if (!response.ok) {
    throw new ValidationError(`OpenAI Realtime client-secret request failed (${response.status}).`);
  }
  const payload = await response.json() as ClientSecretResponse;
  const clientSecret = payload.value ?? payload.client_secret?.value;
  if (!clientSecret) {
    throw new ValidationError("OpenAI did not return a usable Realtime client secret.");
  }
  return {
    clientSecret,
    expiresAt: (payload.expires_at ?? payload.client_secret?.expires_at ?? Math.floor(Date.now() / 1000) + 60) * 1_000,
    model: config.realtimeModel,
  };
}
