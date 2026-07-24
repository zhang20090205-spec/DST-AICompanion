import {
  COMMAND_KINDS,
  COMMAND_PRIORITIES,
  type CommandKind,
  type CommandPriority,
  type CompanionState,
  type NearbyEntity,
} from "../shared/types.js";

const MAX_CHAT_LENGTH = 120;
const MAX_NEARBY = 40;
const MAX_INVENTORY = 40;
const MAX_DISTANCE = 20;
const MAX_TTL_MS = 30_000;
const SAFE_TEXT = /[^\u0009\u000A\u000D\u0020-\u007E\u4E00-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/g;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("Expected an object payload.");
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, fallback: number | null = null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback = 0): number {
  const number = finiteNumber(value, fallback) ?? fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function text(value: unknown, maxLength: number): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(SAFE_TEXT, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizePosition(value: unknown): { x: number; z: number } {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    x: boundedNumber(source.x, -10_000, 10_000),
    z: boundedNumber(source.z, -10_000, 10_000),
  };
}

function normalizeNearby(value: unknown): NearbyEntity[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.slice(0, MAX_NEARBY).flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const source = item as Record<string, unknown>;
    const guid = finiteNumber(source.guid ?? source.GUID);
    const prefab = text(source.prefab ?? source.Prefab, 64);
    if (guid === null || guid < 1 || !prefab) {
      return [];
    }
    const rawTags = Array.isArray(source.tags) ? source.tags : [];
    return [{
      guid: Math.floor(guid),
      prefab,
      distance: boundedNumber(source.distance ?? source.Distance, 0, 250),
      tags: rawTags.filter((tag): tag is string => typeof tag === "string").map((tag) => text(tag, 32)).filter(Boolean).slice(0, 12),
      collectable: Boolean(source.collectable ?? source.Collectable ?? source.pickable ?? source.Pickable),
      choppable: Boolean(source.choppable ?? source.Choppable),
      mineable: Boolean(source.mineable ?? source.Mineable),
      attackable: Boolean(source.attackable ?? source.Attackable),
      edible: Boolean(source.edible ?? source.Edible),
      equippable: Boolean(source.equippable ?? source.Equippable),
    }];
  });
}

function normalizeInventory(value: unknown): Array<{ prefab: string; quantity: number; guid?: number }> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(0, MAX_INVENTORY).flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const source = item as Record<string, unknown>;
    const prefab = text(source.prefab ?? source.Prefab, 64);
    if (!prefab) {
      return [];
    }
    const guid = finiteNumber(source.guid ?? source.GUID);
    return [{
      prefab,
      quantity: Math.floor(boundedNumber(source.quantity ?? source.Quantity, 1, 999, 1)),
      ...(guid !== null && guid > 0 ? { guid: Math.floor(guid) } : {}),
    }];
  });
}

export function normalizeState(value: unknown, revision: number, now = Date.now()): CompanionState {
  const source = asRecord(value);
  const playerSource = source.player && typeof source.player === "object" ? source.player as Record<string, unknown> : source;
  const worldSource = source.world && typeof source.world === "object" ? source.world as Record<string, unknown> : source;
  const playerGuid = finiteNumber(playerSource.guid ?? playerSource.PlayerGUID ?? source.PlayerGUID);
  const playerPosition = playerSource.position ?? {
    x: playerSource.x ?? source.Node_x,
    z: playerSource.z ?? source.Node_z,
  };

  return {
    revision,
    receivedAt: now,
    health: finiteNumber(source.health ?? source.HP ?? source.Health),
    hunger: finiteNumber(source.hunger ?? source.Hunger),
    sanity: finiteNumber(source.sanity ?? source.Sanity),
    temperature: finiteNumber(source.temperature ?? source.Temperature),
    position: normalizePosition(source.position ?? { x: source.X, z: source.Z }),
    player: {
      guid: playerGuid !== null && playerGuid > 0 ? Math.floor(playerGuid) : null,
      userid: text(playerSource.userid ?? playerSource.UserID, 128) || null,
      distance: finiteNumber(playerSource.distance ?? playerSource.Distance ?? source.Distance),
      position: playerGuid !== null || playerSource.position !== undefined || source.Node_x !== undefined ? normalizePosition(playerPosition) : null,
    },
    inventory: normalizeInventory(source.inventory ?? source.Inventory),
    nearby: normalizeNearby(source.nearby ?? source.Entities ?? source.entities),
    world: {
      phase: text(worldSource.phase ?? worldSource.Phase ?? source.Phase, 24) || "unknown",
      isDay: Boolean(worldSource.isDay ?? worldSource.IsDay ?? source.IsDay),
      isDusk: Boolean(worldSource.isDusk ?? worldSource.IsDusk ?? source.IsDusk),
      isNight: Boolean(worldSource.isNight ?? worldSource.IsNight ?? source.IsNight),
    },
    currentAction: text(source.currentAction ?? source.CurrentAction, 64) || null,
    isBusy: Boolean(source.isBusy ?? source.IsBusy),
    isNearDanger: Boolean(source.isNearDanger ?? source.IsNearDanger),
  };
}

export function sanitizeChat(value: unknown): string {
  const normalized = text(value, MAX_CHAT_LENGTH);
  if (!normalized) {
    throw new ValidationError("Speech text is empty after filtering.");
  }
  return normalized;
}

export function isCommandKind(value: unknown): value is CommandKind {
  return typeof value === "string" && (COMMAND_KINDS as readonly string[]).includes(value);
}

export function isCommandPriority(value: unknown): value is CommandPriority {
  return typeof value === "string" && (COMMAND_PRIORITIES as readonly string[]).includes(value);
}

export function targetFromState(state: CompanionState | undefined, value: unknown, purpose: "gather" | "attack"): NearbyEntity | undefined {
  if (!state || typeof value !== "number" || !Number.isInteger(value)) {
    return undefined;
  }
  const candidate = state.nearby.find((entity) => entity.guid === value && entity.distance <= MAX_DISTANCE);
  if (!candidate) {
    return undefined;
  }
  if (purpose === "attack" && !candidate.attackable) {
    return undefined;
  }
  if (purpose === "gather" && !(candidate.collectable || candidate.choppable || candidate.mineable)) {
    return undefined;
  }
  return candidate;
}

export function validateCommandArgs(
  kind: CommandKind,
  rawArgs: unknown,
  state: CompanionState | undefined,
): Record<string, unknown> {
  const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs as Record<string, unknown> : {};
  if (kind === "say_in_game") {
    return { text: sanitizeChat(args.text) };
  }
  if (kind === "clear_action_queue" || kind === "stop_and_wait" || kind === "follow_player") {
    return {};
  }
  if (!state || Date.now() - state.receivedAt > 5_000) {
    throw new ValidationError("Game state is unavailable or stale.");
  }
  if (kind === "approach_or_retreat") {
    const mode = args.mode === "retreat" ? "retreat" : "approach";
    const targetGuid = typeof args.targetGuid === "number" ? Math.floor(args.targetGuid) : state.player.guid;
    if (targetGuid === null) {
      throw new ValidationError("No nearby player or target is available.");
    }
    const target = targetGuid === state.player.guid
      ? state.player.distance !== null && state.player.distance <= MAX_DISTANCE
      : state.nearby.some((entity) => entity.guid === targetGuid && entity.distance <= MAX_DISTANCE);
    if (!target) {
      throw new ValidationError("Approach target is not nearby.");
    }
    return { mode, targetGuid };
  }
  if (kind === "gather_nearby") {
    const mode = args.mode === "chop" || args.mode === "mine" ? args.mode : "collect";
    const targetGuid = typeof args.targetGuid === "number" ? Math.floor(args.targetGuid) : undefined;
    if (targetGuid !== undefined && !targetFromState(state, targetGuid, "gather")) {
      throw new ValidationError("Gather target is invalid or too far away.");
    }
    return { mode, ...(targetGuid === undefined ? {} : { targetGuid }) };
  }
  if (kind === "attack_nearby_threat") {
    const targetGuid = typeof args.targetGuid === "number" ? Math.floor(args.targetGuid) : undefined;
    if (targetGuid !== undefined && !targetFromState(state, targetGuid, "attack")) {
      throw new ValidationError("Attack target is invalid or too far away.");
    }
    return { ...(targetGuid === undefined ? {} : { targetGuid }) };
  }
  if (kind === "equip_or_eat") {
    const action = args.action === "equip" ? "equip" : "eat";
    const itemName = text(args.itemName, 64).toLowerCase();
    if (!itemName) {
      throw new ValidationError("An item name is required before equipping or eating.");
    }
    if (!state.inventory.some((item) => item.prefab.toLowerCase() === itemName)) {
      throw new ValidationError("The requested inventory item is unavailable.");
    }
    return { action, itemName };
  }
  if (kind === "give_item") {
    const itemName = text(args.itemName, 64);
    if (!itemName) {
      throw new ValidationError("An item name is required before giving an item.");
    }
    const quantity = Math.floor(boundedNumber(args.quantity, 1, 40, 1));
    if (!state.player.guid || state.player.distance === null || state.player.distance > MAX_DISTANCE) {
      throw new ValidationError("The player must be nearby before an item can be given.");
    }
    return { itemName, quantity };
  }
  throw new ValidationError("Unsupported command kind.");
}

export function boundedExpiry(now: number, ttlMs: unknown, kind: CommandKind): number {
  const defaultTtl = kind === "clear_action_queue" ? 5_000 : 15_000;
  const requested = typeof ttlMs === "number" && Number.isFinite(ttlMs) ? ttlMs : defaultTtl;
  return now + Math.max(1_000, Math.min(MAX_TTL_MS, requested));
}

export function isLikelyHostile(entity: NearbyEntity): boolean {
  const labels = [entity.prefab, ...entity.tags].join(" ").toLowerCase();
  return /monster|hostile|hound|spider|tentacle|frog|merm|hound|bee/.test(labels);
}
