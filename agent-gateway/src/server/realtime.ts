import type { GatewayConfig } from "./config.js";
import { ValidationError } from "./validation.js";

interface ClientSecretResponse {
  value?: string;
  expires_at?: number;
  client_secret?: { value?: string; expires_at?: number };
}

interface OpenAIErrorResponse {
  error?: {
    message?: unknown;
    code?: unknown;
    param?: unknown;
  };
  message?: unknown;
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
    if (!/^dst-[a-f0-9]{60}$/.test(safetyIdentifier)) {
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
        reasoning: { effort: config.realtimeReasoningEffort },
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
    const detail = await readOpenAIErrorDetail(response);
    throw new ValidationError(`OpenAI Realtime client-secret request failed (${response.status})${detail ? `: ${detail}` : "."}`);
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

async function readOpenAIErrorDetail(response: Response): Promise<string | undefined> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return undefined;
  }
  try {
    const payload = JSON.parse(text) as OpenAIErrorResponse;
    const parts = [
      typeof payload.error?.message === "string" ? payload.error.message : undefined,
      typeof payload.error?.code === "string" ? `code=${payload.error.code}` : undefined,
      typeof payload.error?.param === "string" ? `param=${payload.error.param}` : undefined,
      typeof payload.message === "string" && payload.message !== payload.error?.message ? payload.message : undefined,
    ].filter((part): part is string => Boolean(part));
    return sanitizeOpenAIErrorDetail(parts.join(" "));
  } catch {
    return sanitizeOpenAIErrorDetail(text);
  }
}

function sanitizeOpenAIErrorDetail(value: string): string | undefined {
  const sanitized = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer <redacted>")
    .replace(/\bsk[-_][A-Za-z0-9_-]+/g, "sk-<redacted>")
    .replace(/\bek[-_][A-Za-z0-9_-]+/g, "ek_<redacted>")
    .replace(/\bdst-[a-f0-9]{16,64}\b/g, "dst-<redacted>")
    .replace(/\b(api[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?[^'",\s}]+/gi, "$1=<redacted>")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, "$1<redacted>@")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
  return sanitized || undefined;
}
