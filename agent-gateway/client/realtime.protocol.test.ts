import assert from "node:assert/strict";
import test from "node:test";
import {
  REALTIME_CALLS_URL,
  REALTIME_TOOLS,
  RealtimeBridge,
  buildFunctionCallOutput,
  buildSessionUpdate,
  extractRealtimeToolCalls,
  secretCanBeRendered,
  voiceSpeakingStateForEvent,
} from "./realtime.js";

interface BridgeInternals {
  session?: { sessionId: string };
  channel?: { readyState: string; send: (payload: string) => void };
  handleRealtimeEvent: (raw: unknown) => Promise<void>;
}

function createBridge(): RealtimeBridge {
  return new RealtimeBridge({
    onStatus: () => undefined,
    onTranscript: () => undefined,
    onGatewayEvent: () => undefined,
  }, "bot-1");
}

test("the browser session update exposes only the approved tool surface", () => {
  const update = buildSessionUpdate();
  assert.equal(update.type, "session.update");
  assert.equal(update.session.audio.input.turn_detection.interrupt_response, true);
  assert.deepEqual(REALTIME_TOOLS.map((tool) => tool.name), [
    "get_game_state", "search_dst_knowledge", "say_in_game", "follow_player", "stop_and_wait",
    "approach_or_retreat", "gather_nearby", "attack_nearby_threat", "equip_or_eat", "give_item",
    "request_confirmation", "clear_action_queue",
  ]);
});

test("browser WebRTC SDP is posted only to the Realtime calls endpoint", () => {
  assert.equal(REALTIME_CALLS_URL, "https://api.openai.com/v1/realtime/calls");
});

test("WebRTC VAD delegates response interruption and truncation to the server", () => {
	const update = buildSessionUpdate();
	assert.deepEqual(update.session.audio.input.turn_detection, {
		type: "server_vad",
		create_response: true,
		interrupt_response: true,
	});
});

test("VAD events distinguish player speaking from an idle connected voice session", () => {
  assert.equal(voiceSpeakingStateForEvent("input_audio_buffer.speech_started"), true);
  assert.equal(voiceSpeakingStateForEvent("input_audio_buffer.speech_stopped"), false);
  assert.equal(voiceSpeakingStateForEvent("response.done"), undefined);
});

test("client secrets never enter a renderable state", () => {
  assert.equal(secretCanBeRendered("ek_live_secret"), false);
});

test("tool calls can be extracted from response.done function_call output items", () => {
  assert.deepEqual(extractRealtimeToolCalls({
    type: "response.done",
    response: {
      output: [
        { type: "message" },
        { type: "function_call", call_id: "call-7", name: "get_game_state", arguments: "{\"x\":1}" },
      ],
    },
  }), [{ callId: "call-7", name: "get_game_state", arguments: "{\"x\":1}" }]);
});

test("function call output is always a JSON string payload", () => {
  assert.deepEqual(buildFunctionCallOutput("call-8", { output: { accepted: true, epoch: 2 } }), {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: "call-8",
      output: "{\"accepted\":true,\"epoch\":2}",
    },
  });
  assert.deepEqual(buildFunctionCallOutput("call-9", { output: "{\"accepted\":true}" }), {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: "call-9",
      output: "{\"accepted\":true}",
    },
  });
});

test("VAD immediately reports speaking and interrupts the game action queue", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (path, init) => {
    posted.push({ path: String(path), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout: () => 0 } });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  const bridge = createBridge() as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  await bridge.handleRealtimeEvent(JSON.stringify({ type: "input_audio_buffer.speech_started" }));

  assert.deepEqual(posted.map((request) => request.body.type), ["voice-speaking", "interrupt"]);
  assert.equal(posted.every((request) => request.path === "/api/realtime/events"), true);
  assert.equal(posted.every((request) => request.body.sessionId === "local-session" && request.body.companionId === "bot-1"), true);
});

test("Realtime tool calls and final audio transcripts reach the Gateway with no browser-only reply", async (t) => {
  const originalFetch = globalThis.fetch;
  const posted: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push(body);
    return new Response(JSON.stringify({ output: "{\"accepted\":true}" }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const bridge = createBridge() as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = {
    readyState: "open",
    send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>),
  };

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-follow",
    name: "follow_player",
    arguments: "{}",
  }));
  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.output_audio_transcript.done",
    transcript: "I am following you.",
  }));

  assert.deepEqual(posted.map((body) => body.type), ["tool-call", "assistant-transcript"]);
  assert.equal(posted[0]?.callId, "call-follow");
  assert.equal(posted[1]?.text, "I am following you.");
  assert.deepEqual(sent[0], {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: "call-follow", output: "{\"accepted\":true}" },
  });
  assert.deepEqual(sent[1], { type: "response.create" });
});
