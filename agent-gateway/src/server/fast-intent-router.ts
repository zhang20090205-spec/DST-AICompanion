import type { CommandKind, CompanionState, GatherScope, NearbyEntity } from "../shared/types.js";
import { MAX_FOLLOW_DISTANCE, MAX_MOVEMENT_DISTANCE, hasFreshState, isGatherTargetAvailable } from "./validation.js";

export type FastIntentName = "stop" | "follow" | "approach" | "gather_resource";
export type FastIntentBlockReason = "stale_state" | "ambiguous_intent" | "target_unavailable";

export interface FastIntentCommandPlan {
  kind: CommandKind;
  args: Record<string, unknown>;
}

export interface FastIntentMatch {
  status: "matched";
  intent: FastIntentName;
  reason: string;
  command: FastIntentCommandPlan;
}

export interface FastIntentBlock {
  status: "blocked";
  intent: FastIntentName;
  reason: FastIntentBlockReason;
}

export type FastIntentResult = FastIntentMatch | FastIntentBlock | { status: "none" };

interface ResourceIntent {
  name: "grass" | "berries" | "twigs";
  tokens: string[];
  prefabs: string[];
}

const RESOURCE_INTENTS: ResourceIntent[] = [
  {
    name: "grass",
    tokens: ["草", "干草", "grass"],
    prefabs: ["grass"],
  },
  {
    name: "berries",
    tokens: ["浆果", "莓果", "berries", "berry"],
    prefabs: ["berrybush", "berrybush_juicy", "berrybush2"],
  },
  {
    name: "twigs",
    tokens: ["树枝", "小树枝", "twigs", "twig"],
    prefabs: ["sapling", "sapling_moon"],
  },
];

const GATHER_VERBS = ["采集", "收集", "采", "捡", "拾", "摘", "拿", "gather", "collect", "pick"];
const ALL_TOKENS = ["所有", "全部", "全都", "都", "all", "every"];

export class FastIntentRouter {
  route(rawText: string, state: CompanionState | undefined, now = Date.now()): FastIntentResult {
    const text = normalizeInputText(rawText);
    if (!text) {
      return { status: "none" };
    }

    if (isStopIntent(text)) {
      return {
        status: "matched",
        intent: "stop",
        reason: "player_stop",
        command: { kind: "clear_action_queue", args: { reason: "player_stop" } },
      };
    }

    if (isFollowIntent(text)) {
      if (!hasFreshState(state, now)) {
        return { status: "blocked", intent: "follow", reason: "stale_state" };
      }
      if (!state.player.guid || state.player.distance === null || state.player.distance > MAX_FOLLOW_DISTANCE) {
        return { status: "blocked", intent: "follow", reason: "target_unavailable" };
      }
      return {
        status: "matched",
        intent: "follow",
        reason: "player_follow",
        command: { kind: "follow_player", args: {} },
      };
    }

    if (isApproachIntent(text)) {
      if (!hasFreshState(state, now)) {
        return { status: "blocked", intent: "approach", reason: "stale_state" };
      }
      if (!state.player.guid || state.player.distance === null || state.player.distance > MAX_MOVEMENT_DISTANCE) {
        return { status: "blocked", intent: "approach", reason: "target_unavailable" };
      }
      return {
        status: "matched",
        intent: "approach",
        reason: "player_approach",
        command: { kind: "approach_or_retreat", args: { mode: "approach", targetGuid: state.player.guid } },
      };
    }

    return routeGatherIntent(text, state, now);
  }
}

function routeGatherIntent(text: string, state: CompanionState | undefined, now: number): FastIntentResult {
  const hasGatherVerb = containsAny(text, GATHER_VERBS);
  const resources = RESOURCE_INTENTS.filter((resource) => containsAny(text, resource.tokens));
  if (!hasGatherVerb) {
    return { status: "none" };
  }
  if (resources.length !== 1) {
    return { status: "blocked", intent: "gather_resource", reason: "ambiguous_intent" };
  }
  if (!hasFreshState(state, now)) {
    return { status: "blocked", intent: "gather_resource", reason: "stale_state" };
  }
  const target = nearestCollectableTarget(state, resources[0]!.prefabs);
  if (!target) {
    return { status: "blocked", intent: "gather_resource", reason: "target_unavailable" };
  }
  const scope: GatherScope = containsAny(text, ALL_TOKENS) ? "all_same_prefab" : "single";
  return {
    status: "matched",
    intent: "gather_resource",
    reason: `gather_${resources[0]!.name}`,
    command: {
      kind: "gather_nearby",
      args: {
        mode: "collect",
        scope,
        targetGuid: target.guid,
        targetPrefab: normalizePrefabName(target.prefab),
      },
    },
  };
}

function normalizeInputText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u3000\s]+/g, " ")
    .replace(/[，。！？、,.!?;:]/g, " ")
    .trim();
}

function isStopIntent(text: string): boolean {
  if (/别停|不要停|不用停/.test(text)) {
    return false;
  }
  return /(^|\s)(stop|cancel|halt)(\s|$)/.test(text)
    || /(^|\s)(?:wait there|wait here|hold position|hold still)(\s|$)/.test(text)
    || /停止|停下|停一停|停一下|先停|别动|不要动|站住|别跟|不要跟|不跟了/.test(text)
    || /(?:别|不要|不用)(?:再)?(?:采|采集|收集|捡|拾|摘|拿)/.test(text)
    || /(^|\s)stop (?:gathering|collecting|picking)(\s|$)/.test(text);
}

function isFollowIntent(text: string): boolean {
  if (/别跟|不要跟|不用跟|不跟/.test(text)) {
    return false;
  }
  return /跟着我|跟随我|跟我|跟上|跟紧|随我/.test(text)
    || /(^|\s)follow(?: me)?(\s|$)/.test(text);
}

function isApproachIntent(text: string): boolean {
  return /过来|靠近我|靠过来|来我这|来我这里|到我这|到我这里/.test(text)
    || /(^|\s)(come here|come to me|approach me)(\s|$)/.test(text);
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((token) => text.includes(token));
}

function nearestCollectableTarget(state: CompanionState, prefabs: string[]): NearbyEntity | undefined {
  const allowed = new Set(prefabs);
  return state.nearby
    .filter((entity) => allowed.has(normalizePrefabName(entity.prefab)) && isGatherTargetAvailable(state, entity, "collect"))
    .sort((left, right) => left.distance - right.distance || left.guid - right.guid)[0];
}

function normalizePrefabName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
}
