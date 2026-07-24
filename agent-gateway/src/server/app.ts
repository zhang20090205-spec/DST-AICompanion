import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { CommandResult, PlayerInput } from "../shared/types.js";
import type { GatewayConfig } from "./config.js";
import { GatewayCore } from "./gateway.js";
import { createRealtimeClientSecret } from "./realtime.js";
import { ValidationError } from "./validation.js";

interface CompanionParams {
  id: string;
}

interface RealtimeEventBody {
  sessionId?: string;
  companionId?: string;
  type?: string;
  callId?: string;
  name?: unknown;
  arguments?: unknown;
  text?: unknown;
  active?: unknown;
}

const clientDist = resolve(process.cwd(), "dist/client");

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return asRecord(parsed);
    } catch {
      throw new ValidationError("Realtime tool arguments were not valid JSON.");
    }
  }
  return asRecord(value);
}

export function createGatewayApp(config: GatewayConfig, core: GatewayCore): FastifyInstance {
  const app = Fastify({ logger: false, trustProxy: false });

  app.addHook("onRequest", async (request, reply) => {
    if (!isLoopback(request.ip)) {
      return reply.code(403).send({ error: "DST Gateway only accepts loopback requests." });
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ValidationError) {
      return reply.code(400).send({ error: error.message });
    }
    return reply.code(500).send({ error: "Local Gateway request failed." });
  });

  app.get("/api/health", async () => ({
    ok: true,
    realtimeConfigured: Boolean(config.apiKey),
    model: config.realtimeModel,
    ...core.status(),
  }));

  app.get<{ Params: CompanionParams }>("/api/dst/v1/companions/:id/commands", async (request) => {
    return core.pollCommands(request.params.id);
  });

  app.post<{ Params: CompanionParams; Body: unknown }>("/api/dst/v1/companions/:id/state", async (request) => {
    const state = core.receiveState(request.params.id, request.body);
    return { ok: true, stateRevision: state.revision, epoch: core.getEpoch(request.params.id) };
  });

  app.post<{ Params: CompanionParams; Body: CommandResult }>("/api/dst/v1/companions/:id/results", async (request) => {
    const body = asRecord(request.body);
    if (typeof body.id !== "string" || !["started", "succeeded", "failed", "cancelled"].includes(String(body.status)) || typeof body.stateRevision !== "number") {
      throw new ValidationError("Invalid companion action result.");
    }
    return core.receiveResult(request.params.id, {
      id: body.id,
      status: body.status as CommandResult["status"],
      reason: typeof body.reason === "string" ? body.reason.slice(0, 160) : undefined,
      stateRevision: body.stateRevision,
    });
  });

  app.post<{ Params: CompanionParams; Body: PlayerInput }>("/api/dst/v1/companions/:id/player-input", async (request) => {
    const body = asRecord(request.body);
    if (typeof body.text !== "string") {
      throw new ValidationError("Player input must contain text.");
    }
    return core.receivePlayerInput(request.params.id, {
      id: typeof body.id === "string" ? body.id : undefined,
      userid: typeof body.userid === "string" ? body.userid : undefined,
      text: body.text,
      source: body.source === "voice" || body.source === "browser" ? body.source : "game",
    });
  });

  app.post<{ Body: { companionId?: string } }>("/api/realtime/session", async (request) => {
    const body = asRecord(request.body);
    const companionId = typeof body.companionId === "string" ? body.companionId : "default";
    const secret = await createRealtimeClientSecret(config, core.openAISafetyIdentifier(companionId));
    const localSession = core.registerBrowserSession();
    return { ...secret, sessionId: localSession.sessionId, sessionExpiresAt: localSession.expiresAt };
  });

  app.post<{ Body: RealtimeEventBody }>("/api/realtime/events", async (request) => {
    const body = asRecord(request.body) as RealtimeEventBody;
    core.assertBrowserSession(body.sessionId);
    const companionId = typeof body.companionId === "string" ? body.companionId : "default";
    if (body.type === "tool-call") {
      if (typeof body.callId !== "string" || body.callId.length > 128) {
        throw new ValidationError("Realtime function call is missing callId.");
      }
      const result = core.handleRealtimeTool(companionId, body.name, parseToolArguments(body.arguments), body.callId);
      return { callId: body.callId, output: JSON.stringify(result.output) };
    }
    if (body.type === "transcript") {
      if (typeof body.text !== "string") {
        throw new ValidationError("Transcript text is required.");
      }
      return core.receivePlayerInput(companionId, { text: body.text, source: "voice" });
    }
    if (body.type === "assistant-transcript") {
      if (typeof body.text !== "string") {
        throw new ValidationError("Assistant transcript text is required.");
      }
      // The transcript stays session-local, but its sanitized text is mirrored
      // into one rate-limited Lua say command so browser voice and DST chat match.
      return core.receiveAssistantTranscript(companionId, body.text);
    }
    if (body.type === "interrupt") {
      const command = core.interrupt(companionId, "voice_vad");
      return { accepted: true, commandId: command.id, epoch: command.epoch };
    }
    if (body.type === "voice-state") {
      core.setVoiceState(companionId, body.active === true);
      return { accepted: true };
    }
    if (body.type === "voice-speaking") {
      core.setVoiceSpeaking(companionId, body.active === true);
      return { accepted: true };
    }
    if (body.type === "heartbeat") {
      core.setVoiceState(companionId, true);
      return { accepted: true };
    }
    throw new ValidationError("Unsupported Realtime browser event.");
  });

  app.post<{ Body: { sessionId?: string; companionId?: string } }>("/api/interrupt", async (request) => {
    const body = asRecord(request.body);
    core.assertBrowserSession(body.sessionId);
    const companionId = typeof body.companionId === "string" ? body.companionId : "default";
    const command = core.interrupt(companionId, "browser_interrupt");
    return { accepted: true, commandId: command.id, epoch: command.epoch };
  });

  app.get<{ Querystring: { sessionId?: string } }>("/api/events", async (request, reply) => {
    core.assertBrowserSession(request.query.sessionId);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.raw.write(`event: connected\ndata: ${JSON.stringify({ type: "connected" })}\n\n`);
    const unsubscribe = core.subscribe((event) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });
    request.raw.on("close", unsubscribe);
  });

  if (existsSync(clientDist)) {
    void app.register(fastifyStatic, { root: clientDist, prefix: "/", wildcard: false, index: ["index.html"] });
  } else {
    app.get("/", async () => ({
      status: "Voice page has not been built yet. Run npm run build in agent-gateway.",
    }));
  }

  return app;
}
