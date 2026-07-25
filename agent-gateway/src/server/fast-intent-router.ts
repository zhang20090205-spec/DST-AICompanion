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
  residualText?: string;
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

interface TextSpan {
  start: number;
  end: number;
}

interface FastIntentTextCandidate {
  intent: FastIntentName;
  span: TextSpan;
  resource?: ResourceIntent;
  scope?: GatherScope;
}

type FastIntentTextAnalysis =
  | { status: "matched"; candidate: FastIntentTextCandidate }
  | FastIntentBlock
  | { status: "none" };

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
const RESIDUAL_EDGE_PUNCTUATION = /(?:^[\s,.;:!?，。！？、]+|[\s,.;:!?，。！？、]+$)/g;
const RESIDUAL_LEADING_ENGLISH = /^(?:please|pls|kindly|can you|could you|would you|and|then|also|plus)\b[\s,.;:!?，。！？、]*/i;
const RESIDUAL_TRAILING_ENGLISH = /[\s,.;:!?，。！？、]*(?:and|then|also|plus)$/i;
const RESIDUAL_LEADING_CHINESE = /^(?:请|麻烦|帮我|帮忙|劳驾|然后|再|顺便|并且|和|以及|还有|把|给我|去|了|吧|一下|都|全部|所有)[\s,.;:!?，。！？、]*/u;
const RESIDUAL_TRAILING_CHINESE = /[\s,.;:!?，。！？、]*(?:然后|再|顺便|并且|和|以及|还有|把|给我|去|了|吧|一下|都|全部|所有)$/u;
const HIGH_RISK_TEXT = /攻击|打(?:一下|死)?|杀|砍(?:他|它)?|喂|吃|装备|穿|丢|drop|attack|kill|hit|fight|feed|eat|equip/i;

const STOP_PATTERNS = [
  /\b(?:stop|cancel|halt)\b/i,
  /\b(?:wait there|wait here|hold position|hold still)\b/i,
  /停止|停下|停一停|停一下|先停|别动|不要动|站住|别跟|不要跟|不跟了/u,
  /(?:别|不要|不用)(?:再)?(?:采|采集|收集|捡|拾|摘|拿)/u,
  /\bstop\s+(?:gathering|collecting|picking)\b/i,
];
const FOLLOW_PATTERNS = [
  /跟着我|跟随我|跟我|跟上|跟紧|随我/u,
  /\bfollow(?:\s+me)?\b/i,
];
const APPROACH_PATTERNS = [
  /靠近我|靠过来|来我这里|来我这|到我这里|到我这|过来/u,
  /\b(?:come here|come to me|approach me)\b/i,
];

export class FastIntentRouter {
  route(rawText: string, state: CompanionState | undefined, now = Date.now()): FastIntentResult {
    const text = normalizeInputText(rawText);
    if (!text) {
      return { status: "none" };
    }

    const textRoute = analyzeIntentText(rawText, text);
    if (textRoute.status !== "matched") {
      return textRoute;
    }

    const residualText = residualAfterRemovingSpan(rawText, textRoute.candidate.span);
    if (residualText) {
      const residualRoute = analyzeIntentText(residualText, normalizeInputText(residualText));
      if (residualRoute.status !== "none" || HIGH_RISK_TEXT.test(residualText)) {
        return { status: "blocked", intent: textRoute.candidate.intent, reason: "ambiguous_intent" };
      }
    }

    if (textRoute.candidate.intent === "stop") {
      return {
        status: "matched",
        intent: "stop",
        reason: "player_stop",
        command: { kind: "clear_action_queue", args: { reason: "player_stop" } },
        ...(residualText ? { residualText } : {}),
      };
    }

    if (textRoute.candidate.intent === "follow") {
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
        ...(residualText ? { residualText } : {}),
      };
    }

    if (textRoute.candidate.intent === "approach") {
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
        ...(residualText ? { residualText } : {}),
      };
    }

    if (textRoute.candidate.intent === "gather_resource" && textRoute.candidate.resource) {
      return routeGatherIntent(textRoute.candidate.resource, textRoute.candidate.scope ?? "single", state, now, residualText);
    }

    return { status: "none" };
  }
}

function analyzeIntentText(rawText: string, normalizedText: string): FastIntentTextAnalysis {
  const candidates: FastIntentTextCandidate[] = [];
  const stop = findStopCandidate(rawText, normalizedText);
  addCandidate(candidates, stop);
  addCandidate(candidates, findFollowCandidate(rawText, normalizedText));
  addCandidate(candidates, findApproachCandidate(rawText, normalizedText));
  const gather = findGatherCandidate(rawText, normalizedText);
  if (gather.status === "blocked" && !(stop && isGatherStopIntent(normalizedText))) {
    return gather;
  }
  if (gather.status === "matched") {
    addCandidate(candidates, gather.candidate);
  }

  if (candidates.length === 0) {
    return { status: "none" };
  }
  if (candidates.length > 1) {
    return { status: "blocked", intent: candidates[0]!.intent, reason: "ambiguous_intent" };
  }
  return { status: "matched", candidate: candidates[0]! };
}

function routeGatherIntent(
  resource: ResourceIntent,
  scope: GatherScope,
  state: CompanionState | undefined,
  now: number,
  residualText: string,
): FastIntentResult {
  if (!hasFreshState(state, now)) {
    return { status: "blocked", intent: "gather_resource", reason: "stale_state" };
  }
  const target = nearestCollectableTarget(state, resource.prefabs);
  if (!target) {
    return { status: "blocked", intent: "gather_resource", reason: "target_unavailable" };
  }
  return {
    status: "matched",
    intent: "gather_resource",
    reason: `gather_${resource.name}`,
    command: {
      kind: "gather_nearby",
      args: {
        mode: "collect",
        scope,
        targetGuid: target.guid,
        targetPrefab: normalizePrefabName(target.prefab),
      },
    },
    ...(residualText ? { residualText } : {}),
  };
}

function findStopCandidate(rawText: string, normalizedText: string): FastIntentTextCandidate | undefined {
  if (!isStopIntent(normalizedText)) {
    return undefined;
  }
  const span = firstPatternSpan(rawText, STOP_PATTERNS);
  return span ? { intent: "stop", span } : undefined;
}

function findFollowCandidate(rawText: string, normalizedText: string): FastIntentTextCandidate | undefined {
  if (!isFollowIntent(normalizedText)) {
    return undefined;
  }
  const span = firstPatternSpan(rawText, FOLLOW_PATTERNS);
  return span ? { intent: "follow", span } : undefined;
}

function findApproachCandidate(rawText: string, normalizedText: string): FastIntentTextCandidate | undefined {
  if (!isApproachIntent(normalizedText)) {
    return undefined;
  }
  const span = firstPatternSpan(rawText, APPROACH_PATTERNS);
  return span ? { intent: "approach", span } : undefined;
}

function findGatherCandidate(
  rawText: string,
  normalizedText: string,
): { status: "matched"; candidate: FastIntentTextCandidate } | FastIntentBlock | { status: "none" } {
  const verb = firstTokenSpan(rawText, GATHER_VERBS);
  if (!verb) {
    return { status: "none" };
  }
  const resources = RESOURCE_INTENTS
    .map((resource) => ({ resource, span: firstTokenSpan(rawText, resource.tokens) }))
    .filter((entry): entry is { resource: ResourceIntent; span: TextSpan } => Boolean(entry.span));
  if (resources.length !== 1) {
    return { status: "blocked", intent: "gather_resource", reason: "ambiguous_intent" };
  }
  const allToken = firstTokenSpan(rawText, ALL_TOKENS);
  const span = coveringSpan([verb, resources[0]!.span, ...(allToken ? [allToken] : [])]);
  return {
    status: "matched",
    candidate: {
      intent: "gather_resource",
      span,
      resource: resources[0]!.resource,
      scope: containsAny(normalizedText, ALL_TOKENS) ? "all_same_prefab" : "single",
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

function residualAfterRemovingSpan(text: string, span: TextSpan): string {
  return normalizeResidualText(`${text.slice(0, span.start)} ${text.slice(span.end)}`);
}

function normalizeResidualText(value: string): string {
  let text = value.replace(/[\u3000\s]+/g, " ").replace(RESIDUAL_EDGE_PUNCTUATION, "").trim();
  let previous = "";
  while (text && text !== previous) {
    previous = text;
    text = text
      .replace(RESIDUAL_LEADING_ENGLISH, "")
      .replace(RESIDUAL_TRAILING_ENGLISH, "")
      .replace(RESIDUAL_LEADING_CHINESE, "")
      .replace(RESIDUAL_TRAILING_CHINESE, "")
      .replace(RESIDUAL_EDGE_PUNCTUATION, "")
      .trim();
  }
  return text;
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

function addCandidate(candidates: FastIntentTextCandidate[], candidate: FastIntentTextCandidate | undefined): void {
  if (!candidate || candidates.some((existing) => spansOverlap(existing.span, candidate.span))) {
    return;
  }
  candidates.push(candidate);
}

function firstPatternSpan(text: string, patterns: RegExp[]): TextSpan | undefined {
  const spans = patterns.flatMap((pattern) => {
    const match = pattern.exec(text);
    return match?.index === undefined ? [] : [{ start: match.index, end: match.index + match[0].length }];
  });
  return firstSpan(spans);
}

function firstTokenSpan(text: string, tokens: string[]): TextSpan | undefined {
  const spans = [...tokens]
    .sort((left, right) => right.length - left.length)
    .flatMap((token) => tokenSpan(text, token) ?? []);
  return firstSpan(spans);
}

function tokenSpan(text: string, token: string): TextSpan | undefined {
  const escaped = escapeRegExp(token);
  const pattern = /^[A-Za-z0-9_ ]+$/.test(token)
    ? new RegExp(`(^|[^A-Za-z0-9_])(${escaped})(?=$|[^A-Za-z0-9_])`, "i")
    : new RegExp(escaped, "u");
  const match = pattern.exec(text);
  if (!match) {
    return undefined;
  }
  const prefix = match[1] ?? "";
  const value = match[2] ?? match[0];
  const start = match.index + prefix.length;
  return { start, end: start + value.length };
}

function firstSpan(spans: TextSpan[]): TextSpan | undefined {
  return spans
    .filter((span) => span.end > span.start)
    .sort((left, right) => left.start - right.start || (right.end - right.start) - (left.end - left.start))[0];
}

function coveringSpan(spans: TextSpan[]): TextSpan {
  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
  };
}

function spansOverlap(left: TextSpan, right: TextSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

function isGatherStopIntent(text: string): boolean {
  return /(?:别|不要|不用)(?:再)?(?:采|采集|收集|捡|拾|摘|拿)/.test(text)
    || /(^|\s)stop (?:gathering|collecting|picking)(\s|$)/.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
