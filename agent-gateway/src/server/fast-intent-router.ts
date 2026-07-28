import type { CommandKind, CompanionState, GatherMode, GatherScope, NearbyEntity } from "../shared/types.js";
import {
  findGatherVerb,
  findResourceMatches,
  normalizePrefab,
  type ResourceDefinition,
  type TextSpan,
} from "../shared/resource-lexicon.js";
import { MAX_FOLLOW_DISTANCE, MAX_MOVEMENT_DISTANCE, hasFreshState, isGatherTargetAvailable } from "./validation.js";

export type FastIntentName = "stop" | "follow" | "approach" | "gather_resource" | "attack" | "give_item" | "equip_or_eat";
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

interface FastIntentTextCandidate {
  intent: FastIntentName;
  span: TextSpan;
  resource?: ResourceDefinition;
  mode?: GatherMode;
  scope?: GatherScope;
  itemPrefab?: string;
  equipAction?: "equip" | "eat";
}

type FastIntentTextAnalysis =
  | { status: "matched"; candidate: FastIntentTextCandidate }
  | FastIntentBlock
  | { status: "none" };

const ALL_TOKENS = ["所有", "全部", "全都", "都", "统统", "all", "every"];
const RESIDUAL_EDGE_PUNCTUATION = /(?:^[\s,.;:!?，。！？、]+|[\s,.;:!?，。！？、]+$)/g;
const RESIDUAL_LEADING_ENGLISH = /^(?:please|pls|kindly|can you|could you|would you|and|then|also|plus)\b[\s,.;:!?，。！？、]*/i;
const RESIDUAL_TRAILING_ENGLISH = /[\s,.;:!?，。！？、]*(?:and|then|also|plus)$/i;
const RESIDUAL_LEADING_CHINESE = /^(?:请|麻烦|帮我|帮忙|劳驾|然后|再|顺便|并且|和|以及|还有|把|给我|去|了|吧|一下|都|全部|所有)[\s,.;:!?，。！？、]*/u;
const RESIDUAL_TRAILING_CHINESE = /[\s,.;:!?，。！？、]*(?:然后|再|顺便|并且|和|以及|还有|把|给我|去|了|吧|一下|都|全部|所有)$/u;
const HIGH_RISK_TEXT = /攻击|打(?:一下|死)?|杀|喂|吃|装备|穿|丢|drop|attack|kill|hit|fight|feed|eat|equip/i;

const STOP_PATTERNS = [
  /\b(?:stop|cancel|halt)\b/i,
  /\b(?:wait there|wait here|hold position|hold still)\b/i,
  /停(?:止|下来?|一下|一停|手|停)?|别动|不要动|站住|别走了?|别乱跑|慢着|且慢|别跟|不要跟|不跟了/u,
  /(?:别|不要|不用)(?:再)?(?:采|采集|收集|捡|拾|摘|拿|砍|挖)/u,
  /\bstop\s+(?:gathering|collecting|picking|chopping|mining)\b/i,
];
const FOLLOW_PATTERNS = [
  /过来跟(?:着)?我?|跟着(?:我|点|走|过来|好)?|跟过来|跟随我?|跟我|跟上|跟紧|跟好|跟住|随我/u,
  /\bfollow(?:\s+me)?\b/i,
];
const APPROACH_PATTERNS = [
  /靠近我|靠过来|来我这里?|来我身边|到我这里?|到我身边|我身边|我这边|上前来?|过来/u,
  /\b(?:come here|come to me|approach me)\b/i,
];
// Attack targets the nearest hostile automatically (no target arg needed); the
// Lua brain only engages actual threats.
const ATTACK_PATTERNS = [
  /攻击|揍|打(?:死|倒|怪|跑|退|败|它|他|她|那|这)|杀(?:死|掉|了)?|干掉|干死|收拾|消灭|反击|保护我/u,
  /\b(?:attack|kill|fight|defend me)\b/i,
];
const GIVE_PATTERNS = [
  /给我|给你|丢给我|递给我|拿给我|扔给我/u,
  /\b(?:give (?:me|it)|hand (?:me|over)|drop it)\b/i,
];
const EAT_PATTERNS = [/吃(?:掉|一口|点|个)?|恰/u, /\beat\b/i];
const EQUIP_PATTERNS = [/装备|装上|穿上|穿好|拿起|举起|握住/u, /\b(?:equip|wear|hold)\b/i];

// Compact inventory-item lexicon for give / equip / eat. Longest word wins.
const ITEM_LEXICON: { prefab: string; words: string[] }[] = [
  { prefab: "torch", words: ["火把", "火炬", "torch"] },
  { prefab: "cookedmeat", words: ["熟肉", "烤肉", "cooked meat"] },
  { prefab: "meat", words: ["生肉", "肉", "meat"] },
  { prefab: "log", words: ["木头", "原木", "木材", "log"] },
  { prefab: "twigs", words: ["树枝", "小树枝", "twigs"] },
  { prefab: "cutgrass", words: ["干草", "割下的草", "cut grass"] },
  { prefab: "flint", words: ["燧石", "火石", "flint"] },
  { prefab: "rocks", words: ["石头", "岩石", "石块", "rocks", "rock"] },
  { prefab: "goldnugget", words: ["金块", "金子", "黄金", "gold"] },
  { prefab: "berries", words: ["浆果", "莓果", "berries"] },
  { prefab: "carrot", words: ["胡萝卜", "萝卜", "carrot"] },
  { prefab: "axe", words: ["斧头", "斧子", "axe"] },
  { prefab: "pickaxe", words: ["十字镐", "镐", "pickaxe"] },
  { prefab: "spear", words: ["长矛", "矛", "spear"] },
  { prefab: "footballhat", words: ["猪皮帽", "足球帽", "football helmet"] },
  { prefab: "armorwood", words: ["木甲", "木质护甲", "log suit"] },
];
const ITEM_WORDS: { prefab: string; word: string }[] = ITEM_LEXICON
  .flatMap((entry) => entry.words.map((word) => ({ prefab: entry.prefab, word: word.toLowerCase() })))
  .sort((a, b) => b.word.length - a.word.length);

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
      return routeGatherIntent(
        textRoute.candidate.resource,
        textRoute.candidate.mode ?? textRoute.candidate.resource.mode,
        textRoute.candidate.scope ?? "single",
        state,
        now,
        residualText,
      );
    }

    if (textRoute.candidate.intent === "attack") {
      if (!hasFreshState(state, now)) {
        return { status: "blocked", intent: "attack", reason: "stale_state" };
      }
      // No target arg: the Lua brain engages the nearest actual hostile only.
      return {
        status: "matched",
        intent: "attack",
        reason: "attack_threat",
        command: { kind: "attack_nearby_threat", args: {} },
        ...(residualText ? { residualText } : {}),
      };
    }

    if (textRoute.candidate.intent === "give_item" && textRoute.candidate.itemPrefab) {
      if (!hasFreshState(state, now)) {
        return { status: "blocked", intent: "give_item", reason: "stale_state" };
      }
      if (!state.player.guid || state.player.distance === null || state.player.distance > MAX_MOVEMENT_DISTANCE) {
        return { status: "blocked", intent: "give_item", reason: "target_unavailable" };
      }
      return {
        status: "matched",
        intent: "give_item",
        reason: "give_item",
        command: { kind: "give_item", args: { itemName: textRoute.candidate.itemPrefab, quantity: 1 } },
        ...(residualText ? { residualText } : {}),
      };
    }

    if (textRoute.candidate.intent === "equip_or_eat" && textRoute.candidate.itemPrefab && textRoute.candidate.equipAction) {
      if (!hasFreshState(state, now)) {
        return { status: "blocked", intent: "equip_or_eat", reason: "stale_state" };
      }
      const itemPrefab = textRoute.candidate.itemPrefab;
      if (!state.inventory.some((item) => item.prefab.toLowerCase() === itemPrefab)) {
        return { status: "blocked", intent: "equip_or_eat", reason: "target_unavailable" };
      }
      return {
        status: "matched",
        intent: "equip_or_eat",
        reason: textRoute.candidate.equipAction === "eat" ? "eat_item" : "equip_item",
        command: { kind: "equip_or_eat", args: { action: textRoute.candidate.equipAction, itemName: itemPrefab } },
        ...(residualText ? { residualText } : {}),
      };
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
  addCandidate(candidates, findAttackCandidate(rawText, normalizedText));
  addCandidate(candidates, findGiveCandidate(rawText, normalizedText));
  addCandidate(candidates, findEquipEatCandidate(rawText, normalizedText));
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
  resource: ResourceDefinition,
  mode: GatherMode,
  scope: GatherScope,
  state: CompanionState | undefined,
  now: number,
  residualText: string,
): FastIntentResult {
  // Only freshness gates the deterministic path now. Whether a matching entity
  // is currently within the reported nearby radius is decided by the Lua brain,
  // which searches a wider radius and walks the companion to the resource. This
  // removes the old "识别不到/太远" dead-end for resources just out of range.
  if (!hasFreshState(state, now)) {
    return { status: "blocked", intent: "gather_resource", reason: "stale_state" };
  }
  const targetPrefab = normalizePrefab(resource.prefabs[0]);
  const visible = nearestInFamilyTarget(state, resource, mode);
  return {
    status: "matched",
    intent: "gather_resource",
    reason: `gather_${resource.name}`,
    command: {
      kind: "gather_nearby",
      args: {
        mode,
        scope,
        targetPrefab,
        ...(visible ? { targetGuid: visible.guid } : {}),
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
  if (!isApproachIntent(normalizedText) || isFollowIntent(normalizedText)) {
    // "过来跟着我" / "跟过来" mean follow; let follow win over a bare approach.
    return undefined;
  }
  const span = firstPatternSpan(rawText, APPROACH_PATTERNS);
  return span ? { intent: "approach", span } : undefined;
}

function findItemMatch(rawText: string): { prefab: string; span: TextSpan } | undefined {
  const lower = rawText.toLowerCase();
  for (const { prefab, word } of ITEM_WORDS) {
    const index = lower.indexOf(word);
    if (index >= 0) {
      return { prefab, span: { start: index, end: index + word.length } };
    }
  }
  return undefined;
}

function findAttackCandidate(rawText: string, _normalizedText: string): FastIntentTextCandidate | undefined {
  const span = firstPatternSpan(rawText, ATTACK_PATTERNS);
  return span ? { intent: "attack", span } : undefined;
}

function findGiveCandidate(rawText: string, _normalizedText: string): FastIntentTextCandidate | undefined {
  const verb = firstPatternSpan(rawText, GIVE_PATTERNS);
  if (!verb) {
    return undefined;
  }
  const item = findItemMatch(rawText);
  if (!item) {
    return undefined;
  }
  return { intent: "give_item", span: coveringSpan([verb, item.span]), itemPrefab: item.prefab };
}

function findEquipEatCandidate(rawText: string, _normalizedText: string): FastIntentTextCandidate | undefined {
  const eatSpan = firstPatternSpan(rawText, EAT_PATTERNS);
  const equipSpan = firstPatternSpan(rawText, EQUIP_PATTERNS);
  const verb = eatSpan ?? equipSpan;
  if (!verb) {
    return undefined;
  }
  const item = findItemMatch(rawText);
  if (!item) {
    return undefined;
  }
  return {
    intent: "equip_or_eat",
    span: coveringSpan([verb, item.span]),
    itemPrefab: item.prefab,
    equipAction: eatSpan ? "eat" : "equip",
  };
}

function findGatherCandidate(
  rawText: string,
  _normalizedText: string,
): { status: "matched"; candidate: FastIntentTextCandidate } | FastIntentBlock | { status: "none" } {
  const verb = findGatherVerb(rawText);
  if (!verb) {
    return { status: "none" };
  }
  const resources = findResourceMatches(rawText, verb.mode);
  if (resources.length !== 1) {
    // A gather verb with zero or several distinct resources needs a concise
    // model clarification, e.g. "采集" alone or "采草和树枝".
    return { status: "blocked", intent: "gather_resource", reason: "ambiguous_intent" };
  }
  const match = resources[0]!;
  const allToken = firstTokenSpan(rawText, ALL_TOKENS);
  const span = coveringSpan([verb.span, match.span, ...(allToken ? [allToken] : [])]);
  return {
    status: "matched",
    candidate: {
      intent: "gather_resource",
      span,
      resource: match.resource,
      mode: match.mode,
      scope: allToken ? "all_same_prefab" : "single",
    },
  };
}

function normalizeInputText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[　\s]+/g, " ")
    .replace(/[，。！？、,.!?;:]/g, " ")
    .trim();
}

function residualAfterRemovingSpan(text: string, span: TextSpan): string {
  return normalizeResidualText(`${text.slice(0, span.start)} ${text.slice(span.end)}`);
}

function normalizeResidualText(value: string): string {
  let text = value.replace(/[　\s]+/g, " ").replace(RESIDUAL_EDGE_PUNCTUATION, "").trim();
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
  if (/别停|不要停|不用停|不停/.test(text)) {
    return false;
  }
  return /(^|\s)(stop|cancel|halt)(\s|$)/.test(text)
    || /(^|\s)(?:wait there|wait here|hold position|hold still)(\s|$)/.test(text)
    || /停(?:止|下来?|一下|一停|手|停)?|别动|不要动|站住|别走|别乱跑|慢着|且慢|别跟|不跟了/.test(text)
    || /(?:别|不要|不用)(?:再)?(?:采|采集|收集|捡|拾|摘|拿|砍|挖)/.test(text)
    || /(^|\s)stop (?:gathering|collecting|picking|chopping|mining)(\s|$)/.test(text);
}

function isFollowIntent(text: string): boolean {
  if (/别跟|不要跟|不用跟|不跟/.test(text)) {
    return false;
  }
  return /跟着(?:我|点|走|过来|好)?|跟过来|跟随我?|跟我|跟上|跟紧|跟好|跟住|随我/.test(text)
    || /(^|\s)follow(?: me)?(\s|$)/.test(text);
}

function isApproachIntent(text: string): boolean {
  return /过来|靠近我|靠过来|来我这里?|来我身边|到我这里?|到我身边|我身边|我这边|上前来?/.test(text)
    || /(^|\s)(come here|come to me|approach me)(\s|$)/.test(text);
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
  return /(?:别|不要|不用)(?:再)?(?:采|采集|收集|捡|拾|摘|拿|砍|挖)/.test(text)
    || /(^|\s)stop (?:gathering|collecting|picking|chopping|mining)(\s|$)/.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nearestInFamilyTarget(
  state: CompanionState,
  resource: ResourceDefinition,
  mode: GatherMode,
): NearbyEntity | undefined {
  const allowed = new Set(resource.prefabs.map(normalizePrefab));
  return state.nearby
    .filter((entity) => allowed.has(normalizePrefab(entity.prefab)) && isGatherTargetAvailable(state, entity, mode))
    .sort((left, right) => left.distance - right.distance || left.guid - right.guid)[0];
}
