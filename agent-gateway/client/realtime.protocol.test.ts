import assert from "node:assert/strict";
import test from "node:test";
import {
  REALTIME_CALLS_URL,
  REALTIME_TOOLS,
  RealtimeBridge,
  SYSTEM_INSTRUCTIONS,
  buildGatewayRealtimeNotice,
  buildFunctionCallOutput,
  buildSessionUpdate,
  extractRealtimeToolCalls,
  secretCanBeRendered,
  textRequestsImmediateStop,
  voiceSpeakingStateForEvent,
} from "./realtime.js";

interface BridgeInternals {
  session?: { sessionId: string };
  channel?: { readyState: string; send: (payload: string) => void };
  audio?: { muted: boolean };
  responseInFlight?: boolean;
  handleRealtimeEvent: (raw: unknown) => Promise<void>;
  connectEventStream: () => void;
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
  assert.deepEqual(update.session.output_modalities, ["audio"]);
  assert.deepEqual(update.session.audio.input.transcription, {
    model: "gpt-4o-mini-transcribe",
    language: "zh",
  });
  assert.deepEqual(update.session.audio.input.turn_detection, {
    type: "semantic_vad",
    eagerness: "high",
    create_response: false,
    interrupt_response: false,
  });
  assert.equal(update.session.audio.input.turn_detection.interrupt_response, false);
  assert.deepEqual(REALTIME_TOOLS.map((tool) => tool.name), [
    "get_game_state", "search_dst_knowledge", "say_in_game", "follow_player", "stop_and_wait",
    "approach_or_retreat", "gather_nearby", "attack_nearby_threat", "equip_or_eat", "give_item",
    "request_confirmation", "clear_action_queue",
  ]);
});

test("browser WebRTC SDP is posted only to the Realtime calls endpoint", () => {
  assert.equal(REALTIME_CALLS_URL, "https://api.openai.com/v1/realtime/calls");
});

test("WebRTC VAD does not create or server-interrupt Realtime responses", () => {
	const update = buildSessionUpdate();
	assert.deepEqual(update.session.audio.input.turn_detection, {
		type: "semantic_vad",
    eagerness: "high",
		create_response: false,
		interrupt_response: false,
	});
});

test("instructions require a single same-turn browser-audio preamble before low-risk tools", () => {
  assert.match(SYSTEM_INSTRUCTIONS, /一句很短、自然、不宣称完成的前言/);
  assert.match(SYSTEM_INSTRUCTIONS, /前言必须在该动作工具调用之前的同一 Realtime 回复中出现/);
  assert.match(SYSTEM_INSTRUCTIONS, /不宣称完成/);
  assert.match(SYSTEM_INSTRUCTIONS, /玩家、VAD 或 stop 导致的取消保持安静/);
  assert.match(SYSTEM_INSTRUCTIONS, /快速路由的玩家指令已经由 Gateway 执行排队/);
  assert.match(SYSTEM_INSTRUCTIONS, /不要重新调用工具/);
  const follow = REALTIME_TOOLS.find((tool) => tool.name === "follow_player");
  const gather = REALTIME_TOOLS.find((tool) => tool.name === "gather_nearby");
  const say = REALTIME_TOOLS.find((tool) => tool.name === "say_in_game");
  assert.match(follow?.description ?? "", /immediately before calling this tool/);
  assert.match(follow?.description ?? "", /already routed/);
  assert.match(gather?.description ?? "", /never claim completion before command-result/);
  assert.match(say?.description ?? "", /Do not use this for low-risk action preambles/);
});

test("VAD events distinguish player speaking from an idle connected voice session", () => {
  assert.equal(voiceSpeakingStateForEvent("input_audio_buffer.speech_started"), true);
  assert.equal(voiceSpeakingStateForEvent("input_audio_buffer.speech_stopped"), false);
  assert.equal(voiceSpeakingStateForEvent("response.done"), undefined);
});

test("stop-like transcripts are identified without treating all speech as an interrupt", () => {
  assert.equal(textRequestsImmediateStop("危险，快停下！跟着我"), true);
  assert.equal(textRequestsImmediateStop("stop gathering now"), true);
  assert.equal(textRequestsImmediateStop("帮我采集草"), false);
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

test("speech_started mutes and cancels model audio without posting a game interrupt", async (t) => {
  const originalFetch = globalThis.fetch;
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push({ path: String(path), body });
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const bridge = createBridge() as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.responseInFlight = true;
  bridge.audio = { muted: false };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };

  await bridge.handleRealtimeEvent(JSON.stringify({ type: "input_audio_buffer.speech_started" }));

  assert.equal(bridge.audio.muted, true);
  assert.deepEqual(sent.map((event) => event.type), ["response.cancel", "output_audio_buffer.clear"]);
  assert.equal(posted.filter((request) => request.body.type === "interrupt").length, 0);
  assert.deepEqual(posted.map((request) => request.body.type), ["voice-speaking"]);
  assert.equal(posted.every((request) => request.path === "/api/realtime/events"), true);
});

test("explicit stop transcripts post transcript first and then interrupt game work", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push({ path: String(path), body });
    const payload = String(path).endsWith("/player-input/transcript") ? { action: "forwarded", route: "model" } : { accepted: true };
    return new Response(JSON.stringify(payload), { status: 200 });
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
  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "危险，快停下！",
    event_id: "input-stop",
  }));

  assert.equal(posted[0]?.path, "/api/dst/v1/companions/bot-1/player-input/transcript");
  assert.equal(posted[0]?.body.source, "voice");
  assert.equal(posted[0]?.body.text, "危险，快停下！");
  assert.equal(posted[1]?.path, "/api/realtime/events");
  assert.equal(posted[1]?.body.type, "interrupt");
  assert.equal(posted.filter((request) => request.body.type === "interrupt").length, 1);
  assert.equal(posted[1]?.body.sessionId, "local-session");
  assert.equal(posted[1]?.body.companionId, "bot-1");
});

test("speech_stopped alone does not create an automatic Realtime response", async (t) => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async () => new Response(JSON.stringify({ accepted: true }), { status: 200 })) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const bridge = createBridge() as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };

  await bridge.handleRealtimeEvent(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));

  assert.deepEqual(sent, []);
});

test("model-routed final transcripts post to player-input transcript before one normal Realtime response", async (t) => {
  const originalFetch = globalThis.fetch;
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push({ path: String(path), body });
    return new Response(JSON.stringify({ route: "model", action: "forwarded" }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const bridge = createBridge() as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "帮我看看附近有什么",
    event_id: "input-model",
  }));

  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.path, "/api/dst/v1/companions/bot-1/player-input/transcript");
  assert.equal(posted[0]?.body.id, "input-model");
  assert.deepEqual(sent, [
    {
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我看看附近有什么" }] },
    },
    { type: "response.create" },
  ]);
});

test("fast transcript routes create one tools-none preamble, dedupe SSE receipts, and block gameplay re-calls", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const latencies: Array<Record<string, unknown>> = [];

  class FakeEventSource {
    static instance?: FakeEventSource;
    onerror?: () => void;
    readonly listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();

    constructor(_url: string) {
      FakeEventSource.instance = this;
    }

    addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    close(): void {}

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ data: JSON.stringify(event) } as MessageEvent<string>);
      }
    }
  }

  globalThis.fetch = (async (path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push({ path: String(path), body });
    if (String(path).endsWith("/player-input/transcript")) {
      return new Response(JSON.stringify({
        route: "fast",
        action: "fast_intent",
        inputId: body.id,
        commandId: "cmd-fast",
        kind: "gather_nearby",
        status: "queued",
        pending: true,
        waitRecommended: true,
        feedback: { policy: "issues_only", channel: "voice_only_preamble" },
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEventSource) {
      Object.defineProperty(globalThis, "EventSource", originalEventSource);
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }
  });

  const bridge = new RealtimeBridge({
    onStatus: () => undefined,
    onTranscript: () => undefined,
    onGatewayEvent: () => undefined,
    onLatency: (entry) => latencies.push(entry as unknown as Record<string, unknown>),
  }, "bot-1") as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };
  bridge.connectEventStream();

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "帮我把附近浆果都采了",
    event_id: "input-fast",
  }));
  FakeEventSource.instance!.emit("player-input", {
    type: "player-input",
    companionId: "bot-1",
    data: {
      source: "game",
      action: "fast_intent",
      inputId: "input-fast",
      command: { id: "cmd-fast", kind: "gather_nearby" },
      status: "queued",
      pending: true,
      feedback: { policy: "issues_only", channel: "voice_only_preamble" },
    },
  });

  const responseCreates = sent.filter((event) => event.type === "response.create");
  assert.equal(responseCreates.length, 1);
  assert.equal((responseCreates[0]?.response as { tool_choice?: string } | undefined)?.tool_choice, "none");
  assert.match(String((responseCreates[0]?.response as { instructions?: string } | undefined)?.instructions ?? ""), /不要调用任何工具/);
  assert.equal(posted.filter((request) => request.path.endsWith("/player-input/transcript")).length, 1);

  FakeEventSource.instance!.emit("command-lifecycle", {
    type: "command-lifecycle",
    companionId: "bot-1",
    data: { id: "cmd-fast", kind: "gather_nearby", status: "started" },
  });
  assert.deepEqual(latencies.map((entry) => entry.metric), ["transcript_to_gateway_route", "transcript_to_command_start"]);
  assert.deepEqual(latencies.map((entry) => entry.label), ["fast route", "gather_nearby start"]);
  assert.equal(latencies.every((entry) => typeof entry.elapsedMs === "number" && Number(entry.elapsedMs) >= 0), true);
  assert.equal(latencies.some((entry) => "text" in entry || "transcript" in entry), false);

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-repeat-gameplay",
    name: "approach_or_retreat",
    arguments: "{\"mode\":\"approach\"}",
  }));

  assert.equal(posted.some((request) => request.body.type === "tool-call"), false);
  const blocked = sent.find((event) => {
    const item = event.item as { call_id?: string } | undefined;
    return item?.call_id === "call-repeat-gameplay";
  })?.item as { output?: string } | undefined;
  assert.equal(JSON.parse(blocked?.output ?? "{}").error.code, "game_action_already_pending");
});

test("SSE game fast_intent receipts without raw text track the command and create one tools-none preamble", (t) => {
  const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const sent: Array<Record<string, unknown>> = [];
  const transcripts: Array<{ role: string; text: string }> = [];

  class FakeEventSource {
    static instance?: FakeEventSource;
    onerror?: () => void;
    readonly listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();

    constructor(_url: string) {
      FakeEventSource.instance = this;
    }

    addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    close(): void {}

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ data: JSON.stringify(event) } as MessageEvent<string>);
      }
    }
  }

  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
  t.after(() => {
    if (originalEventSource) {
      Object.defineProperty(globalThis, "EventSource", originalEventSource);
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }
  });

  const bridge = new RealtimeBridge({
    onStatus: () => undefined,
    onTranscript: (entry) => transcripts.push({ role: entry.role, text: entry.text }),
    onGatewayEvent: () => undefined,
  }, "bot-1") as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };
  bridge.connectEventStream();

  const receipt = {
    type: "player-input",
    companionId: "bot-1",
    data: {
      source: "game",
      action: "fast_intent",
      inputId: "input-game-fast",
      command: { id: "cmd-game-fast", kind: "follow_player" },
      pending: true,
      feedback: { policy: "silent_success", channel: "voice_only_preamble" },
    },
  };
  FakeEventSource.instance!.emit("player-input", receipt);
  FakeEventSource.instance!.emit("player-input", receipt);

  assert.deepEqual(transcripts, []);
  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);
  assert.equal((sent.find((event) => event.type === "response.create")?.response as { tool_choice?: string } | undefined)?.tool_choice, "none");
  assert.equal(sent.filter((event) => event.type === "conversation.item.create").length, 1);
});

test("Realtime tool calls reach the Gateway but raw assistant audio transcripts do not", async (t) => {
  const originalFetch = globalThis.fetch;
  const posted: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const transcripts: Array<{ role: string; text: string }> = [];
  globalThis.fetch = (async (_path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push(body);
    return new Response(JSON.stringify({ output: "{\"accepted\":true}" }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const bridge = new RealtimeBridge({
    onStatus: () => undefined,
    onTranscript: (entry) => transcripts.push({ role: entry.role, text: entry.text }),
    onGatewayEvent: () => undefined,
  }, "bot-1") as unknown as BridgeInternals;
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

  assert.deepEqual(posted.map((body) => body.type), ["tool-call"]);
  assert.equal(posted[0]?.callId, "call-follow");
  assert.deepEqual(transcripts, [{ role: "assistant", text: "I am following you." }]);
  assert.deepEqual(sent[0], {
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: "call-follow", output: "{\"accepted\":true}" },
  });
  assert.deepEqual(sent[1], { type: "response.create" });
});

test("pending gameplay tools do not create a second response after their same-turn preamble", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const sent: Array<Record<string, unknown>> = [];
  const transcripts: Array<{ role: string; text: string }> = [];

  class FakeEventSource {
    static instance?: FakeEventSource;
    onerror?: () => void;
    readonly listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();

    constructor(_url: string) {
      FakeEventSource.instance = this;
    }

    addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    close(): void {}

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ data: JSON.stringify(event) } as MessageEvent<string>);
      }
    }
  }

  globalThis.fetch = (async () => new Response(JSON.stringify({
    output: JSON.stringify({
      accepted: true,
      commandId: "cmd-gather",
      kind: "gather_nearby",
      status: "queued",
      terminal: false,
      pending: true,
      waitRecommended: true,
      feedback: { policy: "issues_only", channel: "voice_only_preamble" },
    }),
  }), { status: 200 })) as typeof fetch;
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEventSource) {
      Object.defineProperty(globalThis, "EventSource", originalEventSource);
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }
  });

  const bridge = new RealtimeBridge({
    onStatus: () => undefined,
    onTranscript: (entry) => transcripts.push({ role: entry.role, text: entry.text }),
    onGatewayEvent: () => undefined,
  }, "bot-1") as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };
  bridge.connectEventStream();

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-gather",
    name: "gather_nearby",
    arguments: "{}",
  }));
  await bridge.handleRealtimeEvent(JSON.stringify({ type: "response.output_audio_transcript.done", transcript: "I will gather them now." }));

  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);
  assert.equal(sent.filter((event) => event.type === "response.cancel").length, 0);
  assert.deepEqual(transcripts, [{ role: "assistant", text: "I will gather them now." }]);

  FakeEventSource.instance!.emit("command-result", {
    type: "command-result",
    companionId: "bot-1",
    data: {
      kind: "gather_nearby",
      result: {
        id: "cmd-gather",
        status: "succeeded",
        stateRevision: 4,
        outcome: {
          gather: {
            scope: "all_same_prefab",
            mode: "collect",
            targetPrefab: "berries",
            attempted: 3,
            completed: 3,
            remaining: 0,
            skipped: 0,
          },
        },
      },
    },
  });
  FakeEventSource.instance!.emit("command-result", {
    type: "command-result",
    companionId: "bot-1",
    data: { kind: "gather_nearby", result: { id: "cmd-gather", status: "succeeded", stateRevision: 4 } },
  });

  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);
  assert.equal(sent.filter((event) => event.type === "conversation.item.create").length, 2);
});

test("stop and clear actions never request a voice preamble", async (t) => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async () => new Response(JSON.stringify({
    output: JSON.stringify({
      accepted: true,
      commandId: "cmd-stop",
      kind: "stop_and_wait",
      status: "queued",
      terminal: false,
      pending: true,
      waitRecommended: true,
      feedback: { policy: "silent_success", channel: "voice_only_preamble" },
    }),
  }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const bridge = createBridge() as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-stop",
    name: "stop_and_wait",
    arguments: "{}",
  }));

  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);
  const item = sent[0]?.item as { call_id?: string; output?: string } | undefined;
  assert.equal(item?.call_id, "call-stop");
  assert.equal(JSON.parse(item?.output ?? "{}").commandId, "cmd-stop");
});

test("always_result terminal responses create one result reply after a direct pending action", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const sent: Array<Record<string, unknown>> = [];

  class FakeEventSource {
    static instance?: FakeEventSource;
    onerror?: () => void;
    readonly listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();

    constructor(_url: string) {
      FakeEventSource.instance = this;
    }

    addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    close(): void {}

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ data: JSON.stringify(event) } as MessageEvent<string>);
      }
    }
  }

  globalThis.fetch = (async () => new Response(JSON.stringify({
    output: JSON.stringify({
      accepted: true,
      commandId: "cmd-always",
      kind: "gather_nearby",
      pending: true,
      waitRecommended: true,
      feedback: { policy: "always_result", channel: "voice_only_preamble" },
    }),
  }), { status: 200 })) as typeof fetch;
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEventSource) {
      Object.defineProperty(globalThis, "EventSource", originalEventSource);
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }
  });

  const bridge = createBridge() as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };
  bridge.connectEventStream();

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-always",
    name: "gather_nearby",
    arguments: "{}",
  }));
  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);

  FakeEventSource.instance!.emit("command-result", {
    type: "command-result",
    companionId: "bot-1",
    data: { kind: "gather_nearby", result: { id: "cmd-always", status: "succeeded", stateRevision: 6 } },
  });
  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);
});

test("same-turn say_in_game preambles are kept voice-only while a game action is pending", async (t) => {
  const originalFetch = globalThis.fetch;
  const posted: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push(body);
    const output = body.name === "gather_nearby"
      ? {
          accepted: true,
          commandId: "cmd-gather",
          kind: "gather_nearby",
          pending: true,
          waitRecommended: true,
          feedback: { policy: "issues_only", channel: "voice_only_preamble" },
        }
      : { accepted: false, deferred: true };
    return new Response(JSON.stringify({ output: JSON.stringify(output) }), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const bridge = createBridge() as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };
  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.done",
    response: {
      output: [
        { type: "function_call", call_id: "call-say", name: "say_in_game", arguments: "{\"text\":\"I understand\"}" },
        { type: "function_call", call_id: "call-gather", name: "gather_nearby", arguments: "{}" },
      ],
    },
  }));

  assert.deepEqual(posted.map((body) => body.name), ["gather_nearby"]);
  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);
  const sayOutput = sent.find((event) => {
    const item = event.item as { call_id?: string } | undefined;
    return item?.call_id === "call-say";
  })?.item as { output?: string } | undefined;
  assert.equal(JSON.parse(sayOutput?.output ?? "{}").error.code, "voice_only_preamble_required");
});

test("browser confirmation answers post to Gateway without creating a raw Realtime turn", async (t) => {
  const originalFetch = globalThis.fetch;
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const transcripts: Array<{ role: string; text: string }> = [];
  globalThis.fetch = (async (path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push({ path: String(path), body });
    return new Response(JSON.stringify({ action: "confirmed", confirmation: "confirm-1" }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const bridge = new RealtimeBridge({
    onStatus: () => undefined,
    onTranscript: (entry) => transcripts.push({ role: entry.role, text: entry.text }),
    onGatewayEvent: () => undefined,
  }, "bot-1") as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = {
    readyState: "open",
    send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>),
  };

  await (bridge as unknown as RealtimeBridge).sendBrowserConfirmationAnswer("是");

  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.path, "/api/dst/v1/companions/bot-1/player-input");
  assert.equal(posted[0]?.body.source, "browser");
  assert.equal(posted[0]?.body.text, "是");
  assert.equal(typeof posted[0]?.body.id, "string");
  assert.deepEqual(sent, []);
  assert.deepEqual(transcripts, []);
});

test("manual browser text still posts to Gateway and creates a Realtime reply turn", async (t) => {
  const originalFetch = globalThis.fetch;
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  const sent: Array<Record<string, unknown>> = [];
  const transcripts: Array<{ role: string; text: string }> = [];
  globalThis.fetch = (async (path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push({ path: String(path), body });
    return new Response(JSON.stringify({ action: "forwarded" }), { status: 200 });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const bridge = new RealtimeBridge({
    onStatus: () => undefined,
    onTranscript: (entry) => transcripts.push({ role: entry.role, text: entry.text }),
    onGatewayEvent: () => undefined,
  }, "bot-1") as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = {
    readyState: "open",
    send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>),
  };

  await (bridge as unknown as RealtimeBridge).sendBrowserText("帮我采草");

  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.path, "/api/dst/v1/companions/bot-1/player-input");
  assert.equal(posted[0]?.body.source, "browser");
  assert.equal(posted[0]?.body.text, "帮我采草");
  assert.deepEqual(transcripts, [{ role: "player", text: "帮我采草" }]);
  assert.deepEqual(sent, [
    {
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: "帮我采草" }] },
    },
    { type: "response.create" },
  ]);
});

test("trusted terminal command results are injected and follow feedback response policy", () => {
  const notice = buildGatewayRealtimeNotice({
    type: "command-result",
    companionId: "bot-1",
    data: {
      kind: "gather_nearby",
      result: { id: "cmd-1", status: "succeeded", stateRevision: 12 },
    },
  });
  assert.equal(notice?.createResponse, false);
  assert.equal(notice?.message.type, "conversation.item.create");
  const item = notice?.message.item as { content?: Array<{ text?: string }> } | undefined;
  const text = item?.content?.[0]?.text ?? "";
  assert.match(text, /gather_nearby/);
  assert.match(text, /succeeded/);
  assert.match(text, /只有 status=succeeded/);

  assert.equal(buildGatewayRealtimeNotice({
    type: "command-result",
    data: {
      kind: "gather_nearby",
      feedback: { policy: "always_result" },
      result: { id: "cmd-2", status: "succeeded", stateRevision: 13 },
    },
  })?.createResponse, true);

  assert.equal(buildGatewayRealtimeNotice({
    type: "command-result",
    data: { kind: "gather_nearby", result: { id: "cmd-3", status: "partial", stateRevision: 14 } },
  })?.createResponse, true);

  assert.equal(buildGatewayRealtimeNotice({
    type: "command-result",
    data: { kind: "gather_nearby", result: { id: "cmd-4", status: "cancelled", reason: "voice_vad", stateRevision: 15 } },
  })?.createResponse, false);

  assert.equal(buildGatewayRealtimeNotice({
    type: "command-result",
    data: { kind: "say_in_game", result: { id: "say-1", status: "succeeded", stateRevision: 16 } },
  }), undefined);
});

test("accepted confirmations update Realtime context and allow one voice preamble", () => {
  const notice = buildGatewayRealtimeNotice({
    type: "confirmation",
    companionId: "bot-1",
    data: {
      id: "confirm-1",
      accepted: true,
      command: { id: "cmd-2", kind: "gather_nearby" },
    },
  });
  assert.equal(notice?.createResponse, true);
  const item = notice?.message.item as { content?: Array<{ text?: string }> } | undefined;
  assert.match(item?.content?.[0]?.text ?? "", /不能说已经完成/);
  assert.match(item?.content?.[0]?.text ?? "", /不要再次调用同一个动作工具/);
  assert.match(item?.content?.[0]?.text ?? "", /语音等待前言/);
});

test("accepted confirmations create only one preamble response and block duplicate action tools", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const posted: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];

  class FakeEventSource {
    static instance?: FakeEventSource;
    onerror?: () => void;
    readonly listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();

    constructor(_url: string) {
      FakeEventSource.instance = this;
    }

    addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    close(): void {}

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ data: JSON.stringify(event) } as MessageEvent<string>);
      }
    }
  }

  globalThis.fetch = (async (_path, init) => {
    posted.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEventSource) {
      Object.defineProperty(globalThis, "EventSource", originalEventSource);
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }
  });

  const bridge = createBridge() as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };
  bridge.connectEventStream();

  const accepted = {
    type: "confirmation",
    companionId: "bot-1",
    data: {
      id: "confirm-1",
      accepted: true,
      command: { id: "cmd-confirm", kind: "give_item" },
    },
  };
  FakeEventSource.instance!.emit("confirmation", accepted);
  FakeEventSource.instance!.emit("confirmation", accepted);

  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-duplicate-give",
    name: "give_item",
    arguments: "{\"itemName\":\"cutgrass\"}",
  }));

  assert.deepEqual(posted, []);
  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);
  const duplicateOutput = sent.find((event) => {
    const item = event.item as { call_id?: string } | undefined;
    return item?.call_id === "call-duplicate-give";
  })?.item as { output?: string } | undefined;
  assert.equal(JSON.parse(duplicateOutput?.output ?? "{}").error.code, "game_action_already_pending");
});

test("EventSource errors schedule a reconnect instead of immediately closing Realtime", (t) => {
  const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const timers: Array<() => void> = [];
  const statuses: Array<string> = [];

  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onerror?: () => void;
    closed = false;
    readonly listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();

    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    close(): void {
      this.closed = true;
    }

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ data: JSON.stringify(event) } as MessageEvent<string>);
      }
    }
  }

  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout: (callback: () => void) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimeout: () => undefined,
    },
  });
  t.after(() => {
    if (originalEventSource) {
      Object.defineProperty(globalThis, "EventSource", originalEventSource);
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  const bridge = new RealtimeBridge({
    onStatus: (status, detail) => statuses.push(`${status}:${detail ?? ""}`),
    onTranscript: () => undefined,
    onGatewayEvent: () => undefined,
  }, "bot-1") as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.connectEventStream();

  assert.equal(FakeEventSource.instances.length, 1);
  FakeEventSource.instances[0]!.onerror?.();

  assert.equal(FakeEventSource.instances[0]!.closed, true);
  assert.deepEqual(statuses, []);
  assert.equal(timers.length, 1);
  timers[0]!();
  assert.equal(FakeEventSource.instances.length, 2);
  assert.match(FakeEventSource.instances[1]!.url, /local-session/);
});

test("malformed Realtime function arguments stay in the voice session and receive a recoverable tool error", async (t) => {
  const originalFetch = globalThis.fetch;
  const posted: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_path, init) => {
    posted.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const bridge = createBridge() as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-bad-json",
    name: "gather_nearby",
    arguments: "{\"targetGuid\":",
  }));

  assert.deepEqual(posted, []);
  assert.deepEqual(sent.map((event) => event.type), ["conversation.item.create", "response.create"]);
  const item = sent[0]?.item as { call_id?: string; output?: string } | undefined;
  assert.equal(item?.call_id, "call-bad-json");
  assert.deepEqual(JSON.parse(item?.output ?? "{}"), {
    ok: false,
    error: {
      code: "invalid_tool_arguments",
      message: "Function arguments must be valid JSON.",
    },
  });
});

test("pending gameplay output without a commandId is a recoverable protocol error", async (t) => {
  const originalFetch = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async () => new Response(JSON.stringify({
    output: JSON.stringify({
      accepted: true,
      kind: "gather_nearby",
      pending: true,
      waitRecommended: true,
      feedback: { policy: "issues_only", channel: "voice_only_preamble" },
    }),
  }), { status: 200 })) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const bridge = createBridge() as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-missing-command-id",
    name: "gather_nearby",
    arguments: "{}",
  }));

  assert.deepEqual(sent.map((event) => event.type), ["conversation.item.create", "response.create"]);
  const item = sent[0]?.item as { output?: string } | undefined;
  assert.equal(JSON.parse(item?.output ?? "{}").error.code, "pending_command_id_missing");
});

test("speech stop restores assistant audio even while a game action is pending", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (body.type === "tool-call") {
      return new Response(JSON.stringify({
        output: JSON.stringify({
          accepted: true,
          commandId: "cmd-gather",
          kind: "gather_nearby",
          pending: true,
          waitRecommended: true,
          feedback: { policy: "issues_only", channel: "voice_only_preamble" },
        }),
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout: () => 0 },
  });
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
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };
  bridge.audio = { muted: false };

  await bridge.handleRealtimeEvent(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  assert.equal(bridge.audio.muted, true);

  await bridge.handleRealtimeEvent(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
  assert.equal(bridge.audio.muted, false);

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-gather",
    name: "gather_nearby",
    arguments: "{}",
  }));
  assert.equal(bridge.audio.muted, false);

  await bridge.handleRealtimeEvent(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  await bridge.handleRealtimeEvent(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
  assert.equal(bridge.audio.muted, false);
  assert.equal(sent.some((event) => event.type === "response.cancel"), false);
});

test("latency callbacks track speech-to-output and tool-to-command-start without transcript data", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = Object.getOwnPropertyDescriptor(globalThis, "EventSource");
  const latencies: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];

  class FakeEventSource {
    static instance?: FakeEventSource;
    onerror?: () => void;
    readonly listeners = new Map<string, Array<(message: MessageEvent<string>) => void>>();

    constructor(_url: string) {
      FakeEventSource.instance = this;
    }

    addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    close(): void {}

    emit(type: string, event: unknown): void {
      for (const listener of this.listeners.get(type) ?? []) {
        listener({ data: JSON.stringify(event) } as MessageEvent<string>);
      }
    }
  }

  globalThis.fetch = (async (_path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (body.type === "tool-call") {
      return new Response(JSON.stringify({
        output: JSON.stringify({
          accepted: true,
          commandId: "cmd-latency",
          kind: "gather_nearby",
          pending: true,
          waitRecommended: true,
          feedback: { policy: "issues_only", channel: "voice_only_preamble" },
        }),
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ accepted: true }), { status: 200 });
  }) as typeof fetch;
  Object.defineProperty(globalThis, "EventSource", { configurable: true, value: FakeEventSource });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalEventSource) {
      Object.defineProperty(globalThis, "EventSource", originalEventSource);
    } else {
      Reflect.deleteProperty(globalThis, "EventSource");
    }
  });

  const bridge = new RealtimeBridge({
    onStatus: () => undefined,
    onTranscript: () => undefined,
    onGatewayEvent: () => undefined,
    onLatency: (entry) => latencies.push(entry as unknown as Record<string, unknown>),
  }, "bot-1") as unknown as BridgeInternals;
  bridge.session = { sessionId: "local-session" };
  bridge.channel = { readyState: "open", send: (payload) => sent.push(JSON.parse(payload) as Record<string, unknown>) };
  bridge.connectEventStream();

  await bridge.handleRealtimeEvent(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
  await bridge.handleRealtimeEvent(JSON.stringify({ type: "response.output_audio_transcript.delta" }));

  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "response.function_call_arguments.done",
    call_id: "call-latency",
    name: "gather_nearby",
    arguments: "{}",
  }));
  FakeEventSource.instance!.emit("command-lifecycle", {
    type: "command-lifecycle",
    companionId: "bot-1",
    data: { id: "cmd-latency", kind: "gather_nearby", status: "started" },
  });

  assert.deepEqual(latencies.map((entry) => entry.metric), ["speech_to_first_assistant_output", "tool_to_command_start"]);
  assert.equal(latencies.every((entry) => typeof entry.elapsedMs === "number" && Number(entry.elapsedMs) >= 0), true);
  assert.equal(latencies.some((entry) => "text" in entry || "transcript" in entry), false);
  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);
});
