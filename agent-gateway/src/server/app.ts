import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { PlayerInput } from "../shared/types.js";
import type { GatewayConfig } from "./config.js";
import { GatewayCore } from "./gateway.js";
import { createRealtimeClientSecret } from "./realtime.js";
import { ValidationError, validateCommandResult } from "./validation.js";

interface CompanionParams {
  id: string;
}

interface RealtimeCommandParams {
  id: string;
}

interface AiriToolParams {
  id: string;
  tool: string;
}

interface RealtimeCommandQuery {
  sessionId?: string;
  companionId?: string;
  timeoutMs?: string;
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
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new ValidationError("Realtime tool arguments were not valid JSON.");
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ValidationError("Realtime tool arguments must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function rejectedRealtimeToolOutput(callId: string, error: ValidationError): { callId: string; output: string } {
  const message = error.message.replace(/\s+/g, " ").trim().slice(0, 240) || "The tool call was rejected.";
  return {
    callId,
    // The browser turns this response into a function_call_output with the
    // original call_id, allowing the model to correct its arguments without
    // tearing down the WebRTC session.
    output: JSON.stringify({
      ok: false,
      error: { code: "tool_validation_error", message },
    }),
  };
}

export function createGatewayApp(
  config: GatewayConfig,
  core: GatewayCore,
  airiStatus: () => Record<string, unknown> = () => ({
    airiConfigured: Boolean(config.airiAuthToken),
    airiConnected: false,
    airiAuthenticated: false,
  }),
): FastifyInstance {
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
    reasoningEffort: config.realtimeReasoningEffort,
    ...airiStatus(),
    ...core.status(),
  }));

  app.post("/api/dashboard/session", async () => core.registerBrowserSession());

  app.get<{ Params: CompanionParams }>("/api/airi/v1/companions/:id/state", async (request) => {
    return core.companionSnapshot(request.params.id);
  });

  app.post<{ Params: AiriToolParams; Body: unknown }>("/api/airi/v1/companions/:id/tools/:tool", async (request) => {
    const body = asRecord(request.body);
    if (typeof body.callId !== "string" || body.callId.length < 1 || body.callId.length > 128) {
      throw new ValidationError("Airi tool request requires a valid callId.");
    }
    const toolNames: Record<string, string> = {
      dst_observe: "get_game_state",
      dst_follow: "follow_player",
      dst_stop: "stop_and_wait",
      dst_move: "approach_or_retreat",
      dst_gather: "gather_nearby",
      dst_defend: "attack_nearby_threat",
      dst_equip_or_eat: "equip_or_eat",
      dst_give_item: "give_item",
      dst_say_in_game: "say_in_game",
    };
    const toolName = toolNames[request.params.tool];
    if (!toolName) {
      throw new ValidationError("Unknown Airi DST tool.");
    }
    const args = parseToolArguments(body.args ?? {});
    const result = await core.handleAiriTool(request.params.id, toolName, args, body.callId);
    return { callId: body.callId, output: result.output, commandId: result.command?.id ?? null };
  });

  app.get<{ Params: { id: string; commandId: string }; Querystring: { timeoutMs?: string } }>(
    "/api/airi/v1/companions/:id/commands/:commandId/wait",
    async (request) => {
      const parsed = typeof request.query.timeoutMs === "string" ? Number.parseInt(request.query.timeoutMs, 10) : 120_000;
      const timeoutMs = Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 120_000)) : 120_000;
      const lifecycle = await core.waitForCommandTerminal(request.params.id, request.params.commandId, timeoutMs);
      if (!lifecycle) {
        throw new ValidationError("Unknown command id.");
      }
      return { command: lifecycle };
    },
  );

  app.post<{ Params: CompanionParams; Body: unknown }>("/api/airi/v1/companions/:id/interrupt", async (request) => {
    const body = asRecord(request.body);
    const reason = typeof body.reason === "string" ? body.reason.slice(0, 80) : "airi_interrupt";
    const command = core.interrupt(request.params.id, reason);
    return { accepted: true, commandId: command.id, epoch: command.epoch };
  });

  app.get<{ Params: CompanionParams }>("/api/dst/v1/companions/:id/commands", async (request) => {
    return core.pollCommands(request.params.id);
  });

  app.post<{ Params: CompanionParams; Body: unknown }>("/api/dst/v1/companions/:id/state", async (request) => {
    const state = core.receiveState(request.params.id, request.body);
    return { ok: true, stateRevision: state.revision, epoch: core.getEpoch(request.params.id) };
  });

  app.post<{ Params: CompanionParams; Body: unknown }>("/api/dst/v1/companions/:id/results", async (request) => {
    return core.receiveResult(request.params.id, validateCommandResult(request.body));
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

  // Audio transcription uses the same deterministic player-input path as
  // browser text and `!ai`, but a dedicated local alias lets the browser mark
  // its source without first receiving a 404 fallback round-trip.
  app.post<{ Params: CompanionParams; Body: PlayerInput }>("/api/dst/v1/companions/:id/player-input/transcript", async (request) => {
    const body = asRecord(request.body);
    if (typeof body.text !== "string") {
      throw new ValidationError("Player input must contain text.");
    }
    return core.receivePlayerInput(request.params.id, {
      id: typeof body.id === "string" ? body.id : undefined,
      userid: typeof body.userid === "string" ? body.userid : undefined,
      text: body.text,
      source: "voice",
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
      try {
        const result = await core.handleRealtimeTool(companionId, body.name, parseToolArguments(body.arguments), body.callId);
        return { callId: body.callId, output: JSON.stringify(result.output) };
      } catch (error) {
        if (error instanceof ValidationError) {
          return rejectedRealtimeToolOutput(body.callId, error);
        }
        throw error;
      }
    }
    if (body.type === "transcript") {
      if (typeof body.text !== "string") {
        throw new ValidationError("Transcript text is required.");
      }
      return core.receivePlayerInput(companionId, { text: body.text, source: "voice" });
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

  app.get<{ Params: RealtimeCommandParams; Querystring: RealtimeCommandQuery }>("/api/realtime/commands/:id/status", async (request) => {
    core.assertBrowserSession(request.query.sessionId);
    const companionId = typeof request.query.companionId === "string" ? request.query.companionId : "default";
    const lifecycle = core.commandStatus(companionId, request.params.id);
    if (!lifecycle) {
      throw new ValidationError("Unknown command id.");
    }
    return { command: lifecycle };
  });

  app.get<{ Params: RealtimeCommandParams; Querystring: RealtimeCommandQuery }>("/api/realtime/commands/:id/wait", async (request) => {
    core.assertBrowserSession(request.query.sessionId);
    const companionId = typeof request.query.companionId === "string" ? request.query.companionId : "default";
    const timeoutMs = typeof request.query.timeoutMs === "string" ? Number.parseInt(request.query.timeoutMs, 10) : undefined;
    const lifecycle = await core.waitForCommandTerminal(companionId, request.params.id, Number.isFinite(timeoutMs) ? timeoutMs : undefined);
    if (!lifecycle) {
      throw new ValidationError("Unknown command id.");
    }
    return { command: lifecycle };
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
