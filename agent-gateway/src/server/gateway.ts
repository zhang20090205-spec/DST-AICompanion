import { createHash, randomUUID } from "node:crypto";
import type {
  Command,
  CommandKind,
  CommandPriority,
  CommandResult,
  CompanionState,
  PendingConfirmation,
  PlayerInput,
} from "../shared/types.js";
import { GatewayStore } from "./database.js";
import {
  ValidationError,
  boundedExpiry,
  isCommandKind,
  isLikelyHostile,
  normalizeState,
  sanitizeChat,
  targetFromState,
  validateCommandArgs,
} from "./validation.js";

export interface GatewayEvent {
  type: string;
  companionId?: string;
  data: Record<string, unknown>;
}

interface CommandRecord {
  command: Command;
  queuedAt: number;
  started?: boolean;
}

interface CompanionContext {
  id: string;
  epoch: number;
  state?: CompanionState;
  queue: CommandRecord[];
  active?: CommandRecord;
  confirmation?: PendingConfirmation;
  voiceConnected: boolean;
  voiceSpeaking: boolean;
  voiceOfflineStandby: boolean;
  lastVoiceActivity: number;
  lastAutonomyAt: number;
  lastAssistantSpeech?: { text: string; sentAt: number };
}

interface BrowserSession {
  expiresAt: number;
  lastSeenAt: number;
}

interface RealtimeToolRecord {
  name: string;
  argsFingerprint: string;
  output: Record<string, unknown>;
  command?: Command;
  expiresAt: number;
}

const PRIORITY_WEIGHT: Record<CommandPriority, number> = {
  interrupt: 3,
  player: 2,
  autonomy: 1,
};

const TOOL_CALL_CACHE_TTL_MS = 60_000;
const ORDINARY_FOOD_PREFABS = new Set([
  "berries",
  "berries_cooked",
  "berries_juicy",
  "berries_juicy_cooked",
  "carrot",
  "carrot_cooked",
  "corn",
  "corn_cooked",
  "eggplant",
  "eggplant_cooked",
  "meatballs",
  "pumpkin",
  "pumpkin_cooked",
  "ratatouille",
  "seeds",
  "seeds_cooked",
  "smallmeat",
  "cookedsmallmeat",
  "trailmix",
]);

const ORDINARY_TRANSFER_PREFABS = new Set([
  "cutgrass",
  "twigs",
  "log",
  "rocks",
  "flint",
  "seeds",
  "seeds_cooked",
  "berries",
  "berries_cooked",
  "berries_juicy",
  "berries_juicy_cooked",
  "carrot",
  "carrot_cooked",
  "corn",
  "corn_cooked",
  "smallmeat",
  "cookedsmallmeat",
]);

const ASSISTANT_SPEECH_RATE_LIMIT_MS = 750;
const ASSISTANT_SPEECH_DUPLICATE_WINDOW_MS = 10_000;

const REALTIME_TOOLS = new Set([
  "get_game_state",
  "search_dst_knowledge",
  "say_in_game",
  "follow_player",
  "stop_and_wait",
  "approach_or_retreat",
  "gather_nearby",
  "attack_nearby_threat",
  "equip_or_eat",
  "give_item",
  "request_confirmation",
  "clear_action_queue",
]);

export class GatewayCore {
  private readonly companions = new Map<string, CompanionContext>();
  private readonly browserSessions = new Map<string, BrowserSession>();
  private readonly listeners = new Set<(event: GatewayEvent) => void>();
  private readonly seenInputIds = new Map<string, number>();
  private readonly realtimeToolResults = new Map<string, RealtimeToolRecord>();

  constructor(readonly store: GatewayStore) {}

  subscribe(listener: (event: GatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: GatewayEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  registerBrowserSession(): { sessionId: string; expiresAt: number } {
    const sessionId = randomUUID();
    const expiresAt = Date.now() + 10 * 60_000;
    this.browserSessions.set(sessionId, { expiresAt, lastSeenAt: Date.now() });
    return { sessionId, expiresAt };
  }

  assertBrowserSession(sessionId: unknown): void {
    if (typeof sessionId !== "string") {
      throw new ValidationError("A local browser session is required.");
    }
    const session = this.browserSessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      this.browserSessions.delete(sessionId);
      throw new ValidationError("The local browser session expired. Reconnect the voice page.");
    }
    session.lastSeenAt = Date.now();
  }

  receiveState(companionId: string, rawState: unknown): CompanionState {
    const context = this.context(companionId);
    const revision = (context.state?.revision ?? 0) + 1;
    context.state = normalizeState(rawState, revision);
    this.expire(context);
    this.publish({
      type: "game-state",
      companionId,
      data: { state: this.publicState(context.state), epoch: context.epoch },
    });
    return context.state;
  }

  getEpoch(companionId: string): number {
    return this.context(companionId).epoch;
  }

  openAISafetyIdentifier(companionId = "default"): string | undefined {
    const userid = this.context(companionId).state?.player.userid;
    if (!userid) {
      return undefined;
    }
    // OpenAI caps OpenAI-Safety-Identifier at 64 characters.
    const digest = createHash("sha256")
      .update("dst-ai-companion:openai-safety-identifier\0")
      .update(userid)
      .digest("hex")
      .slice(0, 60);
    return `dst-${digest}`;
  }

  pollCommands(companionId: string): { epoch: number; commands: Command[] } {
    const context = this.context(companionId);
    this.expire(context);
    if (context.active) {
      return { epoch: context.epoch, commands: [] };
    }
    context.queue.sort((left, right) =>
      PRIORITY_WEIGHT[right.command.priority] - PRIORITY_WEIGHT[left.command.priority] || left.queuedAt - right.queuedAt,
    );
    const next = context.queue.shift();
    if (!next) {
      return { epoch: context.epoch, commands: [] };
    }
    context.active = next;
    this.store.addAudit(companionId, "command_dispatched", {
      id: next.command.id,
      kind: next.command.kind,
      priority: next.command.priority,
      epoch: next.command.epoch,
    });
    this.store.setCompanionMemory(companionId, "current_goal", JSON.stringify({
      kind: next.command.kind,
      state: "active",
      epoch: next.command.epoch,
    }));
    this.publish({ type: "command", companionId, data: { command: next.command } });
    return { epoch: context.epoch, commands: [next.command] };
  }

  receiveResult(companionId: string, result: CommandResult): { accepted: boolean; duplicate: boolean } {
    const context = this.context(companionId);
    this.expire(context);
    const active = context.active;
    if (!active || active.command.id !== result.id) {
      return { accepted: false, duplicate: true };
    }
    if (result.status === "started") {
      if (active.started) {
        return { accepted: true, duplicate: true };
      }
      active.started = true;
    }
    this.store.addAudit(companionId, `command_${result.status}`, {
      id: result.id,
      kind: active.command.kind,
      reason: result.reason,
      stateRevision: result.stateRevision,
    });
    if (result.status !== "started") {
      context.active = undefined;
      this.store.setCompanionMemory(companionId, "current_goal", JSON.stringify({ state: "idle" }));
      this.store.setCompanionMemory(companionId, "task_summary", JSON.stringify({
        kind: active.command.kind,
        status: result.status,
      }));
      this.publish({
        type: "command-result",
        companionId,
        data: { result, kind: active.command.kind },
      });
    }
    return { accepted: true, duplicate: false };
  }

  receivePlayerInput(companionId: string, input: PlayerInput): { action: string; confirmation?: string } {
    const normalized = sanitizeChat(input.text);
    const dedupeId = input.id?.slice(0, 128);
    if (dedupeId && this.seenInputIds.get(dedupeId) && Date.now() - (this.seenInputIds.get(dedupeId) ?? 0) < 60_000) {
      return { action: "duplicate" };
    }
    if (dedupeId) {
      this.seenInputIds.set(dedupeId, Date.now());
    }
    const context = this.context(companionId);
    const lower = normalized.toLowerCase();
    if (lower === "stop" || lower === "停止" || lower === "停下" || lower === "别动") {
      this.interrupt(companionId, "player_stop");
      this.publish({ type: "player-input", companionId, data: { text: normalized, source: input.source, action: "interrupted" } });
      return { action: "interrupted" };
    }
    if ((lower === "yes" || lower === "是" || lower === "确认") && context.confirmation) {
      const confirmation = context.confirmation;
      context.confirmation = undefined;
      const command = this.enqueue(companionId, confirmation.command.kind, confirmation.command.args, "player", true);
      this.store.setCompanionMemory(companionId, `preference.${confirmation.command.kind}`, "approved");
      this.publish({ type: "confirmation", companionId, data: { id: confirmation.id, accepted: true, command } });
      return { action: "confirmed", confirmation: confirmation.id };
    }
    if ((lower === "no" || lower === "否" || lower === "取消") && context.confirmation) {
      const confirmation = context.confirmation;
      context.confirmation = undefined;
      this.store.setCompanionMemory(companionId, `preference.${confirmation.command.kind}`, "declined");
      this.store.addAudit(companionId, "confirmation_rejected", { id: confirmation.id });
      this.publish({ type: "confirmation", companionId, data: { id: confirmation.id, accepted: false } });
      return { action: "rejected", confirmation: confirmation.id };
    }
    // Transcript text is intentionally only sent to live SSE subscribers, never persisted.
    this.publish({ type: "player-input", companionId, data: { text: normalized, source: input.source, userid: input.userid ?? null } });
    return { action: "forwarded" };
  }

  receiveAssistantTranscript(companionId: string, rawText: unknown): { accepted: boolean; duplicate: boolean; command?: Command } {
    const text = sanitizeChat(rawText);
    const context = this.context(companionId);
    const command = this.enqueueAssistantSpeech(context, text);
    this.publish({ type: "assistant-transcript", companionId, data: { text } });
    return { accepted: true, duplicate: command === undefined, ...(command ? { command } : {}) };
  }

  setVoiceState(companionId: string, active: boolean): void {
    const context = this.context(companionId);
    context.voiceSpeaking = false;
    if (active) {
      context.voiceConnected = true;
      context.voiceOfflineStandby = false;
      context.lastVoiceActivity = Date.now();
      this.publishVoiceState(context);
      return;
    }

    const shouldInterrupt = context.voiceConnected || !context.voiceOfflineStandby;
    context.voiceConnected = false;
    context.voiceOfflineStandby = true;
    context.lastVoiceActivity = Date.now();
    this.publishVoiceState(context);
    if (shouldInterrupt) {
      this.interrupt(companionId, "voice_connection_closed");
    }
  }

  setVoiceSpeaking(companionId: string, active: boolean): void {
    const context = this.context(companionId);
    if (!context.voiceConnected || context.voiceOfflineStandby) {
      if (active) {
        throw new ValidationError("Voice session is offline.");
      }
      return;
    }
    context.voiceSpeaking = active;
    context.lastVoiceActivity = Date.now();
    this.publishVoiceState(context);
  }

  private publishVoiceState(context: CompanionContext): void {
    this.publish({
      type: "voice-state",
      companionId: context.id,
      data: { active: context.voiceSpeaking, connected: context.voiceConnected, offlineStandby: context.voiceOfflineStandby },
    });
  }

  interrupt(companionId: string, reason: string): Command {
    const context = this.context(companionId);
    context.epoch += 1;
    context.queue = [];
    context.active = undefined;
    context.confirmation = undefined;
    const command: Command = {
      id: randomUUID(),
      epoch: context.epoch,
      priority: "interrupt",
      kind: "clear_action_queue",
      args: { reason: reason.slice(0, 80) },
      expiresAt: boundedExpiry(Date.now(), 5_000, "clear_action_queue"),
    };
    context.queue.push({ command, queuedAt: Date.now() });
    this.store.addAudit(companionId, "interrupted", { reason, epoch: context.epoch });
    this.publish({ type: "interrupt", companionId, data: { reason, epoch: context.epoch } });
    return command;
  }

  enqueue(companionId: string, kind: CommandKind, rawArgs: unknown, priority: CommandPriority, confirmed = false): Command {
    const context = this.context(companionId);
    const args = validateCommandArgs(kind, rawArgs, context.state);
    if (kind === "clear_action_queue") {
      return this.interrupt(companionId, "tool_clear_action_queue");
    }
    if (!confirmed && this.requiresConfirmation(kind, args, context.state)) {
      throw new ValidationError("This action requires player confirmation.");
    }

    if (priority === "player") {
      context.queue = context.queue.filter((record) => record.command.priority !== "autonomy");
    }
    const activeWeight = context.active ? PRIORITY_WEIGHT[context.active.command.priority] : 0;
    if (priority === "player" && activeWeight < PRIORITY_WEIGHT.player && context.active) {
      this.interrupt(companionId, "player_override");
    }
    const current = this.context(companionId);
    const commandArgs = confirmed ? { ...args, confirmed: true } : args;
    const command: Command = {
      id: randomUUID(),
      epoch: current.epoch,
      priority,
      kind,
      args: commandArgs,
      expiresAt: boundedExpiry(Date.now(), undefined, kind),
    };
    current.queue.push({ command, queuedAt: Date.now() });
    this.store.setCompanionMemory(companionId, "current_goal", JSON.stringify({
      kind: command.kind,
      state: "queued",
      epoch: command.epoch,
    }));
    this.store.addAudit(companionId, "command_queued", { id: command.id, kind, priority, epoch: command.epoch });
    return command;
  }

  requestConfirmation(companionId: string, kind: CommandKind, rawArgs: unknown, prompt: unknown): PendingConfirmation {
    const context = this.context(companionId);
    if (kind === "clear_action_queue" || kind === "stop_and_wait") {
      throw new ValidationError("This action does not need confirmation.");
    }
    const args = validateCommandArgs(kind, rawArgs, context.state);
    const now = Date.now();
    const confirmation: PendingConfirmation = {
      id: randomUUID(),
      companionId,
      requestedAt: now,
      expiresAt: now + 20_000,
      prompt: sanitizeChat(prompt),
      command: { kind, args, priority: "player" },
    };
    context.confirmation = confirmation;
    this.store.addAudit(companionId, "confirmation_requested", { id: confirmation.id, kind });
    this.publish({ type: "confirmation", companionId, data: { ...confirmation, command: { kind, args } } });
    return confirmation;
  }

  handleRealtimeTool(
    companionId: string,
    name: unknown,
    rawArgs: unknown,
    idempotenceKey?: string,
  ): { output: Record<string, unknown>; command?: Command } {
    if (typeof name !== "string" || !REALTIME_TOOLS.has(name)) {
      throw new ValidationError("Realtime attempted an unapproved tool.");
    }
    this.expireRealtimeToolResults();
    const cacheKey = this.realtimeToolCacheKey(companionId, idempotenceKey);
    const argsFingerprint = JSON.stringify(rawArgs) ?? "undefined";
    const cached = cacheKey ? this.realtimeToolResults.get(cacheKey) : undefined;
    if (cached) {
      if (cached.name !== name || cached.argsFingerprint !== argsFingerprint) {
        throw new ValidationError("Realtime tool call id was reused with different arguments.");
      }
      return { output: cached.output, command: cached.command };
    }

    const result = this.runRealtimeTool(companionId, name, rawArgs);
    if (cacheKey) {
      this.realtimeToolResults.set(cacheKey, {
        name,
        argsFingerprint,
        output: result.output,
        command: result.command,
        expiresAt: Date.now() + TOOL_CALL_CACHE_TTL_MS,
      });
    }
    return result;
  }

  private runRealtimeTool(
    companionId: string,
    name: string,
    rawArgs: unknown,
  ): { output: Record<string, unknown>; command?: Command } {
    const context = this.context(companionId);
    if (name === "get_game_state") {
      return {
        output: {
          state: context.state ? this.publicState(context.state) : null,
          epoch: context.epoch,
          memory: {
            currentGoal: this.store.getCompanionMemory(companionId, "current_goal") ?? null,
            taskSummary: this.store.getCompanionMemory(companionId, "task_summary") ?? null,
          },
        },
      };
    }
    if (name === "search_dst_knowledge") {
      const query = rawArgs && typeof rawArgs === "object" ? (rawArgs as Record<string, unknown>).query : "";
      return { output: { results: this.store.searchKnowledge(typeof query === "string" ? query : "") } };
    }
    if (name === "request_confirmation") {
      const args = rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {};
      if (!isCommandKind(args.kind)) {
        throw new ValidationError("Confirmation requires an approved command kind.");
      }
      const confirmation = this.requestConfirmation(companionId, args.kind, args.args, args.prompt);
      return { output: { confirmationId: confirmation.id, status: "awaiting_player", expiresAt: confirmation.expiresAt } };
    }

    const mapping: Record<string, CommandKind> = {
      say_in_game: "say_in_game",
      follow_player: "follow_player",
      stop_and_wait: "stop_and_wait",
      approach_or_retreat: "approach_or_retreat",
      gather_nearby: "gather_nearby",
      attack_nearby_threat: "attack_nearby_threat",
      equip_or_eat: "equip_or_eat",
      give_item: "give_item",
      clear_action_queue: "clear_action_queue",
    };
    const kind = mapping[name];
    if (!kind) {
      throw new ValidationError("Tool has no command mapping.");
    }

    const args = rawArgs && typeof rawArgs === "object" ? rawArgs as Record<string, unknown> : {};
    if (this.requiresConfirmation(kind, args, context.state)) {
      const confirmation = this.requestConfirmation(companionId, kind, args, `确认让伙伴执行 ${kind} 吗？`);
      return { output: { status: "awaiting_player", confirmationId: confirmation.id, expiresAt: confirmation.expiresAt } };
    }
    if (kind === "stop_and_wait") {
      this.interrupt(companionId, "tool_stop_and_wait");
    }
    if (kind === "say_in_game") {
      const command = this.enqueueAssistantSpeech(context, sanitizeChat(args.text));
      if (!command) {
        return { output: { accepted: true, duplicate: true } };
      }
      return { output: { accepted: true, commandId: command.id, epoch: command.epoch }, command };
    }
    const command = this.enqueue(companionId, kind, args, "player");
    return { output: { accepted: true, commandId: command.id, epoch: command.epoch }, command };
  }

  runAutonomy(now = Date.now()): void {
    for (const context of this.companions.values()) {
      this.expire(context, now);
      const state = context.state;
      if (
        !state ||
        now - state.receivedAt > 5_000 ||
        !context.voiceConnected ||
        context.voiceOfflineStandby ||
        context.voiceSpeaking ||
        context.confirmation ||
        context.active ||
        context.queue.length > 0 ||
        now - context.lastAutonomyAt < 5_000
      ) {
        continue;
      }
      context.lastAutonomyAt = now;
      let command: Command | undefined;
      if (state.hunger !== null && state.hunger < 35) {
        const food = state.inventory.find((item) => isOrdinaryFoodName(item.prefab));
        if (food) {
          command = this.enqueue(context.id, "equip_or_eat", { action: "eat", itemName: food.prefab }, "autonomy");
        }
      } else if (state.isNearDanger) {
        const target = state.nearby.find((entity) => entity.distance <= 12 && entity.attackable && isLikelyHostile(entity));
        if (target) {
          command = this.enqueue(context.id, "attack_nearby_threat", { targetGuid: target.guid }, "autonomy");
        }
      }
      if (command) {
        this.publish({ type: "autonomy", companionId: context.id, data: { command, silent: true } });
      }
    }
  }

  watchdog(now = Date.now()): void {
    for (const context of this.companions.values()) {
      this.expire(context, now);
      if (context.voiceConnected && now - context.lastVoiceActivity > 15_000) {
        context.voiceConnected = false;
        context.voiceSpeaking = false;
        context.voiceOfflineStandby = true;
        this.interrupt(context.id, "voice_connection_lost");
      }
    }
    for (const [id, seenAt] of this.seenInputIds) {
      if (now - seenAt > 60_000) {
        this.seenInputIds.delete(id);
      }
    }
    this.expireRealtimeToolResults(now);
  }

  status(): Record<string, unknown> {
    return {
      companions: [...this.companions.values()].map((context) => ({
        id: context.id,
        epoch: context.epoch,
        connected: Boolean(context.state && Date.now() - context.state.receivedAt < 5_000),
        voiceActive: context.voiceSpeaking,
        voiceConnected: context.voiceConnected,
        voiceOfflineStandby: context.voiceOfflineStandby,
        confirmation: context.confirmation ? { id: context.confirmation.id, expiresAt: context.confirmation.expiresAt } : null,
      })),
      audit: this.store.recentAudit(12),
    };
  }

  private context(id: string): CompanionContext {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      throw new ValidationError("Invalid companion id.");
    }
    let context = this.companions.get(id);
    if (!context) {
      context = {
        id,
        epoch: 0,
        queue: [],
        voiceConnected: false,
        voiceSpeaking: false,
        voiceOfflineStandby: true,
        lastVoiceActivity: 0,
        lastAutonomyAt: 0,
      };
      this.companions.set(id, context);
    }
    return context;
  }

  private expire(context: CompanionContext, now = Date.now()): void {
    context.queue = context.queue.filter((record) => record.command.expiresAt > now);
    if (context.active && context.active.command.expiresAt <= now) {
      this.store.addAudit(context.id, "command_expired", { id: context.active.command.id, kind: context.active.command.kind });
      context.active = undefined;
    }
    if (context.confirmation && context.confirmation.expiresAt <= now) {
      this.store.addAudit(context.id, "confirmation_expired", { id: context.confirmation.id });
      this.publish({ type: "confirmation", companionId: context.id, data: { id: context.confirmation.id, expired: true } });
      context.confirmation = undefined;
    }
  }

  private requiresConfirmation(kind: CommandKind, args: Record<string, unknown>, state: CompanionState | undefined): boolean {
    if (kind === "attack_nearby_threat") {
      const target = targetFromState(state, args.targetGuid, "attack");
      return Boolean(target && !isLikelyHostile(target));
    }
    if (kind === "equip_or_eat") {
      const action = args.action === "equip" ? "equip" : "eat";
      return action === "eat" && !isOrdinaryFoodName(args.itemName);
    }
    if (kind === "give_item") {
      return !isOrdinaryTransferItemName(args.itemName);
    }
    return false;
  }

  private enqueueAssistantSpeech(context: CompanionContext, text: string): Command | undefined {
    const now = Date.now();
    const last = context.lastAssistantSpeech;
    if (last && (
      (last.text === text && now - last.sentAt < ASSISTANT_SPEECH_DUPLICATE_WINDOW_MS)
      || now - last.sentAt < ASSISTANT_SPEECH_RATE_LIMIT_MS
    )) {
      return undefined;
    }
    const command = this.enqueue(context.id, "say_in_game", { text }, "player");
    context.lastAssistantSpeech = { text, sentAt: now };
    return command;
  }

  private publicState(state: CompanionState): Record<string, unknown> {
    return {
      revision: state.revision,
      health: state.health,
      hunger: state.hunger,
      sanity: state.sanity,
      temperature: state.temperature,
      player: state.player,
      nearby: state.nearby,
      world: state.world,
      currentAction: state.currentAction,
      isBusy: state.isBusy,
      isNearDanger: state.isNearDanger,
    };
  }

  private realtimeToolCacheKey(companionId: string, idempotenceKey: string | undefined): string | undefined {
    if (idempotenceKey === undefined) {
      return undefined;
    }
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(idempotenceKey)) {
      throw new ValidationError("Realtime tool call id is invalid.");
    }
    return `${companionId}:${idempotenceKey}`;
  }

  private expireRealtimeToolResults(now = Date.now()): void {
    for (const [key, record] of this.realtimeToolResults) {
      if (record.expiresAt <= now) {
        this.realtimeToolResults.delete(key);
      }
    }
  }
}

function isOrdinaryFoodName(value: unknown): boolean {
  return ORDINARY_FOOD_PREFABS.has(normalizePrefabName(value));
}

function isOrdinaryTransferItemName(value: unknown): boolean {
  return ORDINARY_TRANSFER_PREFABS.has(normalizePrefabName(value));
}

function normalizePrefabName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}
