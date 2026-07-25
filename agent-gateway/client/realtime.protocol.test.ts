import assert from "node:assert/strict";
import test from "node:test";
import {
  REALTIME_CALLS_URL,
  REALTIME_TOOLS,
  RealtimeBridge,
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

test("VAD immediately interrupts game work and output before its transcript arrives", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push({ path: String(path), body });
    const payload = body.type === "transcript" ? { action: "forwarded" } : { accepted: true };
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
  await bridge.handleRealtimeEvent(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  await bridge.handleRealtimeEvent(JSON.stringify({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "危险，快停下！",
  }));

  assert.equal(posted.filter((request) => request.body.type === "interrupt").length, 1);
  assert.equal(posted.some((request) => request.body.type === "voice-speaking"), true);
  assert.equal(posted.some((request) => request.body.type === "transcript"), true);
  assert.equal(posted.every((request) => request.path === "/api/realtime/events"), true);
  assert.equal(posted.every((request) => request.body.sessionId === "local-session" && request.body.companionId === "bot-1"), true);
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

test("pending gameplay tools suppress assistant output until one trusted terminal result", async (t) => {
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
  assert.deepEqual(transcripts, []);

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

  assert.equal(sent.filter((event) => event.type === "response.create").length, 1);
  assert.equal(sent.filter((event) => event.type === "conversation.item.create").length, 2);
});

test("same-turn gameplay tools are posted before a say_in_game preamble", async (t) => {
  const originalFetch = globalThis.fetch;
  const posted: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    posted.push(body);
    const output = body.name === "gather_nearby"
      ? { accepted: true, commandId: "cmd-gather", kind: "gather_nearby", pending: true, waitRecommended: true }
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

  assert.deepEqual(posted.map((body) => body.name), ["gather_nearby", "say_in_game"]);
  assert.equal(sent.filter((event) => event.type === "response.create").length, 0);
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

test("trusted terminal command results are injected back into Realtime", () => {
  const notice = buildGatewayRealtimeNotice({
    type: "command-result",
    companionId: "bot-1",
    data: {
      kind: "gather_nearby",
      result: { id: "cmd-1", status: "succeeded", stateRevision: 12 },
    },
  });
  assert.equal(notice?.createResponse, true);
  assert.equal(notice?.message.type, "conversation.item.create");
  const item = notice?.message.item as { content?: Array<{ text?: string }> } | undefined;
  const text = item?.content?.[0]?.text ?? "";
  assert.match(text, /gather_nearby/);
  assert.match(text, /succeeded/);
  assert.match(text, /只有 status=succeeded/);

  assert.equal(buildGatewayRealtimeNotice({
    type: "command-result",
    data: { kind: "say_in_game", result: { id: "say-1", status: "succeeded", stateRevision: 13 } },
  }), undefined);
});

test("accepted confirmations update Realtime context without prompting a premature reply", () => {
  const notice = buildGatewayRealtimeNotice({
    type: "confirmation",
    companionId: "bot-1",
    data: {
      id: "confirm-1",
      accepted: true,
      command: { id: "cmd-2", kind: "gather_nearby" },
    },
  });
  assert.equal(notice?.createResponse, false);
  const item = notice?.message.item as { content?: Array<{ text?: string }> } | undefined;
  assert.match(item?.content?.[0]?.text ?? "", /不能说已经完成/);
  assert.match(item?.content?.[0]?.text ?? "", /不要再次调用同一个动作工具/);
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

test("speech stop restores normal assistant audio but keeps it muted while a game action is pending", async (t) => {
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
  assert.equal(bridge.audio.muted, true);

  await bridge.handleRealtimeEvent(JSON.stringify({ type: "input_audio_buffer.speech_started" }));
  await bridge.handleRealtimeEvent(JSON.stringify({ type: "input_audio_buffer.speech_stopped" }));
  assert.equal(bridge.audio.muted, true);
  assert.equal(sent.some((event) => event.type === "response.cancel"), false);
});
