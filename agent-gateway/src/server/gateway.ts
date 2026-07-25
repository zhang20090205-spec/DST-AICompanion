import { createHash, randomUUID } from "node:crypto";
import type {
  Command,
  CommandKind,
  CommandPriority,
  CommandResult,
  CommandStatus,
  CompanionState,
  FeedbackDirective,
  FeedbackPolicy,
  GatherProgress,
  PendingConfirmation,
  PlayerInput,
  PlayerInputReceipt,
  SafeCommandSummary,
} from "../shared/types.js";
import { GatewayStore } from "./database.js";
import { FastIntentRouter } from "./fast-intent-router.js";
import {
  ValidationError,
  boundedExpiry,
  canonicalGatherPrefab,
  isCommandKind,
  isLikelyHostile,
  normalizeState,
  sanitizeChat,
  targetFromState,
  validateCommandArgs,
  validateCommandResult,
} from "./validation.js";

export interface GatewayEvent {
  type: string;
  companionId?: string;
  data: Record<string, unknown>;
}

type CommandLifecycleStatus = "queued" | "dispatched" | CommandStatus;

interface CommandRecord {
  command: Command;
  queuedAt: number;
  started?: boolean;
}

interface CommandLifecycleRecord {
  command: Command;
  status: CommandLifecycleStatus;
  queuedAt: number;
  dispatchedAt?: number;
  startedAt?: number;
  completedAt?: number;
  progress?: GatherProgress;
  result?: CommandResult;
}

interface CommandWaiter {
  resolve: (record: CommandLifecycleRecord) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingTrustedGatherMessage {
  status: "succeeded" | "partial" | "failed";
  outcome: GatherProgress;
  text: string;
}

interface CompanionContext {
  id: string;
  epoch: number;
  state?: CompanionState;
  queue: CommandRecord[];
  active?: CommandRecord;
  commandLifecycles: Map<string, CommandLifecycleRecord>;
  commandWaiters: Map<string, Set<CommandWaiter>>;
  pendingTrustedGatherMessages: PendingTrustedGatherMessage[];
  trustedGatherSpeechCommandIds: Set<string>;
  fastPlayerCommandIds: Set<string>;
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
const INTERMEDIATE_ASSISTANT_ACKNOWLEDGEMENT = /^(?:我(?:已经)?明白了?|我去处理一下|马上(?:完成|处理)|i (?:already )?understand(?:[.!！。]|$)|i(?:'|’)ll (?:handle|take care))/i;
const COMMAND_LIFECYCLE_RETENTION_MS = 5 * 60_000;
const MAX_COMMAND_WAIT_MS = 10_000;

const GATHER_RESOURCE_LABELS: Record<string, { label: string; unit: string }> = {
  berrybush: { label: "浆果", unit: "丛" },
  berrybush2: { label: "多汁浆果", unit: "丛" },
  berrybush_juicy: { label: "多汁浆果", unit: "丛" },
  berries: { label: "浆果", unit: "个" },
  berries_juicy: { label: "多汁浆果", unit: "个" },
  carrot: { label: "胡萝卜", unit: "个" },
  cutgrass: { label: "草", unit: "丛" },
  grass: { label: "草", unit: "丛" },
  sapling: { label: "树枝", unit: "丛" },
  sapling_moon: { label: "树枝", unit: "丛" },
  twiggytree: { label: "多枝树", unit: "棵" },
  evergreen: { label: "常青树", unit: "棵" },
  deciduoustree: { label: "桦栗树", unit: "棵" },
  rocks: { label: "岩石", unit: "块" },
  rock1: { label: "岩石", unit: "块" },
  rock2: { label: "岩石", unit: "块" },
  rock_flintless: { label: "岩石", unit: "块" },
  rock_moon: { label: "月岩", unit: "块" },
  flint: { label: "燧石", unit: "块" },
  reeds: { label: "芦苇", unit: "丛" },
  flower: { label: "花", unit: "朵" },
  flower_evil: { label: "恶之花", unit: "朵" },
  evergreen_sparse: { label: "枯树", unit: "棵" },
};

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

const NON_STOP_REALTIME_GAMEPLAY_TOOLS = new Set([
  "follow_player",
  "approach_or_retreat",
  "gather_nearby",
  "attack_nearby_threat",
  "equip_or_eat",
  "give_item",
  "request_confirmation",
]);

const FEEDBACK_CHANNEL = "voice_only_preamble" satisfies FeedbackDirective["channel"];

export class GatewayCore {
  private readonly companions = new Map<string, CompanionContext>();
  private readonly browserSessions = new Map<string, BrowserSession>();
  private readonly listeners = new Set<(event: GatewayEvent) => void>();
  private readonly seenInputIds = new Map<string, number>();
  private readonly realtimeToolResults = new Map<string, RealtimeToolRecord>();
  private readonly fastIntentRouter = new FastIntentRouter();
  private controllerMode: "realtime" | "airi" = "realtime";
  private controllerConnected = false;
  private controllerAuthenticated = false;
  private lastControllerActivity = 0;

  constructor(readonly store: GatewayStore) {}

  setControllerMode(mode: "realtime" | "airi"): void {
    this.controllerMode = mode;
  }

  setControllerState(active: boolean, authenticated = active): void {
    const wasConnected = this.controllerConnected;
    this.controllerConnected = active;
    this.controllerAuthenticated = active && authenticated;
    this.lastControllerActivity = Date.now();
    for (const context of this.companions.values()) {
      this.setVoiceState(context.id, active);
    }
    if (active || wasConnected) {
      this.publish({
        type: "controller-state",
        companionId: "default",
        data: { mode: this.controllerMode, connected: active, authenticated: this.controllerAuthenticated },
      });
    }
  }

  touchController(): void {
    if (!this.controllerConnected) {
      return;
    }
    this.lastControllerActivity = Date.now();
    for (const context of this.companions.values()) {
      context.lastVoiceActivity = this.lastControllerActivity;
    }
  }

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
    this.flushTrustedGatherMessages(context);
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
    this.updateCommandLifecycle(context, next.command, "dispatched");
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
    const safeResult = validateCommandResult(result);
    this.assertResultMatchesCommand(active.command, safeResult);

    if (safeResult.status === "started") {
      if (active.started) {
        return { accepted: true, duplicate: true };
      }
      active.started = true;
      this.updateCommandLifecycle(context, active.command, "started", safeResult);
    } else if (safeResult.status === "progress") {
      active.started = true;
      this.updateCommandLifecycle(context, active.command, "progress", safeResult);
    }
    this.store.addAudit(companionId, `command_${safeResult.status}`, {
      id: safeResult.id,
      kind: active.command.kind,
      reason: safeResult.reason,
      stateRevision: safeResult.stateRevision,
      outcome: safeResult.outcome ?? null,
    });
    if (safeResult.status === "progress") {
      this.store.setCompanionMemory(companionId, "current_goal", JSON.stringify({
        kind: active.command.kind,
        state: "progress",
        epoch: active.command.epoch,
      }));
      this.publish({
        type: "command-progress",
        companionId,
        data: {
          result: safeResult,
          progress: safeResult.outcome?.gather ?? null,
          kind: active.command.kind,
          lifecycle: this.publicCommandLifecycle(context.commandLifecycles.get(safeResult.id)),
        },
      });
      return { accepted: true, duplicate: false };
    }
    if (this.isTerminalCommandStatus(safeResult.status)) {
      this.updateCommandLifecycle(context, active.command, safeResult.status, safeResult);
      context.active = undefined;
      this.store.setCompanionMemory(companionId, "current_goal", JSON.stringify({ state: "idle" }));
      this.store.setCompanionMemory(companionId, "task_summary", JSON.stringify({
        kind: active.command.kind,
        status: safeResult.status,
      }));
      this.queueTrustedGatherTerminalMessage(context, active.command, safeResult);
      this.flushTrustedGatherMessages(context);
      if (active.command.kind === "say_in_game") {
        context.trustedGatherSpeechCommandIds.delete(safeResult.id);
      }
      this.publish({
        type: "command-result",
        companionId,
        data: {
          result: safeResult,
          kind: active.command.kind,
          feedback: this.feedbackForCommand(active.command),
          lifecycle: this.publicCommandLifecycle(context.commandLifecycles.get(safeResult.id)),
        },
      });
    }
    return { accepted: true, duplicate: false };
  }

  commandStatus(companionId: string, commandId: string): Record<string, unknown> | null {
    const context = this.context(companionId);
    this.expire(context);
    return this.publicCommandLifecycle(context.commandLifecycles.get(commandId));
  }

  async waitForCommandTerminal(
    companionId: string,
    commandId: string,
    timeoutMs = MAX_COMMAND_WAIT_MS,
  ): Promise<Record<string, unknown> | null> {
    const context = this.context(companionId);
    this.expire(context);
    const existing = context.commandLifecycles.get(commandId);
    if (!existing || this.isTerminalCommandStatus(existing.status) || timeoutMs <= 0) {
      return this.publicCommandLifecycle(existing);
    }

    const boundedTimeout = Math.max(1, Math.min(MAX_COMMAND_WAIT_MS, Math.floor(timeoutMs)));
    const record = await new Promise<CommandLifecycleRecord>((resolve) => {
      const waiter: CommandWaiter = {
        resolve,
        timer: setTimeout(() => {
          context.commandWaiters.get(commandId)?.delete(waiter);
          resolve(context.commandLifecycles.get(commandId) ?? existing);
        }, boundedTimeout),
      };
      let waiters = context.commandWaiters.get(commandId);
      if (!waiters) {
        waiters = new Set<CommandWaiter>();
        context.commandWaiters.set(commandId, waiters);
      }
      waiters.add(waiter);
    });
    return this.publicCommandLifecycle(record);
  }

  receivePlayerInput(companionId: string, input: PlayerInput): PlayerInputReceipt {
    const normalized = sanitizeChat(input.text);
    const inputId = this.safePlayerInputId(input.id);
    const dedupeKey = inputId ? `${companionId}:${inputId}` : undefined;
    if (dedupeKey && this.seenInputIds.get(dedupeKey) && Date.now() - (this.seenInputIds.get(dedupeKey) ?? 0) < 60_000) {
      return { action: "duplicate", inputId, route: "local_safety" };
    }
    if (dedupeKey) {
      this.seenInputIds.set(dedupeKey, Date.now());
    }
    const context = this.context(companionId);
    this.expire(context);
    const lower = normalized.toLowerCase();
    if (lower === "stop" || lower === "停止" || lower === "停下" || lower === "别动") {
      const command = this.interrupt(companionId, "player_stop");
      this.markFastPlayerCommand(context, command);
      const receipt: PlayerInputReceipt = {
        action: "interrupted",
        inputId,
        route: "fast_intent",
        intent: "stop",
        reason: "player_stop",
        command: this.safeCommandSummary(command),
      };
      this.publishSafePlayerInput(companionId, input.source, receipt);
      return receipt;
    }
    if ((lower === "yes" || lower === "是" || lower === "确认") && context.confirmation) {
      const confirmation = context.confirmation;
      context.confirmation = undefined;
      const command = this.enqueue(companionId, confirmation.command.kind, confirmation.command.args, "player", true);
      this.store.setCompanionMemory(companionId, `preference.${confirmation.command.kind}`, "approved");
      this.publish({
        type: "confirmation",
        companionId,
        data: { id: confirmation.id, accepted: true, command, feedback: this.feedbackForCommand(command) },
      });
      return {
        action: "confirmed",
        inputId,
        route: "confirmation",
        confirmation: confirmation.id,
        command: this.safeCommandSummary(command),
      };
    }
    if ((lower === "no" || lower === "否" || lower === "取消") && context.confirmation) {
      const confirmation = context.confirmation;
      context.confirmation = undefined;
      this.store.setCompanionMemory(companionId, `preference.${confirmation.command.kind}`, "declined");
      this.store.addAudit(companionId, "confirmation_rejected", { id: confirmation.id });
      this.publish({ type: "confirmation", companionId, data: { id: confirmation.id, accepted: false } });
      return {
        action: "rejected",
        inputId,
        route: "confirmation",
        confirmation: confirmation.id,
        reason: "player_declined",
      };
    }
    if (this.controllerMode === "airi") {
      const receipt: PlayerInputReceipt = { action: "forwarded", inputId, route: "airi" };
      this.publish({
        type: "player-input",
        companionId,
        data: { ...receipt, text: normalized, source: input.source, userid: input.userid ?? null },
      });
      return receipt;
    }
    const fastRoute = this.fastIntentRouter.route(normalized, context.state);
    if (context.confirmation && fastRoute.status !== "none" && fastRoute.intent !== "stop") {
      const receipt: PlayerInputReceipt = {
        action: "forwarded",
        inputId,
        route: "realtime",
        reason: "pending_confirmation",
      };
      this.publish({
        type: "player-input",
        companionId,
        data: { ...receipt, text: normalized, source: input.source, userid: input.userid ?? null },
      });
      return receipt;
    }
    if (fastRoute.status === "blocked") {
      const receipt: PlayerInputReceipt = {
        action: "blocked",
        inputId,
        route: "fast_intent",
        intent: fastRoute.intent,
        reason: fastRoute.reason,
      };
      // A blocked fast-path request must be passed to Realtime for a concise
      // clarification. The text is only broadcast live (never audited or
      // persisted), just like other model-routed player input.
      this.publish({
        type: "player-input",
        companionId,
        data: { ...receipt, text: normalized, source: input.source, userid: input.userid ?? null },
      });
      return receipt;
    }
    if (fastRoute.status === "matched") {
      const command = fastRoute.intent === "stop"
        ? this.interrupt(companionId, "player_stop")
        : this.enqueueFastPlayerCommand(companionId, fastRoute.command.kind, fastRoute.command.args);
      this.markFastPlayerCommand(this.context(companionId), command);
      const hasResidualText = Boolean(fastRoute.residualText);
      const receipt: PlayerInputReceipt = {
        action: fastRoute.intent === "stop" ? "interrupted" : "routed",
        inputId,
        route: "fast_intent",
        intent: fastRoute.intent,
        reason: fastRoute.reason,
        command: this.safeCommandSummary(command),
        ...(hasResidualText ? { residualText: { present: true, route: "realtime" } } : {}),
      };
      this.publishSafePlayerInput(companionId, input.source, receipt);
      if (fastRoute.residualText) {
        this.publishResidualPlayerInput(companionId, input.source, input.userid, inputId, fastRoute.residualText);
      }
      return receipt;
    }
    // Transcript text is intentionally only sent to live SSE subscribers, never persisted.
    const receipt: PlayerInputReceipt = { action: "forwarded", inputId, route: "realtime" };
    this.publish({ type: "player-input", companionId, data: { ...receipt, text: normalized, source: input.source, userid: input.userid ?? null } });
    return receipt;
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

  private safePlayerInputId(value: unknown): string | undefined {
    if (typeof value !== "string") {
      return undefined;
    }
    const safeId = value.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 128);
    return safeId || undefined;
  }

  private publishSafePlayerInput(companionId: string, source: PlayerInput["source"], receipt: PlayerInputReceipt): void {
    this.publish({
      type: "player-input",
      companionId,
      data: { ...receipt, source },
    });
  }

  private publishResidualPlayerInput(
    companionId: string,
    source: PlayerInput["source"],
    userid: string | undefined,
    inputId: string | undefined,
    text: string,
  ): void {
    const receipt: PlayerInputReceipt = {
      action: "forwarded",
      inputId,
      route: "realtime",
      reason: "residual_text",
      residualText: { present: true, route: "realtime" },
    };
    this.publish({
      type: "player-input",
      companionId,
      data: { ...receipt, text, source: "game", originalSource: source, userid: userid ?? null },
    });
  }

  private safeCommandSummary(command: Command): SafeCommandSummary {
    return {
      id: command.id,
      kind: command.kind,
      args: command.args,
      feedback: this.feedbackForCommand(command),
    };
  }

  private markFastPlayerCommand(context: CompanionContext, command: Command): void {
    context.fastPlayerCommandIds.add(command.id);
  }

  interrupt(companionId: string, reason: string): Command {
    const context = this.context(companionId);
    const now = Date.now();
    const safeReason = reason.slice(0, 80);
    for (const record of context.queue) {
      this.cancelCommandRecord(context, record, safeReason);
    }
    if (context.active) {
      this.cancelCommandRecord(context, context.active, safeReason);
    }
    if (context.confirmation) {
      const confirmation = context.confirmation;
      this.store.addAudit(companionId, "confirmation_cancelled", { id: confirmation.id, reason: safeReason });
      this.publish({ type: "confirmation", companionId, data: { id: confirmation.id, accepted: false, cancelled: true, reason: safeReason } });
    }
    context.epoch += 1;
    context.queue = [];
    context.active = undefined;
    context.confirmation = undefined;
    const command: Command = {
      id: randomUUID(),
      epoch: context.epoch,
      priority: "interrupt",
      kind: "clear_action_queue",
      args: { reason: safeReason },
      expiresAt: boundedExpiry(now, 5_000, "clear_action_queue"),
    };
    const record = { command, queuedAt: now };
    context.queue.push(record);
    this.rememberCommandLifecycle(context, record);
    this.store.addAudit(companionId, "interrupted", { reason, epoch: context.epoch });
    this.publish({ type: "interrupt", companionId, data: { reason, epoch: context.epoch } });
    return command;
  }

  private enqueueFastPlayerCommand(companionId: string, kind: CommandKind, rawArgs: unknown): Command {
    let context = this.context(companionId);
    if (this.hasGameplayWork(context)) {
      const interrupt = this.interrupt(companionId, "player_fast_intent_override");
      context = this.context(companionId);
      this.markFastPlayerCommand(context, interrupt);
    }
    return this.enqueue(companionId, kind, rawArgs, "player");
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
      const retainedQueue: CommandRecord[] = [];
      for (const record of context.queue) {
        if (record.command.priority === "autonomy") {
          this.cancelCommandRecord(context, record, "player_override");
        } else {
          retainedQueue.push(record);
        }
      }
      context.queue = retainedQueue;
    }
    const activeWeight = context.active ? PRIORITY_WEIGHT[context.active.command.priority] : 0;
    if (priority === "player" && activeWeight < PRIORITY_WEIGHT.player && context.active) {
      this.interrupt(companionId, "player_override");
    }
    const current = this.context(companionId);
    const now = Date.now();
    const commandArgs = confirmed ? { ...args, confirmed: true } : args;
    const command: Command = {
      id: randomUUID(),
      epoch: current.epoch,
      priority,
      kind,
      args: commandArgs,
      expiresAt: boundedExpiry(now, undefined, kind, args),
    };
    const record = { command, queuedAt: now };
    current.queue.push(record);
    this.rememberCommandLifecycle(current, record);
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
    const args = validateCommandArgs(kind, rawArgs, context.state);
    if (!this.requiresConfirmation(kind, args, context.state)) {
      throw new ValidationError("This action does not require player confirmation.");
    }
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
  ): Promise<{ output: Record<string, unknown>; command?: Command }> {
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
      return Promise.resolve({
        output: this.ensurePendingCommandId(this.withCurrentCommandLifecycle(companionId, cached.output, cached.command)),
        command: cached.command,
      });
    }
    const context = this.context(companionId);
    this.expire(context);
    if (this.hasActiveFastPlayerCommand(context) && NON_STOP_REALTIME_GAMEPLAY_TOOLS.has(name)) {
      const output = {
        accepted: false,
        deferred: true,
        route: "fast_intent",
        reason: "A deterministic player command is already pending. Wait for its lifecycle or issue stop first.",
      };
      if (cacheKey) {
        this.realtimeToolResults.set(cacheKey, {
          name,
          argsFingerprint,
          output,
          expiresAt: Date.now() + TOOL_CALL_CACHE_TTL_MS,
        });
      }
      return Promise.resolve({ output });
    }

    return this.runRealtimeTool(companionId, name, rawArgs).then((result) => {
      const output = this.ensurePendingCommandId(result.output);
      if (cacheKey) {
        this.realtimeToolResults.set(cacheKey, {
          name,
          argsFingerprint,
          output,
          command: result.command,
          expiresAt: Date.now() + TOOL_CALL_CACHE_TTL_MS,
        });
      }
      return { output, command: result.command };
    });
  }

  // Declared async so that fail-closed guard rejections surface as a rejected
  // promise rather than a synchronous throw. Callers (and tests) treat every
  // Airi tool invocation as an awaitable that can reject.
  async handleAiriTool(
    companionId: string,
    name: unknown,
    rawArgs: unknown,
    idempotenceKey: string,
  ): Promise<{ output: Record<string, unknown>; command?: Command }> {
    if (this.controllerMode !== "airi") {
      throw new ValidationError("Airi controller mode is not enabled.");
    }
    const safeName = typeof name === "string" ? name : "";
    if (!this.controllerConnected && !["get_game_state", "stop_and_wait", "clear_action_queue"].includes(safeName)) {
      throw new ValidationError("Airi is offline; gameplay tools are unavailable.");
    }
    this.touchController();
    return this.handleRealtimeTool(companionId, name, rawArgs, idempotenceKey);
  }

  companionSnapshot(companionId: string): Record<string, unknown> {
    const context = this.context(companionId);
    this.expire(context);
    return {
      id: context.id,
      epoch: context.epoch,
      controllerMode: this.controllerMode,
      controllerConnected: this.controllerConnected,
      controllerAuthenticated: this.controllerAuthenticated,
      airiConnected: this.controllerMode === "airi" && this.controllerConnected,
      airiAuthenticated: this.controllerMode === "airi" && this.controllerAuthenticated,
      state: context.state ? this.publicState(context.state) : null,
      stateFresh: Boolean(context.state && Date.now() - context.state.receivedAt < 5_000),
      confirmation: context.confirmation ? {
        id: context.confirmation.id,
        prompt: context.confirmation.prompt,
        expiresAt: context.confirmation.expiresAt,
        kind: context.confirmation.command.kind,
      } : null,
      activeCommand: context.active ? this.publicCommandLifecycle(context.commandLifecycles.get(context.active.command.id)) : null,
      queuedCommands: context.queue.slice(0, 8).map((record) =>
        this.publicCommandLifecycle(context.commandLifecycles.get(record.command.id)),
      ).filter((record): record is Record<string, unknown> => Boolean(record)),
    };
  }

  private async runRealtimeTool(
    companionId: string,
    name: string,
    rawArgs: unknown,
  ): Promise<{ output: Record<string, unknown>; command?: Command }> {
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
      return {
        output: {
          confirmationId: confirmation.id,
          status: "awaiting_player",
          expiresAt: confirmation.expiresAt,
          feedback: this.feedbackForCommandKind(args.kind, args.args),
        },
      };
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
      return {
        output: {
          status: "awaiting_player",
          confirmationId: confirmation.id,
          expiresAt: confirmation.expiresAt,
          feedback: this.feedbackForCommandKind(kind, args),
        },
      };
    }
    if (kind === "stop_and_wait") {
      this.interrupt(companionId, "tool_stop_and_wait");
    }
    if (kind === "say_in_game") {
      const text = sanitizeChat(args.text);
      if (INTERMEDIATE_ASSISTANT_ACKNOWLEDGEMENT.test(text)) {
        return {
          output: {
            accepted: false,
            deferred: true,
            reason: "Intermediate acknowledgements are suppressed. Execute the requested game action first and wait for its trusted terminal result.",
          },
        };
      }
      if (this.hasGameplayWork(context) || this.hasTrustedGatherSpeechPending(context)) {
        return {
          output: {
            accepted: false,
            deferred: true,
            reason: "A gameplay command or its trusted result report is pending. Do not speak in game until the trusted lifecycle is finished.",
          },
        };
      }
      const command = this.enqueueAssistantSpeech(context, text);
      if (!command) {
        return { output: { accepted: true, duplicate: true } };
      }
      return { output: this.realtimeCommandOutput(companionId, command, false), command };
    }
    const command = this.enqueue(companionId, kind, args, "player");
    return { output: this.realtimeCommandOutput(companionId, command), command };
  }

  runAutonomy(now = Date.now()): void {
    if (this.controllerMode === "airi") {
      return;
    }
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
    if (this.controllerConnected && now - this.lastControllerActivity > 15_000) {
      this.setControllerState(false, false);
    }
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
      controllerMode: this.controllerMode,
      controllerConnected: this.controllerConnected,
      controllerAuthenticated: this.controllerAuthenticated,
      lastControllerActivity: this.lastControllerActivity || null,
      companions: [...this.companions.values()].map((context) => ({
        id: context.id,
        epoch: context.epoch,
        connected: Boolean(context.state && Date.now() - context.state.receivedAt < 5_000),
        voiceActive: context.voiceSpeaking,
        voiceConnected: context.voiceConnected,
        voiceOfflineStandby: context.voiceOfflineStandby,
        controllerConnected: this.controllerConnected,
        confirmation: context.confirmation ? {
          id: context.confirmation.id,
          prompt: context.confirmation.prompt,
          expiresAt: context.confirmation.expiresAt,
          kind: context.confirmation.command.kind,
        } : null,
        activeCommand: context.active ? this.publicCommandLifecycle(context.commandLifecycles.get(context.active.command.id)) : null,
        queuedCommands: context.queue.slice(0, 8).map((record) =>
          this.publicCommandLifecycle(context.commandLifecycles.get(record.command.id)),
        ).filter((record): record is Record<string, unknown> => Boolean(record)),
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
        commandLifecycles: new Map<string, CommandLifecycleRecord>(),
        commandWaiters: new Map<string, Set<CommandWaiter>>(),
        pendingTrustedGatherMessages: [],
        trustedGatherSpeechCommandIds: new Set<string>(),
        fastPlayerCommandIds: new Set<string>(),
        voiceConnected: this.controllerMode === "airi" ? this.controllerConnected : false,
        voiceSpeaking: false,
        voiceOfflineStandby: this.controllerMode === "airi" ? !this.controllerConnected : true,
        lastVoiceActivity: this.controllerMode === "airi" ? this.lastControllerActivity : 0,
        lastAutonomyAt: 0,
      };
      this.companions.set(id, context);
    }
    return context;
  }

  private expire(context: CompanionContext, now = Date.now()): void {
    const freshQueue: CommandRecord[] = [];
    for (const record of context.queue) {
      if (record.command.expiresAt > now) {
        freshQueue.push(record);
      } else {
        this.store.addAudit(context.id, "command_expired", { id: record.command.id, kind: record.command.kind });
        this.cancelCommandRecord(context, record, "command expired");
      }
    }
    context.queue = freshQueue;
    if (context.active && context.active.command.expiresAt <= now) {
      this.store.addAudit(context.id, "command_expired", { id: context.active.command.id, kind: context.active.command.kind });
      this.cancelCommandRecord(context, context.active, "command expired");
      context.active = undefined;
    }
    if (context.confirmation && context.confirmation.expiresAt <= now) {
      this.store.addAudit(context.id, "confirmation_expired", { id: context.confirmation.id });
      this.publish({ type: "confirmation", companionId: context.id, data: { id: context.confirmation.id, expired: true } });
      context.confirmation = undefined;
    }
    for (const [id, record] of context.commandLifecycles) {
      if (this.isTerminalCommandStatus(record.status) && (record.completedAt ?? record.queuedAt) + COMMAND_LIFECYCLE_RETENTION_MS <= now) {
        context.commandLifecycles.delete(id);
        context.fastPlayerCommandIds.delete(id);
      }
    }
    this.flushTrustedGatherMessages(context);
  }

  private rememberCommandLifecycle(context: CompanionContext, record: CommandRecord): void {
    context.commandLifecycles.set(record.command.id, {
      command: record.command,
      status: "queued",
      queuedAt: record.queuedAt,
    });
    this.publishCommandLifecycle(context, record.command.id);
  }

  private updateCommandLifecycle(
    context: CompanionContext,
    command: Command,
    status: CommandLifecycleStatus,
    result?: CommandResult,
  ): void {
    const now = Date.now();
    let record = context.commandLifecycles.get(command.id);
    if (!record) {
      record = { command, status: "queued", queuedAt: now };
      context.commandLifecycles.set(command.id, record);
    }
    if (this.isTerminalCommandStatus(record.status)) {
      return;
    }

    record.status = status;
    if (status === "dispatched") {
      record.dispatchedAt = record.dispatchedAt ?? now;
    } else if (status === "started") {
      record.startedAt = record.startedAt ?? now;
    } else if (status === "progress") {
      record.startedAt = record.startedAt ?? now;
      record.progress = result?.outcome?.gather;
    } else if (this.isTerminalCommandStatus(status)) {
      record.completedAt = now;
    }
    if (result && this.isTerminalCommandStatus(status)) {
      record.result = result;
    }
    if (this.isTerminalCommandStatus(status)) {
      context.fastPlayerCommandIds.delete(command.id);
    }
    this.publishCommandLifecycle(context, command.id);
    if (this.isTerminalCommandStatus(status)) {
      this.resolveCommandWaiters(context, command.id, record);
    }
  }

  private cancelCommandRecord(context: CompanionContext, record: CommandRecord, reason: string): void {
    const existing = context.commandLifecycles.get(record.command.id);
    if (existing && this.isTerminalCommandStatus(existing.status)) {
      return;
    }
    const result: CommandResult = {
      id: record.command.id,
      status: "cancelled",
      reason,
      stateRevision: context.state?.revision ?? 0,
    };
    this.store.addAudit(context.id, "command_cancelled", {
      id: record.command.id,
      kind: record.command.kind,
      reason,
    });
    this.updateCommandLifecycle(context, record.command, "cancelled", result);
    if (record.command.kind === "say_in_game") {
      context.trustedGatherSpeechCommandIds.delete(record.command.id);
    }
    this.publish({
      type: "command-result",
      companionId: context.id,
      data: {
        result,
        kind: record.command.kind,
        feedback: this.feedbackForCommand(record.command),
        lifecycle: this.publicCommandLifecycle(context.commandLifecycles.get(record.command.id)),
      },
    });
  }

  private publishCommandLifecycle(context: CompanionContext, commandId: string): void {
    const lifecycle = this.publicCommandLifecycle(context.commandLifecycles.get(commandId));
    if (lifecycle) {
      this.publish({ type: "command-lifecycle", companionId: context.id, data: lifecycle });
    }
  }

  private resolveCommandWaiters(context: CompanionContext, commandId: string, record: CommandLifecycleRecord): void {
    const waiters = context.commandWaiters.get(commandId);
    if (!waiters) {
      return;
    }
    context.commandWaiters.delete(commandId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(record);
    }
  }

  private publicCommandLifecycle(record: CommandLifecycleRecord | undefined): Record<string, unknown> | null {
    if (!record) {
      return null;
    }
    return {
      id: record.command.id,
      kind: record.command.kind,
      epoch: record.command.epoch,
      priority: record.command.priority,
      status: record.status,
      terminal: this.isTerminalCommandStatus(record.status),
      queuedAt: record.queuedAt,
      dispatchedAt: record.dispatchedAt ?? null,
      startedAt: record.startedAt ?? null,
      completedAt: record.completedAt ?? null,
      progress: record.progress ?? null,
      result: record.result ?? null,
      feedback: this.feedbackForCommand(record.command),
    };
  }

  private realtimeCommandOutput(companionId: string, command: Command, terminalWaitAllowed = true): Record<string, unknown> {
    const lifecycle = this.commandStatus(companionId, command.id);
    const status = typeof lifecycle?.status === "string" ? lifecycle.status : "queued";
    const terminal = lifecycle?.terminal === true;
    return {
      accepted: true,
      commandId: command.id,
      kind: command.kind,
      epoch: command.epoch,
      status,
      terminal,
      lifecycle,
      result: lifecycle?.result ?? null,
      pending: !terminal,
      feedback: this.feedbackForCommand(command),
      ...(terminal
        ? {}
        : {
            waitRecommended: terminalWaitAllowed,
            instruction: "The DST action is not complete yet. Do not tell the player it succeeded until a terminal command lifecycle reports succeeded.",
          }),
    };
  }

  private withCurrentCommandLifecycle(
    companionId: string,
    output: Record<string, unknown>,
    command: Command | undefined,
  ): Record<string, unknown> {
    if (!command) {
      return output;
    }
    return {
      ...output,
      ...this.realtimeCommandOutput(companionId, command),
    };
  }

  private ensurePendingCommandId(output: Record<string, unknown>): Record<string, unknown> {
    if (
      output.accepted === true
      && output.pending === true
      && (typeof output.commandId !== "string" || output.commandId.trim().length === 0)
    ) {
      return {
        ok: false,
        accepted: false,
        recoverable: true,
        error: {
          code: "gateway_protocol_error",
          message: "Pending gameplay tool output was missing commandId. Retry the action tool call.",
        },
      };
    }
    return output;
  }

  private feedbackForCommand(command: Command): FeedbackDirective {
    return this.feedbackForCommandKind(command.kind, command.args);
  }

  private feedbackForCommandKind(kind: CommandKind, args: unknown): FeedbackDirective {
    const policy = this.feedbackPolicyForCommand(kind, args);
    return { policy, channel: FEEDBACK_CHANNEL };
  }

  private feedbackPolicyForCommand(kind: CommandKind, args: unknown): FeedbackPolicy {
    if (kind === "gather_nearby") {
      return "issues_only";
    }
    if (this.isConfirmedHighRiskAction(kind, args)) {
      return "always_result";
    }
    return "silent_success";
  }

  private isConfirmedHighRiskAction(kind: CommandKind, args: unknown): boolean {
    return (
      (kind === "attack_nearby_threat" || kind === "equip_or_eat" || kind === "give_item")
      && args !== null
      && typeof args === "object"
      && !Array.isArray(args)
      && (args as Record<string, unknown>).confirmed === true
    );
  }

  private assertResultMatchesCommand(command: Command, result: CommandResult): void {
    const gather = result.outcome?.gather;
    if (command.kind !== "gather_nearby") {
      if (result.status === "progress" || result.status === "partial") {
        throw new ValidationError("Only gather_nearby may report progress or partial completion.");
      }
      if (gather) {
        throw new ValidationError("Only gather_nearby may include a gather outcome.");
      }
      return;
    }

    const requiresGatherOutcome = result.status === "progress"
      || result.status === "partial"
      || result.status === "succeeded";
    if (requiresGatherOutcome && !gather) {
      throw new ValidationError("Gather progress and successful terminal results require a gather outcome.");
    }
    if (result.status === "started" && gather) {
      throw new ValidationError("A started gather result must not include an outcome.");
    }
    if (!gather) {
      return;
    }

    const expectedScope = command.args.scope === "all_same_prefab" ? "all_same_prefab" : "single";
    const expectedMode = command.args.mode === "chop" || command.args.mode === "mine" ? command.args.mode : "collect";
    const expectedPrefab = typeof command.args.targetPrefab === "string"
      ? canonicalGatherPrefab(command.args.targetPrefab)
      : "";
    if (
      gather.scope !== expectedScope
      || gather.mode !== expectedMode
      || !expectedPrefab
      || canonicalGatherPrefab(gather.targetPrefab) !== expectedPrefab
    ) {
      throw new ValidationError("Gather outcome does not match the canonical queued gather command.");
    }
    if (gather.scope === "single" && gather.attempted > 1) {
      throw new ValidationError("A single-target gather result may only describe one target.");
    }
    if (result.status === "succeeded" && (gather.remaining !== 0 || gather.skipped !== 0)) {
      throw new ValidationError("Gather cannot report succeeded while targets remain or were skipped.");
    }
    if (result.status === "succeeded" && gather.completed === 0) {
      throw new ValidationError("Gather cannot report succeeded without completing a target.");
    }
    if (result.status === "partial" && gather.remaining === 0 && gather.skipped === 0) {
      throw new ValidationError("Gather partial completion requires a remaining or skipped target.");
    }
  }

  private queueTrustedGatherTerminalMessage(
    context: CompanionContext,
    command: Command,
    result: CommandResult,
  ): void {
    const outcome = result.outcome?.gather;
    if (
      command.kind !== "gather_nearby"
      || (result.status !== "succeeded" && result.status !== "partial" && result.status !== "failed")
    ) {
      return;
    }
    const text = this.trustedGatherTerminalText(command, result);
    if (!text) {
      return;
    }
    const message: PendingTrustedGatherMessage = { status: result.status, outcome: outcome ?? this.gatherOutcomeFromCommand(command), text };
    context.pendingTrustedGatherMessages.push(message);
    if (this.hasGameplayWork(context)) {
      this.publish({
        type: "trusted-gather-message",
        companionId: context.id,
        data: { status: message.status, outcome: { gather: message.outcome }, deferred: true },
      });
    }
  }

  private trustedGatherTerminalText(command: Command, result: CommandResult): string | undefined {
    const outcome = result.outcome?.gather;
    if (result.status === "succeeded") {
      if (!outcome || outcome.scope !== "all_same_prefab") {
        return undefined;
      }
      const resource = this.gatherResource(outcome.targetPrefab);
      return `附近 ${resource.label}：已采集 ${outcome.completed}/${outcome.attempted} ${resource.unit}。`;
    }
    if (result.status === "partial") {
      if (!outcome) {
        return undefined;
      }
      const resource = this.gatherResource(outcome.targetPrefab);
      return `附近 ${resource.label}：采集 ${outcome.completed}/${outcome.attempted} ${resource.unit}，剩余 ${outcome.remaining}，跳过 ${outcome.skipped}。`;
    }
    if (result.status === "failed") {
      const targetPrefab = typeof command.args.targetPrefab === "string" && command.args.targetPrefab.trim()
        ? command.args.targetPrefab.trim()
        : "目标";
      const resource = this.gatherResource(targetPrefab);
      const reason = result.reason ? `，原因：${result.reason}` : "";
      return `附近 ${resource.label}：未完成${reason}。`;
    }
    return undefined;
  }

  private gatherResource(targetPrefab: string): { label: string; unit: string } {
    const canonical = normalizePrefabName(targetPrefab);
    return GATHER_RESOURCE_LABELS[canonical] ?? { label: canonical || "目标", unit: "个" };
  }

  private gatherOutcomeFromCommand(command: Command): GatherProgress {
    const scope = command.args.scope === "all_same_prefab" ? "all_same_prefab" : "single";
    const mode = command.args.mode === "chop" || command.args.mode === "mine" ? command.args.mode : "collect";
    const targetPrefab = typeof command.args.targetPrefab === "string" && command.args.targetPrefab.trim()
      ? normalizePrefabName(command.args.targetPrefab)
      : "目标";
    return { scope, mode, targetPrefab, attempted: 0, completed: 0, remaining: 0, skipped: 0 };
  }

  private flushTrustedGatherMessages(context: CompanionContext): void {
    if (this.hasGameplayWork(context)) {
      return;
    }
    while (context.pendingTrustedGatherMessages.length > 0) {
      const message = context.pendingTrustedGatherMessages.shift()!;
      const command = this.enqueue(context.id, "say_in_game", { text: message.text }, "player");
      context.trustedGatherSpeechCommandIds.add(command.id);
      this.publish({
        type: "trusted-gather-message",
        companionId: context.id,
        data: {
          status: message.status,
          outcome: { gather: message.outcome },
          deferred: false,
          command,
        },
      });
    }
  }

  private hasGameplayWork(context: CompanionContext): boolean {
    return Boolean(
      (context.active && context.active.command.kind !== "say_in_game")
      || context.queue.some((record) => record.command.kind !== "say_in_game"),
    );
  }

  private hasActiveFastPlayerCommand(context: CompanionContext): boolean {
    return Boolean(
      (context.active && context.fastPlayerCommandIds.has(context.active.command.id))
      || context.queue.some((record) => context.fastPlayerCommandIds.has(record.command.id)),
    );
  }

  private hasTrustedGatherSpeechPending(context: CompanionContext): boolean {
    return context.pendingTrustedGatherMessages.length > 0 || context.trustedGatherSpeechCommandIds.size > 0;
  }

  private isTerminalCommandStatus(status: CommandLifecycleStatus): status is "succeeded" | "partial" | "failed" | "cancelled" {
    return status === "succeeded" || status === "partial" || status === "failed" || status === "cancelled";
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
    if (this.hasGameplayWork(context)) {
      return undefined;
    }
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
