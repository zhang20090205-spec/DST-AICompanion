import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayApp } from "../src/server/app.js";
import { loadConfig, type GatewayConfig } from "../src/server/config.js";
import { GatewayStore } from "../src/server/database.js";
import { GatewayCore } from "../src/server/gateway.js";
import { createRealtimeClientSecret } from "../src/server/realtime.js";
import { ValidationError, boundedExpiry, normalizeState } from "../src/server/validation.js";

const config: GatewayConfig = {
  host: "127.0.0.1",
  port: 8080,
  realtimeModel: "gpt-realtime-2.1",
  realtimeReasoningEffort: "medium",
  realtimeVoice: "marin",
  databasePath: ":memory:",
  airiWsUrl: "ws://127.0.0.1:6121/ws",
  airiAuthToken: "test-token",
  airiModuleName: "dst-companion",
};

function fixtureState() {
  return {
    HP: 97,
    Hunger: 52,
    Sanity: 71,
    Temperature: 18,
    X: 10,
    Z: 22,
    PlayerGUID: 9,
    Distance: 4,
    Node_x: 13,
    Node_z: 25,
    IsDay: true,
    IsBusy: false,
    Entities: [
      { GUID: 100, Prefab: "evergreen", Distance: 7, PlayerDistance: 8, Choppable: true },
      { GUID: 101, Prefab: "spider", Distance: 8, Attackable: true, tags: ["monster"] },
      { GUID: 102, Prefab: "beefalo", Distance: 7, Attackable: true },
    ],
    Inventory: [{ Prefab: "berries", Quantity: 3, GUID: 201 }],
  };
}

function createCore() {
  const store = new GatewayStore(":memory:");
  return { store, core: new GatewayCore(store) };
}

test("Gateway defaults to low Realtime reasoning effort while retaining an explicit high override", () => {
  assert.equal(loadConfig({}).realtimeReasoningEffort, "low");
  assert.equal(loadConfig({ OPENAI_REALTIME_REASONING_EFFORT: "high" }).realtimeReasoningEffort, "high");
  assert.equal(loadConfig({}).airiWsUrl, "ws://127.0.0.1:6121/ws");
  assert.throws(() => loadConfig({ AIRI_WS_URL: "ws://192.168.1.2:6121/ws" }), /loopback/);
});

test("Airi controller mode forwards ordinary game chat without taking the deterministic fast path", () => {
  const { store, core } = createCore();
  core.setControllerMode("airi");
  core.setControllerState(true, true);
  core.receiveState("bot-1", fixtureState());
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  core.subscribe((event) => events.push({ type: event.type, data: event.data }));

  const receipt = core.receivePlayerInput("bot-1", { text: "跟着我", source: "game" });
  assert.equal(receipt.action, "forwarded");
  assert.equal(receipt.route, "airi");
  assert.equal(core.pollCommands("bot-1").commands.length, 0);
  assert.equal(events.some((event) => event.type === "player-input" && event.data.route === "airi"), true);
  store.close();
});

function withFakeNow<T>(initialNow: number, run: (clock: { set: (value: number) => void; advance: (ms: number) => void }) => T): T {
  const originalNow = Date.now;
  let currentNow = initialNow;
  Date.now = () => currentNow;
  try {
    return run({
      set: (value) => {
        currentNow = value;
      },
      advance: (ms) => {
        currentNow += ms;
      },
    });
  } finally {
    Date.now = originalNow;
  }
}

test("normalizes an untrusted compact state without preserving arbitrary fields", () => {
  const state = normalizeState({ ...fixtureState(), injected: "ignore this" }, 3, 10);
  assert.equal(state.revision, 3);
  assert.equal(state.health, 97);
  assert.equal(state.player.guid, 9);
  assert.equal(state.nearby.length, 3);
  assert.equal("injected" in state, false);
});

test("accepts only whitelisted, nearby actions and sends a typed command", () => {
	const { store, core } = createCore();
	core.receiveState("bot-1", fixtureState());
  const command = core.enqueue("bot-1", "gather_nearby", { mode: "chop", targetGuid: 100 }, "player");
  const poll = core.pollCommands("bot-1");
  assert.equal(poll.commands[0]?.id, command.id);
  assert.equal(poll.commands[0]?.kind, "gather_nearby");
	assert.deepEqual(poll.commands[0]?.args, {
		mode: "chop",
		scope: "single",
		targetGuid: 100,
		targetPrefab: "evergreen",
	});
	const retreat = core.enqueue("bot-1", "approach_or_retreat", { mode: "retreat", targetGuid: 101 }, "player");
	assert.deepEqual(retreat.args, { mode: "retreat", targetGuid: 101 });
	assert.throws(() => core.enqueue("bot-1", "gather_nearby", { targetGuid: 999 }, "player"), ValidationError);
	store.close();
});

test("player requests interrupt autonomy and command epochs prevent stale execution", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  core.enqueue("bot-1", "equip_or_eat", { action: "eat", itemName: "berries" }, "autonomy");
  const autonomy = core.pollCommands("bot-1").commands[0]!;
  core.enqueue("bot-1", "follow_player", {}, "player");
  const interrupt = core.pollCommands("bot-1").commands[0]!;
  assert.equal(interrupt.kind, "clear_action_queue");
  assert.ok(interrupt.epoch > autonomy.epoch);
  core.receiveResult("bot-1", { id: interrupt.id, status: "succeeded", stateRevision: 1 });
  const follow = core.pollCommands("bot-1").commands[0]!;
  assert.equal(follow.kind, "follow_player");
  assert.equal(follow.epoch, interrupt.epoch);
  store.close();
});

test("queued player commands outrank queued autonomy and remove stale autonomy", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  core.subscribe((event) => events.push(event));
  const autonomy = core.enqueue("bot-1", "equip_or_eat", { action: "eat", itemName: "berries" }, "autonomy");
  const player = core.enqueue("bot-1", "follow_player", {}, "player");
  const command = core.pollCommands("bot-1").commands[0]!;
  assert.equal(command.id, player.id);
  assert.equal(command.priority, "player");
  assert.equal(core.commandStatus("bot-1", autonomy.id)?.status, "cancelled");
  const cancellation = events.find((event) => {
    const result = event.data.result as { id?: string } | undefined;
    return event.type === "command-result" && result?.id === autonomy.id;
  });
  const result = cancellation?.data.result as { status?: string; reason?: string } | undefined;
  const lifecycle = cancellation?.data.lifecycle as { status?: string; terminal?: boolean } | undefined;
  assert.equal(result?.status, "cancelled");
  assert.equal(result?.reason, "player_override");
  assert.equal(lifecycle?.status, "cancelled");
  assert.equal(lifecycle?.terminal, true);
  core.receiveResult("bot-1", { id: command.id, status: "succeeded", stateRevision: 1 });
  assert.equal(core.pollCommands("bot-1").commands.length, 0);
  store.close();
});

test("results are idempotent and expired commands are never dispatched", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const command = core.enqueue("bot-1", "follow_player", {}, "player");
  assert.equal(core.pollCommands("bot-1").commands.length, 1);
  assert.deepEqual(core.receiveResult("bot-1", { id: command.id, status: "succeeded", stateRevision: 1 }), { accepted: true, duplicate: false });
  assert.deepEqual(core.receiveResult("bot-1", { id: command.id, status: "succeeded", stateRevision: 1 }), { accepted: false, duplicate: true });
  assert.ok(boundedExpiry(10, 999_999, "follow_player") <= 30_010);
  store.close();
});

test("active command results after TTL are ignored", () => {
  withFakeNow(1_000_000, (clock) => {
    const { store, core } = createCore();
    core.receiveState("bot-1", fixtureState());
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    core.subscribe((event) => events.push(event));
    const command = core.enqueue("bot-1", "follow_player", {}, "player");
    assert.equal(core.pollCommands("bot-1").commands[0]?.id, command.id);
    clock.set(command.expiresAt + 1);
    assert.deepEqual(core.receiveResult("bot-1", { id: command.id, status: "succeeded", stateRevision: 1 }), { accepted: false, duplicate: true });
    assert.equal(core.pollCommands("bot-1").commands.length, 0);
    assert.equal(store.recentAudit().some((entry) => entry.event === "command_expired" && entry.metadata.id === command.id), true);
    const cancellation = events.find((event) => {
      const result = event.data.result as { id?: string } | undefined;
      return event.type === "command-result" && result?.id === command.id;
    });
    const result = cancellation?.data.result as { status?: string; reason?: string } | undefined;
    const lifecycle = cancellation?.data.lifecycle as { status?: string; terminal?: boolean } | undefined;
    assert.equal(result?.status, "cancelled");
    assert.equal(result?.reason, "command expired");
    assert.equal(lifecycle?.terminal, true);
    store.close();
  });
});

test("started results are idempotent while keeping the command active", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const command = core.enqueue("bot-1", "follow_player", {}, "player");
  assert.equal(core.pollCommands("bot-1").commands[0]?.id, command.id);
  assert.deepEqual(core.receiveResult("bot-1", { id: command.id, status: "started", stateRevision: 1 }), { accepted: true, duplicate: false });
  assert.deepEqual(core.receiveResult("bot-1", { id: command.id, status: "started", stateRevision: 1 }), { accepted: true, duplicate: true });
  assert.deepEqual(core.receiveResult("bot-1", { id: command.id, status: "succeeded", stateRevision: 1 }), { accepted: true, duplicate: false });
  store.close();
});

test("confirmation expires after twenty seconds and player input is never persisted as memory", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const confirmation = core.requestConfirmation("bot-1", "attack_nearby_threat", { targetGuid: 102 }, "攻击这只牛吗？");
  core.watchdog(confirmation.expiresAt + 1);
  const expiredReply = core.receivePlayerInput("bot-1", { text: "是", source: "game" });
  assert.equal(expiredReply.action, "forwarded");
  assert.equal(expiredReply.route, "realtime");
  const privateText = "this transcript must never persist";
  core.receivePlayerInput("bot-1", { id: "unique-input", text: privateText, source: "voice" });
  assert.equal(JSON.stringify(store.recentAudit()).includes(privateText), false);
  assert.equal(store.getMemory("transcript"), undefined);
  store.close();
});

test("accepted confirmations add internal confirmed marker after sanitizing command args", () => {
  const { store, core } = createCore();
  const state = {
    ...fixtureState(),
    Entities: [...fixtureState().Entities, { GUID: 103, Prefab: "chester", Distance: 5, Attackable: true }],
  };
  core.receiveState("bot-1", state);
  const rawCommand = core.enqueue("bot-1", "attack_nearby_threat", { targetGuid: 101, confirmed: true }, "player");
  assert.deepEqual(rawCommand.args, { targetGuid: 101 });
  core.receiveResult("bot-1", { id: core.pollCommands("bot-1").commands[0]!.id, status: "succeeded", stateRevision: 1 });
  assert.throws(() => core.enqueue("bot-1", "attack_nearby_threat", { targetGuid: 103, confirmed: true }, "player"), ValidationError);

  const confirmation = core.requestConfirmation("bot-1", "attack_nearby_threat", { targetGuid: 103, confirmed: true, injected: "ignore" }, "confirm attack?");
  const accepted = core.receivePlayerInput("bot-1", { text: "yes", source: "game" });
  assert.equal(accepted.action, "confirmed");
  assert.equal(accepted.route, "confirmation");
  assert.equal(accepted.confirmation, confirmation.id);
  assert.equal(accepted.command?.kind, "attack_nearby_threat");
  assert.equal(store.getCompanionMemory("bot-1", "preference.attack_nearby_threat"), "approved");
  const command = core.pollCommands("bot-1").commands[0]!;
  assert.equal(command.kind, "attack_nearby_threat");
  assert.deepEqual(command.args, { targetGuid: 103, confirmed: true });
  store.close();
});

test("Chinese stop and confirmation words take the local safety paths", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const stop = core.receivePlayerInput("bot-1", { text: "停止", source: "game" });
  assert.equal(stop.action, "interrupted");
  assert.equal(stop.route, "fast_intent");
  assert.equal(stop.command?.kind, "clear_action_queue");

  const confirmation = core.requestConfirmation("bot-1", "attack_nearby_threat", { targetGuid: 102 }, "确认攻击吗？");
  const accepted = core.receivePlayerInput("bot-1", { text: "是", source: "game" });
  assert.equal(accepted.action, "confirmed");
  assert.equal(accepted.route, "confirmation");
  assert.equal(accepted.confirmation, confirmation.id);

  const secondConfirmation = core.requestConfirmation("bot-1", "attack_nearby_threat", { targetGuid: 102 }, "确认攻击吗？");
  const rejected = core.receivePlayerInput("bot-1", { text: "否", source: "game" });
  assert.equal(rejected.action, "rejected");
  assert.equal(rejected.route, "confirmation");
  assert.equal(rejected.confirmation, secondConfirmation.id);
  store.close();
});

test("fast intent router immediately routes safe Chinese movement and resource commands without raw SSE transcripts", () => {
  const { store, core } = createCore();
  const events: Array<{ type: string; companionId?: string; data: Record<string, unknown> }> = [];
  core.subscribe((event) => events.push(event));
  const resourceEntities = [
    { GUID: 401, Prefab: "grass", Distance: 6, PlayerDistance: 5, Collectable: true },
    { GUID: 402, Prefab: "berrybush", Distance: 7, PlayerDistance: 7, Collectable: true },
    { GUID: 403, Prefab: "sapling", Distance: 8, PlayerDistance: 9, Collectable: true },
    { GUID: 404, Prefab: "cutgrass", Distance: 1, PlayerDistance: 1, Collectable: true },
    { GUID: 405, Prefab: "berries", Distance: 1, PlayerDistance: 1, Collectable: true },
    { GUID: 406, Prefab: "twigs", Distance: 1, PlayerDistance: 1, Collectable: true },
  ];
  const scenarios = [
    {
      companionId: "fast-follow",
      text: "跟着我",
      source: "game" as const,
      expectedKind: "follow_player",
      expectedArgs: {},
    },
    {
      companionId: "fast-approach",
      text: "过来",
      source: "browser" as const,
      expectedKind: "approach_or_retreat",
      expectedArgs: { mode: "approach", targetGuid: 9 },
    },
    {
      companionId: "fast-grass",
      text: "把所有草都采了",
      source: "voice" as const,
      expectedKind: "gather_nearby",
      expectedArgs: { mode: "collect", scope: "all_same_prefab", targetGuid: 401, targetPrefab: "grass" },
    },
    {
      companionId: "fast-berries",
      text: "采浆果",
      source: "game" as const,
      expectedKind: "gather_nearby",
      expectedArgs: { mode: "collect", scope: "single", targetGuid: 402, targetPrefab: "berrybush" },
    },
    {
      companionId: "fast-twigs",
      text: "捡树枝",
      source: "voice" as const,
      expectedKind: "gather_nearby",
      expectedArgs: { mode: "collect", scope: "single", targetGuid: 403, targetPrefab: "sapling" },
    },
  ];

  for (const scenario of scenarios) {
    core.receiveState(scenario.companionId, { ...fixtureState(), Entities: resourceEntities });
    const receipt = core.receivePlayerInput(scenario.companionId, {
      id: `${scenario.companionId}-input`,
      text: scenario.text,
      source: scenario.source,
    });
    assert.equal(receipt.action, "routed");
    assert.equal(receipt.route, "fast_intent");
    assert.equal(receipt.inputId, `${scenario.companionId}-input`);
    assert.equal(receipt.command?.kind, scenario.expectedKind);
    assert.deepEqual(receipt.command?.args, scenario.expectedArgs);
    assert.equal(receipt.residualText, undefined);

    const command = core.pollCommands(scenario.companionId).commands[0]!;
    assert.equal(command.kind, scenario.expectedKind);
    assert.deepEqual(command.args, scenario.expectedArgs);
    const event = events.filter((entry) => entry.type === "player-input" && entry.companionId === scenario.companionId).at(-1);
    assert.equal(event?.data.route, "fast_intent");
    assert.equal("text" in (event?.data ?? {}), false);
  }
  store.close();
});

test("mixed safe player input queues one command and relays only residual text live", () => {
  const { store, core } = createCore();
  const events: Array<{ type: string; companionId?: string; data: Record<string, unknown> }> = [];
  core.subscribe((event) => events.push(event));
  core.receiveState("bot-mixed", {
    ...fixtureState(),
    Entities: [{ GUID: 601, Prefab: "grass", Distance: 6, PlayerDistance: 5, Collectable: true }],
  });

  const receipt = core.receivePlayerInput("bot-mixed", {
    id: "mixed-safe-command",
    userid: "KU_private_player",
    text: "请帮我采草，然后 tell me about camp",
    source: "voice",
  });

  assert.equal(receipt.action, "routed");
  assert.equal(receipt.route, "fast_intent");
  assert.deepEqual(receipt.residualText, { present: true, route: "realtime" });
  assert.equal("text" in (receipt as unknown as Record<string, unknown>), false);
  assert.equal(receipt.command?.kind, "gather_nearby");
  assert.deepEqual(receipt.command?.args, {
    mode: "collect",
    scope: "single",
    targetGuid: 601,
    targetPrefab: "grass",
  });

  const command = core.pollCommands("bot-mixed").commands[0]!;
  assert.equal(command.id, receipt.command?.id);
  assert.equal(command.kind, "gather_nearby");
  assert.deepEqual(command.args, receipt.command?.args);

  const playerEvents = events.filter((event) => event.type === "player-input" && event.companionId === "bot-mixed");
  assert.equal(playerEvents.length, 2);
  assert.equal(playerEvents[0]?.data.route, "fast_intent");
  assert.equal("text" in (playerEvents[0]?.data ?? {}), false);
  assert.deepEqual(playerEvents[0]?.data.residualText, { present: true, route: "realtime" });
  assert.equal(playerEvents[1]?.data.action, "forwarded");
  assert.equal(playerEvents[1]?.data.route, "realtime");
  assert.equal(playerEvents[1]?.data.reason, "residual_text");
  assert.equal(playerEvents[1]?.data.text, "tell me about camp");
  assert.equal(playerEvents[1]?.data.source, "game");
  assert.equal(playerEvents[1]?.data.originalSource, "voice");
  assert.deepEqual(playerEvents[1]?.data.residualText, { present: true, route: "realtime" });

  const persisted = JSON.stringify(store.recentAudit()) + String(store.getCompanionMemory("bot-mixed", "current_goal") ?? "");
  assert.equal(persisted.includes("tell me about camp"), false);
  assert.equal(persisted.includes("请帮我采草"), false);
  assert.equal(store.getMemory("transcript"), undefined);
  store.close();
});

test("mixed input with multiple safe commands or high-risk residual does not queue locally", () => {
  const { store, core } = createCore();
  const events: Array<{ type: string; companionId?: string; data: Record<string, unknown> }> = [];
  core.subscribe((event) => events.push(event));
  const state = {
    ...fixtureState(),
    Entities: [
      { GUID: 611, Prefab: "grass", Distance: 6, PlayerDistance: 5, Collectable: true },
      { GUID: 612, Prefab: "spider", Distance: 7, PlayerDistance: 7, Attackable: true, tags: ["monster"] },
    ],
  };
  core.receiveState("bot-multi", state);
  const multi = core.receivePlayerInput("bot-multi", { text: "采草然后跟着我", source: "game" });
  assert.equal(multi.action, "blocked");
  assert.equal(multi.route, "fast_intent");
  assert.equal(multi.reason, "ambiguous_intent");
  assert.equal(core.pollCommands("bot-multi").commands.length, 0);

  core.receiveState("bot-risk-residual", state);
  const highRisk = core.receivePlayerInput("bot-risk-residual", { text: "采草然后攻击蜘蛛", source: "game" });
  assert.equal(highRisk.action, "blocked");
  assert.equal(highRisk.route, "fast_intent");
  assert.equal(highRisk.reason, "ambiguous_intent");
  assert.equal(core.pollCommands("bot-risk-residual").commands.length, 0);

  const multiEvent = events.find((event) => event.type === "player-input" && event.companionId === "bot-multi");
  const riskEvent = events.find((event) => event.type === "player-input" && event.companionId === "bot-risk-residual");
  assert.equal(multiEvent?.data.text, "采草然后跟着我");
  assert.equal(riskEvent?.data.text, "采草然后攻击蜘蛛");
  store.close();
});

test("fast gather blocks stale and ambiguous, but walks to out-of-reach and player-far resources", () => {
  withFakeNow(5_000_000, (clock) => {
    const { store, core } = createCore();
    const events: Array<{ type: string; companionId?: string; data: Record<string, unknown> }> = [];
    core.subscribe((event) => events.push(event));

    core.receiveState("bot-stale", {
      ...fixtureState(),
      Entities: [{ GUID: 501, Prefab: "grass", Distance: 5, PlayerDistance: 5, Collectable: true }],
    });
    clock.advance(5_001);
    const stale = core.receivePlayerInput("bot-stale", { text: "采草", source: "voice" });
    assert.equal(stale.action, "blocked");
    assert.equal(stale.reason, "stale_state");
    const staleFollow = core.receivePlayerInput("bot-stale", { text: "跟着我", source: "game" });
    assert.equal(staleFollow.action, "blocked");
    assert.equal(staleFollow.reason, "stale_state");
    assert.equal(core.pollCommands("bot-stale").commands.length, 0);

    core.receiveState("bot-ambiguous", {
      ...fixtureState(),
      Entities: [
        { GUID: 502, Prefab: "grass", Distance: 5, PlayerDistance: 5, Collectable: true },
        { GUID: 503, Prefab: "sapling", Distance: 6, PlayerDistance: 6, Collectable: true },
      ],
    });
    const ambiguous = core.receivePlayerInput("bot-ambiguous", { text: "采草和树枝", source: "game" });
    assert.equal(ambiguous.action, "blocked");
    assert.equal(ambiguous.reason, "ambiguous_intent");
    assert.equal(core.pollCommands("bot-ambiguous").commands.length, 0);

    // No matching bush is visible (only harvested item drops). The router no
    // longer dead-ends: it queues a prefab-only gather and the Lua brain
    // searches a wider radius and walks the companion to any grass tuft.
    core.receiveState("bot-drops", {
      ...fixtureState(),
      Entities: [
        { GUID: 504, Prefab: "cutgrass", Distance: 1, PlayerDistance: 1, Collectable: true },
        { GUID: 505, Prefab: "berries", Distance: 1, PlayerDistance: 1, Collectable: true },
        { GUID: 506, Prefab: "twigs", Distance: 1, PlayerDistance: 1, Collectable: true },
      ],
    });
    const droppedItem = core.receivePlayerInput("bot-drops", { text: "采草", source: "game" });
    assert.equal(droppedItem.action, "routed");
    assert.equal(droppedItem.command?.kind, "gather_nearby");
    assert.deepEqual(droppedItem.command?.args, { mode: "collect", scope: "single", targetPrefab: "grass" });

    // A grass tuft the companion can see but the player has wandered 22 units
    // from is now within the gather leash, so the companion walks over.
    core.receiveState("bot-player-far", {
      ...fixtureState(),
      Entities: [{ GUID: 507, Prefab: "grass", Distance: 5, PlayerDistance: 22, Collectable: true }],
    });
    const playerFar = core.receivePlayerInput("bot-player-far", { text: "采草", source: "voice" });
    assert.equal(playerFar.action, "routed");
    assert.equal(playerFar.command?.kind, "gather_nearby");
    assert.deepEqual(playerFar.command?.args, { mode: "collect", scope: "single", targetGuid: 507, targetPrefab: "grass" });
    assert.equal(core.pollCommands("bot-player-far").commands[0]?.kind, "gather_nearby");
    core.receiveResult("bot-player-far", { id: playerFar.command!.id, status: "cancelled", stateRevision: 1 });

    // Movement (approach) keeps its tighter boundary: a player past the
    // movement distance must still be clarified, never chased.
    core.receiveState("bot-player-far", { ...fixtureState(), Distance: 22 });
    const farApproach = core.receivePlayerInput("bot-player-far", { text: "过来", source: "game" });
    assert.equal(farApproach.action, "blocked");
    assert.equal(farApproach.reason, "target_unavailable");
    const ambiguousEnglishWait = core.receivePlayerInput("bot-player-far", { text: "wait a second", source: "voice" });
    assert.equal(ambiguousEnglishWait.action, "forwarded");
    assert.equal(ambiguousEnglishWait.route, "realtime");
    core.receiveState("bot-approach-boundary", { ...fixtureState(), Distance: 21 });
    const approachBoundary = core.receivePlayerInput("bot-approach-boundary", { text: "过来", source: "voice" });
    assert.equal(approachBoundary.action, "blocked");
    assert.equal(approachBoundary.reason, "target_unavailable");
    assert.equal(core.pollCommands("bot-approach-boundary").commands.length, 0);
    const routedEvents = events.filter((event) => event.type === "player-input" && event.data.action === "routed");
    assert.equal(routedEvents.every((event) => !("text" in event.data)), true);
    const blockedGameInput = events.find((event) => event.type === "player-input" && event.companionId === "bot-ambiguous");
    assert.equal(blockedGameInput?.data.action, "blocked");
    assert.equal(blockedGameInput?.data.text, "采草和树枝");
    store.close();
  });
});

test("fast router recognizes chop, mine, homophones, and walks to out-of-sight resources", () => {
  const { store, core } = createCore();

  // 砍 forces chop mode; the visible evergreen resolves to a concrete target.
  core.receiveState("bot-chop", fixtureState());
  const chop = core.receivePlayerInput("bot-chop", { text: "砍树", source: "voice" });
  assert.equal(chop.action, "routed");
  assert.equal(chop.command?.kind, "gather_nearby");
  assert.deepEqual(chop.command?.args, { mode: "chop", scope: "single", targetGuid: 100, targetPrefab: "evergreen" });

  core.receiveState("bot-chop-all", fixtureState());
  const chopAll = core.receivePlayerInput("bot-chop-all", { text: "把树都砍了", source: "game" });
  assert.equal(chopAll.action, "routed");
  assert.deepEqual(chopAll.command?.args, { mode: "chop", scope: "all_same_prefab", targetGuid: 100, targetPrefab: "evergreen" });

  // 挖 forces mine mode; no boulder is visible, so it defers to the Lua brain.
  core.receiveState("bot-mine", fixtureState());
  const mine = core.receivePlayerInput("bot-mine", { text: "挖石头", source: "voice" });
  assert.equal(mine.action, "routed");
  assert.deepEqual(mine.command?.args, { mode: "mine", scope: "single", targetPrefab: "rock1" });

  // 姜果 is a common ASR misrecognition of 浆果 and must still route to berries.
  core.receiveState("bot-homophone", fixtureState());
  const homophone = core.receivePlayerInput("bot-homophone", { text: "采姜果", source: "voice" });
  assert.equal(homophone.action, "routed");
  assert.deepEqual(homophone.command?.args, { mode: "collect", scope: "single", targetPrefab: "berrybush" });
  store.close();
});

test("fast intents do not cancel pending high-risk confirmations", () => {
  const { store, core } = createCore();
  const events: Array<{ type: string; companionId?: string; data: Record<string, unknown> }> = [];
  core.subscribe((event) => events.push(event));
  core.receiveState("bot-1", {
    ...fixtureState(),
    Entities: [
      ...fixtureState().Entities,
      { GUID: 401, Prefab: "grass", Distance: 6, PlayerDistance: 5, Collectable: true },
    ],
  });
  const confirmation = core.requestConfirmation("bot-1", "attack_nearby_threat", { targetGuid: 102 }, "确认攻击吗？");
  const receipt = core.receivePlayerInput("bot-1", { id: "pending-gather", text: "采草", source: "voice" });
  assert.equal(receipt.action, "forwarded");
  assert.equal(receipt.route, "realtime");
  assert.equal(receipt.reason, "pending_confirmation");
  assert.equal(core.pollCommands("bot-1").commands.length, 0);
  const status = core.status().companions as Array<{ id?: string; confirmation?: { id?: string } | null }>;
  assert.equal(status.find((entry) => entry.id === "bot-1")?.confirmation?.id, confirmation.id);
  const event = events.filter((entry) => entry.type === "player-input").at(-1);
  assert.equal(event?.data.route, "realtime");
  assert.equal(event?.data.reason, "pending_confirmation");
  store.close();
});

test("blocked fast follow cannot be bypassed through a Realtime tool call", async () => {
  const { store, core } = createCore();
  const blocked = core.receivePlayerInput("bot-stale-follow", { text: "跟着我", source: "voice" });
  assert.equal(blocked.action, "blocked");
  assert.equal(blocked.reason, "stale_state");
  await assert.rejects(
    core.handleRealtimeTool("bot-stale-follow", "follow_player", {}, "stale-follow-tool"),
    ValidationError,
  );
  assert.equal(core.pollCommands("bot-stale-follow").commands.length, 0);

  core.receiveState("bot-no-player-follow", { ...fixtureState(), PlayerGUID: null, Distance: null });
  const unavailable = core.receivePlayerInput("bot-no-player-follow", { text: "跟着我", source: "game" });
  assert.equal(unavailable.action, "blocked");
  assert.equal(unavailable.reason, "target_unavailable");
  await assert.rejects(
    core.handleRealtimeTool("bot-no-player-follow", "follow_player", {}, "no-player-follow-tool"),
    ValidationError,
  );
  assert.equal(core.pollCommands("bot-no-player-follow").commands.length, 0);
  store.close();
});

test("fast player input dedupes, replaces active player work, and blocks duplicate Realtime gameplay tools", async () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", {
    ...fixtureState(),
    Entities: [
      ...fixtureState().Entities,
      { GUID: 401, Prefab: "grass", Distance: 6, PlayerDistance: 5, Collectable: true },
    ],
  });
  const first = core.receivePlayerInput("bot-1", { id: "fast-follow-once", text: "跟着我", source: "voice" });
  const duplicate = core.receivePlayerInput("bot-1", { id: "fast-follow-once", text: "跟着我", source: "voice" });
  assert.equal(first.action, "routed");
  assert.equal(duplicate.action, "duplicate");
  assert.equal(core.pollCommands("bot-1").commands[0]?.id, first.command?.id);
  core.receiveResult("bot-1", { id: first.command!.id, status: "succeeded", stateRevision: 1 });

  const active = core.enqueue("bot-1", "gather_nearby", { mode: "chop", targetGuid: 100 }, "player");
  assert.equal(core.pollCommands("bot-1").commands[0]?.id, active.id);
  const replacement = core.receivePlayerInput("bot-1", { id: "replace-with-follow", text: "跟着我", source: "game" });
  assert.equal(replacement.action, "routed");
  assert.equal(replacement.command?.kind, "follow_player");
  assert.equal(core.commandStatus("bot-1", active.id)?.status, "cancelled");

  const blockedTool = await core.handleRealtimeTool("bot-1", "gather_nearby", { mode: "collect", targetGuid: 401 }, "call-during-fast");
  assert.equal(blockedTool.output.accepted, false);
  assert.equal(blockedTool.output.route, "fast_intent");

  const clear = core.pollCommands("bot-1").commands[0]!;
  assert.equal(clear.kind, "clear_action_queue");
  core.receiveResult("bot-1", { id: clear.id, status: "succeeded", stateRevision: 2 });
  const follow = core.pollCommands("bot-1").commands[0]!;
  assert.equal(follow.id, replacement.command?.id);
  assert.equal(follow.kind, "follow_player");
  store.close();
});

test("equip_or_eat names one current inventory item before it can be confirmed or dispatched", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  assert.throws(() => core.enqueue("bot-1", "equip_or_eat", { action: "eat" }, "player"), ValidationError);
  assert.throws(() => core.requestConfirmation("bot-1", "equip_or_eat", { action: "eat" }, "eat something?"), ValidationError);
  assert.throws(() => core.enqueue("bot-1", "equip_or_eat", { action: "eat", itemName: "dragonpie" }, "player"), ValidationError);

  const command = core.enqueue("bot-1", "equip_or_eat", { action: "eat", itemName: "berries" }, "player");
  assert.deepEqual(command.args, { action: "eat", itemName: "berries" });
  store.close();
});

test("offline voice state forces an interrupt and leaves the bot standing by", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  core.setVoiceState("bot-1", true);
  core.watchdog(Date.now() + 20_000);
  const command = core.pollCommands("bot-1").commands[0]!;
  assert.equal(command.kind, "clear_action_queue");
  assert.equal(command.priority, "interrupt");
  store.close();
});

test("Realtime inactive voice-state event interrupts and enters offline standby", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  const session = core.registerBrowserSession();
  core.receiveState("bot-1", fixtureState());
  const connected = await app.inject({
    method: "POST",
    url: "/api/realtime/events",
    payload: { sessionId: session.sessionId, companionId: "bot-1", type: "voice-state", active: true },
  });
  const disconnected = await app.inject({
    method: "POST",
    url: "/api/realtime/events",
    payload: { sessionId: session.sessionId, companionId: "bot-1", type: "voice-state", active: false },
  });
  assert.equal(connected.statusCode, 200);
  assert.equal(disconnected.statusCode, 200);
  const command = core.pollCommands("bot-1").commands[0]!;
  assert.equal(command.kind, "clear_action_queue");
  assert.equal(command.priority, "interrupt");
  assert.deepEqual(command.args, { reason: "voice_connection_closed" });
  const status = core.status().companions as Array<Record<string, unknown>>;
  assert.equal(status[0]?.voiceConnected, false);
  assert.equal(status[0]?.voiceOfflineStandby, true);
  await app.close();
  store.close();
});

test("voice watchdog timeout keeps autonomy disabled after stop completion until reconnect", () => {
  withFakeNow(2_000_000, (clock) => {
    const { store, core } = createCore();
    core.receiveState("bot-1", fixtureState());
    core.setVoiceState("bot-1", true);
    clock.advance(16_000);
    core.watchdog(Date.now());
    const interrupt = core.pollCommands("bot-1").commands[0]!;
    assert.equal(interrupt.kind, "clear_action_queue");
    assert.deepEqual(core.receiveResult("bot-1", { id: interrupt.id, status: "succeeded", stateRevision: 1 }), { accepted: true, duplicate: false });

    core.receiveState("bot-1", { ...fixtureState(), Hunger: 10 });
    core.runAutonomy(Date.now());
    assert.equal(core.pollCommands("bot-1").commands.length, 0);
    const status = core.status().companions as Array<Record<string, unknown>>;
    assert.equal(status[0]?.voiceOfflineStandby, true);

    core.setVoiceState("bot-1", true);
    const reconnectedStatus = core.status().companions as Array<Record<string, unknown>>;
    assert.equal(reconnectedStatus[0]?.voiceOfflineStandby, false);
    core.runAutonomy(Date.now());
    const autonomy = core.pollCommands("bot-1").commands[0]!;
    assert.equal(autonomy.kind, "equip_or_eat");
    assert.deepEqual(autonomy.args, { action: "eat", itemName: "berries" });
    store.close();
  });
});

test("autonomy requires a live idle voice session", () => {
  withFakeNow(3_000_000, () => {
    const { store, core } = createCore();
    core.receiveState("bot-1", { ...fixtureState(), Hunger: 10 });
    core.runAutonomy(Date.now());
    assert.equal(core.pollCommands("bot-1").commands.length, 0);

    core.setVoiceState("bot-1", true);
    core.runAutonomy(Date.now());
    const command = core.pollCommands("bot-1").commands[0]!;
    assert.equal(command.kind, "equip_or_eat");
    assert.deepEqual(command.args, { action: "eat", itemName: "berries" });
    store.close();
  });
});

test("Realtime voice-speaking event blocks autonomy until speech stops", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  const session = core.registerBrowserSession();
  core.receiveState("bot-1", { ...fixtureState(), Hunger: 10 });
  const connected = await app.inject({
    method: "POST",
    url: "/api/realtime/events",
    payload: { sessionId: session.sessionId, companionId: "bot-1", type: "voice-state", active: true },
  });
  const speaking = await app.inject({
    method: "POST",
    url: "/api/realtime/events",
    payload: { sessionId: session.sessionId, companionId: "bot-1", type: "voice-speaking", active: true },
  });
  assert.equal(connected.statusCode, 200);
  assert.equal(speaking.statusCode, 200);
  core.runAutonomy(Date.now());
  assert.equal(core.pollCommands("bot-1").commands.length, 0);

  const stopped = await app.inject({
    method: "POST",
    url: "/api/realtime/events",
    payload: { sessionId: session.sessionId, companionId: "bot-1", type: "voice-speaking", active: false },
  });
  assert.equal(stopped.statusCode, 200);
  core.runAutonomy(Date.now());
  const command = core.pollCommands("bot-1").commands[0]!;
  assert.equal(command.kind, "equip_or_eat");
  assert.deepEqual(command.args, { action: "eat", itemName: "berries" });
  await app.close();
  store.close();
});

test("HTTP contract exposes state, commands, results, and natural language input", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  const state = await app.inject({ method: "POST", url: "/api/dst/v1/companions/bot-1/state", payload: fixtureState() });
  assert.equal(state.statusCode, 200);
  core.enqueue("bot-1", "follow_player", {}, "player");
  const commands = await app.inject({ method: "GET", url: "/api/dst/v1/companions/bot-1/commands" });
  assert.equal(commands.json().commands[0].kind, "follow_player");
  const input = await app.inject({ method: "POST", url: "/api/dst/v1/companions/bot-1/player-input", payload: { text: "你好", source: "game" } });
  assert.equal(input.json().action, "forwarded");
  assert.equal(input.json().route, "realtime");
  await app.close();
  store.close();
});

test("HTTP and Realtime transcript APIs expose fast-route receipts and queue safe commands", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  core.receiveState("bot-http", {
    ...fixtureState(),
    Entities: [{ GUID: 401, Prefab: "grass", Distance: 6, PlayerDistance: 5, Collectable: true }],
  });

  const input = await app.inject({
    method: "POST",
    url: "/api/dst/v1/companions/bot-http/player-input",
    payload: { id: "api-gather", text: "采所有草", source: "browser" },
  });
  assert.equal(input.statusCode, 200);
  assert.equal(input.json().action, "routed");
  assert.equal(input.json().route, "fast_intent");
  assert.equal(input.json().inputId, "api-gather");
  assert.equal(input.json().command.kind, "gather_nearby");
  assert.deepEqual(input.json().command.args, {
    mode: "collect",
    scope: "all_same_prefab",
    targetGuid: 401,
    targetPrefab: "grass",
  });
  assert.equal(core.pollCommands("bot-http").commands[0]?.id, input.json().command.id);

  core.receiveState("bot-voice", {
    ...fixtureState(),
    Entities: [{ GUID: 402, Prefab: "berrybush", Distance: 6, PlayerDistance: 5, Collectable: true }],
  });
  const voiceTranscript = await app.inject({
    method: "POST",
    url: "/api/dst/v1/companions/bot-voice/player-input/transcript",
    payload: { id: "voice-berries", text: "采浆果", source: "browser" },
  });
  assert.equal(voiceTranscript.statusCode, 200);
  assert.equal(voiceTranscript.json().route, "fast_intent");
  assert.equal(voiceTranscript.json().command.kind, "gather_nearby");
  assert.equal(voiceTranscript.json().command.args.targetPrefab, "berrybush");

  const session = core.registerBrowserSession();
  core.receiveState("bot-rt", fixtureState());
  const transcript = await app.inject({
    method: "POST",
    url: "/api/realtime/events",
    payload: { sessionId: session.sessionId, companionId: "bot-rt", type: "transcript", text: "过来" },
  });
  assert.equal(transcript.statusCode, 200);
  assert.equal(transcript.json().action, "routed");
  assert.equal(transcript.json().route, "fast_intent");
  assert.equal(transcript.json().command.kind, "approach_or_retreat");
  assert.equal(core.pollCommands("bot-rt").commands[0]?.id, transcript.json().command.id);

  await app.close();
  store.close();
});

test("health snapshot exposes safe pending confirmation data for reconnect reconciliation", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  core.receiveState("bot-1", fixtureState());
  const confirmation = core.requestConfirmation("bot-1", "attack_nearby_threat", { targetGuid: 102 }, "确认攻击这只牛吗？");

  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().reasoningEffort, config.realtimeReasoningEffort);
  const companion = (health.json().companions as Array<{
    id?: string;
    confirmation?: { id?: string; prompt?: string; expiresAt?: number; kind?: string };
  }>).find((entry) => entry.id === "bot-1");
  assert.equal(companion?.confirmation?.id, confirmation.id);
  assert.equal(companion?.confirmation?.prompt, "确认攻击这只牛吗？");
  assert.equal(companion?.confirmation?.expiresAt, confirmation.expiresAt);
  assert.equal(companion?.confirmation?.kind, "attack_nearby_threat");
  assert.equal(JSON.stringify(health.json()).includes("private voice transcript"), false);

  await app.close();
  store.close();
});

test("HTTP results reject malformed payloads and complete the active command exactly once", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  await app.inject({ method: "POST", url: "/api/dst/v1/companions/bot-1/state", payload: fixtureState() });
  const queued = core.enqueue("bot-1", "follow_player", {}, "player");
  await app.inject({ method: "GET", url: "/api/dst/v1/companions/bot-1/commands" });

  const invalid = await app.inject({
    method: "POST",
    url: "/api/dst/v1/companions/bot-1/results",
    payload: { id: queued.id, status: "unknown", stateRevision: 1 },
  });
  assert.equal(invalid.statusCode, 400);

  const completed = await app.inject({
    method: "POST",
    url: "/api/dst/v1/companions/bot-1/results",
    payload: { id: queued.id, status: "succeeded", stateRevision: 1 },
  });
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(completed.json(), { accepted: true, duplicate: false });
  const duplicate = await app.inject({
    method: "POST",
    url: "/api/dst/v1/companions/bot-1/results",
    payload: { id: queued.id, status: "succeeded", stateRevision: 1 },
  });
  assert.deepEqual(duplicate.json(), { accepted: false, duplicate: true });
  await app.close();
  store.close();
});

test("HTTP results validate structured gather progress and terminal outcomes", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  await app.inject({ method: "POST", url: "/api/dst/v1/companions/bot-1/state", payload: fixtureState() });
  const command = core.enqueue("bot-1", "gather_nearby", { mode: "chop", targetGuid: 100 }, "player");
  await app.inject({ method: "GET", url: "/api/dst/v1/companions/bot-1/commands" });
  const outcome = {
    gather: {
      scope: "single",
      mode: "chop",
      targetPrefab: "evergreen",
      attempted: 1,
      completed: 0,
      remaining: 1,
      skipped: 0,
    },
  };

  const malformed = await app.inject({
    method: "POST",
    url: "/api/dst/v1/companions/bot-1/results",
    payload: {
      id: command.id,
      status: "progress",
      stateRevision: 2,
      outcome: { gather: { ...outcome.gather, completed: 2 } },
    },
  });
  assert.equal(malformed.statusCode, 400);

  const progress = await app.inject({
    method: "POST",
    url: "/api/dst/v1/companions/bot-1/results",
    payload: { id: command.id, status: "progress", stateRevision: 2, outcome },
  });
  assert.deepEqual(progress.json(), { accepted: true, duplicate: false });

  const invalidSuccess = await app.inject({
    method: "POST",
    url: "/api/dst/v1/companions/bot-1/results",
    payload: { id: command.id, status: "succeeded", stateRevision: 3, outcome },
  });
  assert.equal(invalidSuccess.statusCode, 400);

  const partial = await app.inject({
    method: "POST",
    url: "/api/dst/v1/companions/bot-1/results",
    payload: { id: command.id, status: "partial", stateRevision: 4, outcome },
  });
  assert.deepEqual(partial.json(), { accepted: true, duplicate: false });
  await app.close();
  store.close();
});

test("a Gateway without an API key returns a clear local session error without a secret", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  const response = await app.inject({ method: "POST", url: "/api/realtime/session" });
  assert.equal(response.statusCode, 400);
  assert.match(response.json().error, /OPENAI_API_KEY is missing/);
  assert.equal(response.body.includes("sk_"), false);
  assert.equal(response.body.includes("ek_"), false);
  await app.close();
  store.close();
});

test("Realtime session proxy returns sanitized OpenAI client-secret errors", async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({
      error: {
        message: `Invalid safety identifier dst-${"a".repeat(60)} from Bearer sk_test_server_key and ek_test_secret at https://user:pass@example.test`,
        code: "invalid_value",
        param: "OpenAI-Safety-Identifier",
      },
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const { store, core } = createCore();
  const app = createGatewayApp({ ...config, apiKey: "sk_test_server_key" }, core);
  const response = await app.inject({ method: "POST", url: "/api/realtime/session" });
  const body = response.json() as { error?: string };
  assert.equal(response.statusCode, 400);
  assert.match(body.error ?? "", /OpenAI Realtime client-secret request failed \(400\):/);
  assert.match(body.error ?? "", /invalid_value/);
  assert.match(body.error ?? "", /param=OpenAI-Safety-Identifier/);
  assert.equal(JSON.stringify(body).includes("sk_test_server_key"), false);
  assert.equal(JSON.stringify(body).includes("ek_test_secret"), false);
  assert.equal(JSON.stringify(body).includes("dst-" + "a".repeat(60)), false);
  assert.equal(JSON.stringify(body).includes("user:pass"), false);
  await app.close();
  store.close();
});

test("sourced knowledge keeps its pinned MIT attribution and stays out of raw player memory", async () => {
  const store = new GatewayStore(":memory:");
  const hits = store.searchKnowledge("winter survival combat", 1);
  assert.equal(hits.length, 1);
  assert.match(hits[0]!.source, /^morandot\/dont-starve-skill@12dc27d3b6d0a261f0fbd14a046d492cba8c6e27:/);
  assert.match(hits[0]!.source, /MIT; Copyright \(c\) 2026 moran/);
  assert.match(hits[0]!.excerpt, /survival|combat|winter/i);

  const core = new GatewayCore(store);
  core.receiveState("bot-1", fixtureState());
  core.receivePlayerInput("bot-1", { text: "private voice transcript", source: "voice" });
  const state = await core.handleRealtimeTool("bot-1", "get_game_state", {});
  assert.equal(JSON.stringify(state).includes("private voice transcript"), false);
  store.close();
});

test("command lifecycle persists only structured goal and outcome summaries", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const command = core.enqueue("bot-1", "follow_player", {}, "player");
  assert.equal(store.getCompanionMemory("bot-1", "current_goal"), JSON.stringify({
    kind: "follow_player",
    state: "queued",
    epoch: command.epoch,
  }));
  core.pollCommands("bot-1");
  assert.equal(store.getCompanionMemory("bot-1", "current_goal"), JSON.stringify({
    kind: "follow_player",
    state: "active",
    epoch: command.epoch,
  }));
  core.receiveResult("bot-1", { id: command.id, status: "succeeded", stateRevision: 1 });
  assert.equal(store.getCompanionMemory("bot-1", "current_goal"), JSON.stringify({ state: "idle" }));
  assert.equal(store.getCompanionMemory("bot-1", "task_summary"), JSON.stringify({
    kind: "follow_player",
    status: "succeeded",
  }));
  store.close();
});

test("interrupts mark active and queued commands as cancelled terminal lifecycles", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const active = core.enqueue("bot-1", "gather_nearby", { mode: "chop", targetGuid: 100 }, "player");
  assert.equal(core.pollCommands("bot-1").commands[0]?.id, active.id);
  const queued = core.enqueue("bot-1", "follow_player", {}, "player");
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  core.subscribe((event) => events.push(event));

  const interrupt = core.interrupt("bot-1", "voice_vad");
  assert.equal(interrupt.kind, "clear_action_queue");
  assert.equal(core.commandStatus("bot-1", active.id)?.status, "cancelled");
  assert.equal(core.commandStatus("bot-1", queued.id)?.status, "cancelled");
  assert.equal(core.commandStatus("bot-1", active.id)?.terminal, true);
  const cancelledIds = events
    .filter((event) => event.type === "command-result")
    .map((event) => event.data.result as { id?: string; status?: string; reason?: string })
    .filter((result) => result.status === "cancelled" && result.reason === "voice_vad")
    .map((result) => result.id);
  assert.equal(cancelledIds.length, 2);
  assert.equal(cancelledIds.includes(active.id), true);
  assert.equal(cancelledIds.includes(queued.id), true);

  assert.deepEqual(core.receiveResult("bot-1", { id: active.id, status: "succeeded", stateRevision: 1 }), { accepted: false, duplicate: true });
  assert.equal(core.commandStatus("bot-1", active.id)?.status, "cancelled");
  store.close();
});

test("Realtime action tools return a pending lifecycle immediately", async () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());

  const { output } = await core.handleRealtimeTool("bot-1", "follow_player", {}, "call-follow-pending");
  const typedOutput = output as {
    commandId?: string;
    status?: string;
    terminal?: boolean;
    pending?: boolean;
    feedback?: { policy?: string; channel?: string };
  };
  assert.equal(typedOutput.status, "queued");
  assert.equal(typedOutput.terminal, false);
  assert.equal(typedOutput.pending, true);
  assert.equal(typeof typedOutput.commandId, "string");
  assert.notEqual(typedOutput.commandId?.trim(), "");
  assert.deepEqual(typedOutput.feedback, {
    policy: "silent_success",
    channel: "voice_only_preamble",
  });

  const command = core.pollCommands("bot-1").commands[0]!;
  assert.equal(command.kind, "follow_player");
  assert.equal(typedOutput.commandId, command.id);
  assert.deepEqual(core.receiveResult("bot-1", { id: command.id, status: "started", stateRevision: 1 }), { accepted: true, duplicate: false });
  assert.deepEqual(core.receiveResult("bot-1", { id: command.id, status: "succeeded", stateRevision: 2 }), { accepted: true, duplicate: false });

  store.close();
});

test("Realtime feedback policies distinguish gather issues and confirmed high-risk results", async () => {
  const { store, core } = createCore();
  core.receiveState("bot-gather", fixtureState());
  const gather = await core.handleRealtimeTool("bot-gather", "gather_nearby", { mode: "chop", targetGuid: 100 }, "call-gather-feedback");
  const gatherOutput = gather.output as {
    commandId?: string;
    pending?: boolean;
    feedback?: { policy?: string; channel?: string };
  };
  assert.equal(gatherOutput.pending, true);
  assert.equal(typeof gatherOutput.commandId, "string");
  assert.notEqual(gatherOutput.commandId?.trim(), "");
  assert.deepEqual(gatherOutput.feedback, {
    policy: "issues_only",
    channel: "voice_only_preamble",
  });

  core.receiveState("bot-risk", fixtureState());
  const confirmation = core.requestConfirmation("bot-risk", "attack_nearby_threat", { targetGuid: 102 }, "attack?");
  const accepted = core.receivePlayerInput("bot-risk", { text: "yes", source: "game" });
  assert.equal(accepted.action, "confirmed");
  assert.equal(accepted.route, "confirmation");
  assert.equal(accepted.confirmation, confirmation.id);
  const confirmed = core.pollCommands("bot-risk").commands[0]!;
  assert.equal(confirmed.kind, "attack_nearby_threat");
  assert.deepEqual(core.commandStatus("bot-risk", confirmed.id)?.feedback, {
    policy: "always_result",
    channel: "voice_only_preamble",
  });
  store.close();
});

test("gather commands canonicalize fresh single and all-same-prefab targets", () => {
  withFakeNow(4_000_000, (clock) => {
    const { store, core } = createCore();
    core.receiveState("bot-1", {
      ...fixtureState(),
      Entities: [
        { GUID: 401, Prefab: "grass", Distance: 10, PlayerDistance: 9, Collectable: true },
        { GUID: 402, Prefab: "grass", Distance: 21, PlayerDistance: 12, Collectable: true },
        { GUID: 403, Prefab: "grass", Distance: 22, PlayerDistance: 13, Collectable: true },
      ],
    });

    const command = core.enqueue("bot-1", "gather_nearby", {
      scope: "all_same_prefab",
      mode: "collect",
      targetPrefab: "GRASS",
    }, "player");
    assert.deepEqual(command.args, {
      scope: "all_same_prefab",
      mode: "collect",
      targetGuid: 401,
      targetPrefab: "grass",
    });
    assert.equal(command.expiresAt, Date.now() + 60_000);
    assert.throws(() => core.enqueue("bot-1", "gather_nearby", {
      scope: "single",
      mode: "collect",
      targetGuid: 401,
      targetPrefab: "twigs",
    }, "player"), ValidationError);

    clock.advance(5_001);
    assert.throws(() => core.enqueue("bot-1", "gather_nearby", { mode: "collect", targetGuid: 401 }, "player"), ValidationError);
    store.close();
  });
});

test("normal movement successes do not enqueue completion speech", () => {
  const scenarios = [
    { companionId: "bot-follow", kind: "follow_player" as const, args: {} },
    { companionId: "bot-stop", kind: "stop_and_wait" as const, args: {} },
    { companionId: "bot-approach", kind: "approach_or_retreat" as const, args: { mode: "approach", targetGuid: 9 } },
  ];
  const { store, core } = createCore();
  for (const scenario of scenarios) {
    core.receiveState(scenario.companionId, fixtureState());
    const command = core.enqueue(scenario.companionId, scenario.kind, scenario.args, "player");
    assert.equal(core.pollCommands(scenario.companionId).commands[0]?.id, command.id);
    assert.deepEqual(core.receiveResult(scenario.companionId, {
      id: command.id,
      status: "succeeded",
      stateRevision: 2,
    }), { accepted: true, duplicate: false });
    assert.equal(core.pollCommands(scenario.companionId).commands.length, 0);
  }
  store.close();
});

test("gather progress retains the active command, validates outcomes, and emits trusted partial speech", async () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  core.subscribe((event) => events.push(event));
  const command = core.enqueue("bot-1", "gather_nearby", { mode: "chop", targetGuid: 100 }, "player");
  assert.equal(core.pollCommands("bot-1").commands[0]?.id, command.id);

  const progress = {
    gather: {
      scope: "single",
      mode: "chop",
      targetPrefab: "evergreen",
      attempted: 1,
      completed: 0,
      remaining: 1,
      skipped: 0,
    },
  } as const;
  assert.deepEqual(core.receiveResult("bot-1", {
    id: command.id,
    status: "progress",
    stateRevision: 2,
    outcome: progress,
  }), { accepted: true, duplicate: false });
  assert.equal(core.commandStatus("bot-1", command.id)?.status, "progress");
  assert.equal(core.commandStatus("bot-1", command.id)?.terminal, false);
  assert.deepEqual(core.commandStatus("bot-1", command.id)?.progress, progress.gather);
  assert.equal(core.pollCommands("bot-1").commands.length, 0);
  assert.deepEqual(events.find((event) => event.type === "command-progress")?.data.progress, progress.gather);

  const suppressedSpeech = await core.handleRealtimeTool("bot-1", "say_in_game", { text: "I am done." });
  assert.equal(suppressedSpeech.output.deferred, true);
  assert.throws(() => core.receiveResult("bot-1", {
    id: command.id,
    status: "succeeded",
    stateRevision: 3,
    outcome: progress,
  }), ValidationError);

  assert.deepEqual(core.receiveResult("bot-1", {
    id: command.id,
    status: "partial",
    stateRevision: 4,
    outcome: progress,
  }), { accepted: true, duplicate: false });
  assert.equal(core.commandStatus("bot-1", command.id)?.status, "partial");
  assert.equal(core.commandStatus("bot-1", command.id)?.terminal, true);
  const trustedSpeech = core.pollCommands("bot-1").commands[0]!;
  assert.equal(trustedSpeech.kind, "say_in_game");
  assert.deepEqual(trustedSpeech.args, { text: "附近 常青树：采集 0/1 棵，剩余 1，跳过 0。" });
  assert.equal(events.some((event) => event.type === "trusted-gather-message" && event.data.deferred === false), true);

  store.close();
});

test("single-target successful gather stays silent", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const command = core.enqueue("bot-1", "gather_nearby", { mode: "chop", targetGuid: 100 }, "player");
  core.pollCommands("bot-1");
  const outcome = {
    gather: {
      scope: "single",
      mode: "chop",
      targetPrefab: "evergreen",
      attempted: 1,
      completed: 1,
      remaining: 0,
      skipped: 0,
    },
  } as const;
  assert.deepEqual(core.receiveResult("bot-1", {
    id: command.id,
    status: "succeeded",
    stateRevision: 2,
    outcome,
  }), { accepted: true, duplicate: false });
  assert.equal(core.pollCommands("bot-1").commands.length, 0);
  store.close();
});

test("all-same-prefab successful gather reports one factual localized summary", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const command = core.enqueue("bot-1", "gather_nearby", {
    scope: "all_same_prefab",
    mode: "chop",
    targetGuid: 100,
  }, "player");
  core.pollCommands("bot-1");
  const outcome = {
    gather: {
      scope: "all_same_prefab",
      mode: "chop",
      targetPrefab: "evergreen",
      attempted: 3,
      completed: 3,
      remaining: 0,
      skipped: 0,
    },
  } as const;
  assert.deepEqual(core.receiveResult("bot-1", {
    id: command.id,
    status: "succeeded",
    stateRevision: 2,
    outcome,
  }), { accepted: true, duplicate: false });
  const trustedSpeech = core.pollCommands("bot-1").commands[0]!;
  assert.equal(trustedSpeech.kind, "say_in_game");
  assert.deepEqual(trustedSpeech.args, { text: "附近 常青树：已采集 3/3 棵。" });
  assert.deepEqual(core.receiveResult("bot-1", {
    id: trustedSpeech.id,
    status: "succeeded",
    stateRevision: 3,
  }), { accepted: true, duplicate: false });
  assert.equal(core.pollCommands("bot-1").commands.length, 0);
  store.close();
});

test("skipped gather targets are partial even when no targets remain, and never become a completion report", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const command = core.enqueue("bot-1", "gather_nearby", {
    scope: "all_same_prefab",
    mode: "chop",
    targetGuid: 100,
  }, "player");
  core.pollCommands("bot-1");
  const outcome = {
    gather: {
      scope: "all_same_prefab",
      mode: "chop",
      targetPrefab: "evergreen",
      attempted: 2,
      completed: 1,
      remaining: 0,
      skipped: 1,
    },
  } as const;

  assert.throws(() => core.receiveResult("bot-1", {
    id: command.id,
    status: "succeeded",
    stateRevision: 2,
    outcome,
  }), ValidationError);
  assert.deepEqual(core.receiveResult("bot-1", {
    id: command.id,
    status: "partial",
    stateRevision: 3,
    outcome,
  }), { accepted: true, duplicate: false });
  const trustedSpeech = core.pollCommands("bot-1").commands[0]!;
  assert.equal(trustedSpeech.kind, "say_in_game");
  assert.deepEqual(trustedSpeech.args, { text: "附近 常青树：采集 1/2 棵，剩余 0，跳过 1。" });
  assert.doesNotMatch(String(trustedSpeech.args.text), /完成/);
  store.close();
});

test("failed gather reports one honest localized issue", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const command = core.enqueue("bot-1", "gather_nearby", { mode: "chop", targetGuid: 100 }, "player");
  core.pollCommands("bot-1");
  assert.deepEqual(core.receiveResult("bot-1", {
    id: command.id,
    status: "failed",
    reason: "path blocked",
    stateRevision: 2,
  }), { accepted: true, duplicate: false });
  const trustedSpeech = core.pollCommands("bot-1").commands[0]!;
  assert.equal(trustedSpeech.kind, "say_in_game");
  assert.deepEqual(trustedSpeech.args, { text: "附近 常青树：未完成，原因：path blocked。" });
  assert.deepEqual(core.receiveResult("bot-1", {
    id: trustedSpeech.id,
    status: "succeeded",
    stateRevision: 3,
  }), { accepted: true, duplicate: false });
  assert.equal(core.pollCommands("bot-1").commands.length, 0);
  store.close();
});

test("a 40-target gather limit reports the unprocessed overflow as remaining work", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const command = core.enqueue("bot-1", "gather_nearby", {
    scope: "all_same_prefab",
    mode: "chop",
    targetGuid: 100,
  }, "player");
  core.pollCommands("bot-1");
  const outcome = {
    gather: {
      scope: "all_same_prefab",
      mode: "chop",
      targetPrefab: "evergreen",
      attempted: 41,
      completed: 40,
      remaining: 1,
      skipped: 0,
    },
  } as const;
  assert.deepEqual(core.receiveResult("bot-1", {
    id: command.id,
    status: "partial",
    stateRevision: 2,
    outcome,
  }), { accepted: true, duplicate: false });
  store.close();
});

test("only actions that require confirmation can create confirmation requests", () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  assert.throws(() => core.requestConfirmation("bot-1", "follow_player", {}, "follow?"), ValidationError);
  assert.throws(() => core.requestConfirmation("bot-1", "approach_or_retreat", { mode: "approach", targetGuid: 9 }, "approach?"), ValidationError);
  assert.throws(() => core.requestConfirmation("bot-1", "gather_nearby", { mode: "chop", targetGuid: 100 }, "gather?"), ValidationError);
  const confirmation = core.requestConfirmation("bot-1", "attack_nearby_threat", { targetGuid: 102 }, "attack?");
  assert.equal(confirmation.command.kind, "attack_nearby_threat");
  store.close();
});

test("Realtime intermediate acknowledgements are suppressed before they reach DST chat", async () => {
  const { store, core } = createCore();
  core.receiveState("bot-1", fixtureState());
  const preamble = await core.handleRealtimeTool("bot-1", "say_in_game", { text: "I already understand." });
  assert.equal(preamble.output.deferred, true);
  assert.equal(core.pollCommands("bot-1").commands.length, 0);

  const ordinaryReply = await core.handleRealtimeTool("bot-1", "say_in_game", { text: "我在这里。" });
  assert.equal(typeof ordinaryReply.command?.id, "string");
  store.close();
});

test("Realtime command status and wait endpoints expose terminal lifecycle snapshots", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  const session = core.registerBrowserSession();
  core.receiveState("bot-1", fixtureState());
  const command = core.enqueue("bot-1", "follow_player", {}, "player");

  const queued = await app.inject({
    method: "GET",
    url: `/api/realtime/commands/${encodeURIComponent(command.id)}/status?sessionId=${encodeURIComponent(session.sessionId)}&companionId=bot-1`,
  });
  assert.equal(queued.statusCode, 200);
  assert.equal(queued.json().command.status, "queued");

  const wait = app.inject({
    method: "GET",
    url: `/api/realtime/commands/${encodeURIComponent(command.id)}/wait?sessionId=${encodeURIComponent(session.sessionId)}&companionId=bot-1&timeoutMs=1000`,
  }).then((response) => response);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(core.pollCommands("bot-1").commands[0]?.id, command.id);
  core.receiveResult("bot-1", { id: command.id, status: "failed", reason: "target invalid", stateRevision: 3 });

  const completed = await wait;
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().command.status, "failed");
  assert.equal(completed.json().command.terminal, true);
  assert.equal(completed.json().command.result.reason, "target invalid");

  await app.close();
  store.close();
});

test("Realtime tool-call ids dedupe command enqueueing and invalid calls have no command side effect", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  const session = core.registerBrowserSession();
  core.receiveState("bot-1", fixtureState());
  const payload = {
    sessionId: session.sessionId,
    companionId: "bot-1",
    type: "tool-call",
    callId: "call-follow-1",
    name: "follow_player",
    arguments: {},
  };
  const first = await app.inject({ method: "POST", url: "/api/realtime/events", payload });
  const second = await app.inject({ method: "POST", url: "/api/realtime/events", payload });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(second.json(), first.json());

  const output = JSON.parse(first.json().output) as { commandId: string };
  const commands = core.pollCommands("bot-1").commands;
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.id, output.commandId);

  const invalid = await app.inject({
    method: "POST",
    url: "/api/realtime/events",
    payload: { ...payload, companionId: "bot-2", callId: undefined },
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(core.pollCommands("bot-2").commands.length, 0);
  await app.close();
  store.close();
});

test("malformed or rejected Realtime tool arguments return a call-scoped output without queueing work", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  const session = core.registerBrowserSession();

  const malformed = await app.inject({
    method: "POST",
    url: "/api/realtime/events",
    payload: {
      sessionId: session.sessionId,
      companionId: "bot-1",
      type: "tool-call",
      callId: "call-malformed-json",
      name: "follow_player",
      arguments: "{not-json}",
    },
  });
  assert.equal(malformed.statusCode, 200);
  assert.equal(malformed.json().callId, "call-malformed-json");
  const malformedOutput = JSON.parse(malformed.json().output) as {
    ok?: boolean;
    error?: { code?: string; message?: string };
  };
  assert.equal(malformedOutput.ok, false);
  assert.equal(malformedOutput.error?.code, "tool_validation_error");
  assert.match(malformedOutput.error?.message ?? "", /not valid JSON/);
  assert.equal(core.pollCommands("bot-1").commands.length, 0);

  const invalidShape = await app.inject({
    method: "POST",
    url: "/api/realtime/events",
    payload: {
      sessionId: session.sessionId,
      companionId: "bot-1",
      type: "tool-call",
      callId: "call-invalid-shape",
      name: "follow_player",
      arguments: [],
    },
  });
  assert.equal(invalidShape.statusCode, 200);
  assert.equal(invalidShape.json().callId, "call-invalid-shape");
  const invalidShapeOutput = JSON.parse(invalidShape.json().output) as {
    ok?: boolean;
    error?: { code?: string; message?: string };
  };
  assert.equal(invalidShapeOutput.ok, false);
  assert.equal(invalidShapeOutput.error?.code, "tool_validation_error");
  assert.match(invalidShapeOutput.error?.message ?? "", /JSON object/);
  assert.equal(core.pollCommands("bot-1").commands.length, 0);

  core.receiveState("bot-1", fixtureState());
  const rejectedByValidator = await app.inject({
    method: "POST",
    url: "/api/realtime/events",
    payload: {
      sessionId: session.sessionId,
      companionId: "bot-1",
      type: "tool-call",
      callId: "call-invalid-target",
      name: "gather_nearby",
      arguments: { mode: "collect", targetGuid: 100 },
    },
  });
  assert.equal(rejectedByValidator.statusCode, 200);
  assert.equal(rejectedByValidator.json().callId, "call-invalid-target");
  const rejectedOutput = JSON.parse(rejectedByValidator.json().output) as {
    ok?: boolean;
    error?: { code?: string; message?: string };
  };
  assert.equal(rejectedOutput.ok, false);
  assert.equal(rejectedOutput.error?.code, "tool_validation_error");
  assert.match(rejectedOutput.error?.message ?? "", /Gather target/);
  assert.equal(core.pollCommands("bot-1").commands.length, 0);

  await app.close();
  store.close();
});

test("Realtime nonordinary food tool call requires confirmation without trusting rare flag", async () => {
  const { store, core } = createCore();
  const app = createGatewayApp(config, core);
  const session = core.registerBrowserSession();
  core.receiveState("bot-1", {
    ...fixtureState(),
    Inventory: [{ Prefab: "deerclops_eyeball", Quantity: 1, GUID: 301 }],
  });
  const response = await app.inject({
    method: "POST",
    url: "/api/realtime/events",
    payload: {
      sessionId: session.sessionId,
      companionId: "bot-1",
      type: "tool-call",
      callId: "call-eat-eyeball",
      name: "equip_or_eat",
      arguments: { action: "eat", itemName: "deerclops_eyeball", rare: false },
    },
  });
  assert.equal(response.statusCode, 200);
  const output = JSON.parse(response.json().output) as { status?: string; confirmationId?: string };
  assert.equal(output.status, "awaiting_player");
  assert.equal(typeof output.confirmationId, "string");
  assert.equal(core.pollCommands("bot-1").commands.length, 0);
	await app.close();
	store.close();
});

test("Realtime nonordinary give requests confirmation and ordinary items remain available", async () => {
	const { store, core } = createCore();
	const app = createGatewayApp(config, core);
	const session = core.registerBrowserSession();
	core.receiveState("bot-1", {
		...fixtureState(),
		Inventory: [
			{ Prefab: "deerclops_eyeball", Quantity: 1, GUID: 301 },
			{ Prefab: "cutgrass", Quantity: 5, GUID: 302 },
		],
	});
	const rare = await app.inject({
		method: "POST",
		url: "/api/realtime/events",
		payload: {
			sessionId: session.sessionId,
			companionId: "bot-1",
			type: "tool-call",
			callId: "call-give-eyeball",
			name: "give_item",
			arguments: { itemName: "deerclops_eyeball", quantity: 1 },
		},
	});
	assert.equal(rare.statusCode, 200);
	assert.equal((JSON.parse(rare.json().output) as { status?: string }).status, "awaiting_player");

	const ordinary = await app.inject({
		method: "POST",
		url: "/api/realtime/events",
		payload: {
			sessionId: session.sessionId,
			companionId: "bot-1",
			type: "tool-call",
			callId: "call-give-grass",
			name: "give_item",
			arguments: { itemName: "cutgrass", quantity: 5 },
		},
	});
	assert.equal(ordinary.statusCode, 200);
	assert.equal(typeof (JSON.parse(ordinary.json().output) as { commandId?: string }).commandId, "string");
	await app.close();
	store.close();
});

test("raw assistant transcripts cannot enqueue in-game speech", async () => {
	const { store, core } = createCore();
	const app = createGatewayApp(config, core);
	const session = core.registerBrowserSession();

	const response = await app.inject({
		method: "POST",
		url: "/api/realtime/events",
		payload: {
			sessionId: session.sessionId,
			companionId: "bot-1",
			type: "assistant-transcript",
			text: "我去处理一下。",
		},
	});

	assert.equal(response.statusCode, 400);
	assert.equal(core.pollCommands("bot-1").commands.length, 0);
	await app.close();
	store.close();
});

test("Realtime client-secret proxy uses the server key without returning it", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ value: "ek_test_secret", expires_at: 123 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const secret = await createRealtimeClientSecret({ ...config, apiKey: "sk_test_server_key" });
  assert.deepEqual(secret, { clientSecret: "ek_test_secret", expiresAt: 123_000, model: config.realtimeModel });
  assert.equal(JSON.stringify(secret).includes("sk_test_server_key"), false);
  assert.equal(requests[0]?.url, "https://api.openai.com/v1/realtime/client_secrets");
  const headers = new Headers(requests[0]?.init?.headers);
  assert.equal(headers.get("Authorization"), "Bearer sk_test_server_key");
  const requestBody = JSON.parse(String(requests[0]?.init?.body ?? "{}")) as {
    expires_after?: { anchor?: string; seconds?: number };
    session?: {
      type?: string;
      model?: string;
      reasoning?: { effort?: string };
      output_modalities?: string[];
      audio?: {
        input?: {
          transcription?: { model?: string; language?: string };
          turn_detection?: { type?: string; eagerness?: string; create_response?: boolean; interrupt_response?: boolean };
        };
        output?: { voice?: string };
      };
    };
  };
  assert.deepEqual(requestBody.expires_after, { anchor: "created_at", seconds: 600 });
  assert.equal(requestBody.session?.type, "realtime");
  assert.equal(requestBody.session?.model, config.realtimeModel);
  assert.equal(requestBody.session?.reasoning?.effort, "medium");
  assert.deepEqual(requestBody.session?.output_modalities, ["audio"]);
  assert.deepEqual(requestBody.session?.audio?.input?.transcription, {
    model: "gpt-4o-mini-transcribe",
    language: "zh",
  });
  assert.equal(requestBody.session?.audio?.input?.turn_detection?.type, "semantic_vad");
  assert.equal(requestBody.session?.audio?.input?.turn_detection?.eagerness, "high");
  assert.equal(requestBody.session?.audio?.input?.turn_detection?.create_response, false);
  assert.equal(requestBody.session?.audio?.input?.turn_detection?.interrupt_response, false);
  assert.equal(requestBody.session?.audio?.output?.voice, config.realtimeVoice);
});

test("Realtime session proxy sends a stable hashed safety identifier without leaking raw userid", async (t) => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), init });
    return new Response(JSON.stringify({ value: "ek_test_secret", expires_at: 123 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const rawUserId = "KU_raw_player_userid";
  const { store, core } = createCore();
  core.receiveState("default", { ...fixtureState(), UserID: rawUserId });
  const app = createGatewayApp({ ...config, apiKey: "sk_test_server_key" }, core);

  const first = await app.inject({ method: "POST", url: "/api/realtime/session" });
  const second = await app.inject({ method: "POST", url: "/api/realtime/session" });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  const firstSafetyIdentifier = new Headers(requests[0]?.init?.headers).get("OpenAI-Safety-Identifier");
  const secondSafetyIdentifier = new Headers(requests[1]?.init?.headers).get("OpenAI-Safety-Identifier");
  assert.match(firstSafetyIdentifier ?? "", /^dst-[a-f0-9]{60}$/);
  assert.equal(firstSafetyIdentifier?.length, 64);
  assert.equal(secondSafetyIdentifier, firstSafetyIdentifier);
  assert.equal(JSON.stringify(requests).includes(rawUserId), false);
  assert.equal(JSON.stringify(first.json()).includes(rawUserId), false);

  await app.close();
  store.close();
});

test("Airi HTTP tools expose fresh state and preserve call idempotency", async () => {
  const { store, core } = createCore();
  core.setControllerMode("airi");
  core.setControllerState(true, true);
  core.receiveState("bot-1", fixtureState());
  const app = createGatewayApp(config, core, () => ({
    airiConfigured: true,
    airiConnected: true,
    airiAuthenticated: true,
  }));

  const state = await app.inject({ method: "GET", url: "/api/airi/v1/companions/bot-1/state" });
  assert.equal(state.statusCode, 200);
  assert.equal(state.json().stateFresh, true);

  const first = await app.inject({
    method: "POST",
    url: "/api/airi/v1/companions/bot-1/tools/dst_follow",
    payload: { callId: "airi-follow-1", args: {} },
  });
  const duplicate = await app.inject({
    method: "POST",
    url: "/api/airi/v1/companions/bot-1/tools/dst_follow",
    payload: { callId: "airi-follow-1", args: {} },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(first.json().commandId, duplicate.json().commandId);
  assert.equal(core.pollCommands("bot-1").commands.length, 1);

  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(health.json().controllerMode, "airi");
  assert.equal(health.json().airiAuthenticated, true);

  await app.close();
  store.close();
});

test("Airi disconnect fails closed and cancels queued gameplay", async () => {
  const { store, core } = createCore();
  core.setControllerMode("airi");
  core.setControllerState(true, true);
  core.receiveState("bot-1", fixtureState());
  const result = await core.handleAiriTool("bot-1", "follow_player", {}, "disconnect-follow");
  assert.equal(typeof result.command?.id, "string");
  const epochBefore = core.getEpoch("bot-1");

  core.setControllerState(false, false);
  assert.equal(core.getEpoch("bot-1") > epochBefore, true);
  const snapshot = core.companionSnapshot("bot-1");
  assert.equal(snapshot.controllerConnected, false);
  await assert.rejects(
    core.handleAiriTool("bot-1", "follow_player", {}, "offline-follow"),
    /offline/,
  );
  store.close();
});
