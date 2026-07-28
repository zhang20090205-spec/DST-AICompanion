import type { GatherMode } from "./types.js";

// The resource lexicon is the single source of truth for turning a spoken
// Chinese (or English) resource word into a canonical DST prefab set and a
// gather mode. It is shared by the deterministic fast-intent router and mirrored
// by the local knowledge document so the model and the router agree on names.
//
// Design choices:
//   * Multiple prefabs per resource (berry-bush variants, boulder variants) so a
//     spoken "浆果" matches every kind of berry bush the world may spawn.
//   * Curated homophone / near-form tokens instead of a pinyin dependency, so
//     common ASR errors (姜果→浆果, 树支→树枝) still route deterministically.
//   * A default mode per resource; an explicit verb (砍/挖) can still override it.

export interface ResourceDefinition {
  /** Canonical resource id used for logging and outcome labels. */
  name: string;
  /** Chinese label for trusted voice/chat feedback. */
  label: string;
  /** Chinese measure word for the label. */
  unit: string;
  /** Default gather mode when the verb does not force chop/mine. */
  mode: GatherMode;
  /** Canonical prefab names (lowercase, `_`-separated) this resource can be. */
  prefabs: string[];
  /** Recognized substrings, including curated homophones/near-forms. */
  tokens: string[];
}

export interface TextSpan {
  start: number;
  end: number;
}

export interface ResourceMatch {
  resource: ResourceDefinition;
  mode: GatherMode;
  span: TextSpan;
  token: string;
}

export const RESOURCE_LEXICON: ResourceDefinition[] = [
  {
    name: "grass",
    label: "草",
    unit: "丛",
    mode: "collect",
    prefabs: ["grass"],
    tokens: ["草丛", "干草", "杂草", "青草", "草", "grass"],
  },
  {
    name: "berries",
    label: "浆果",
    unit: "丛",
    mode: "collect",
    prefabs: ["berrybush", "berrybush2", "berrybush_juicy"],
    // 浆果/桨果/姜果/僵果/江果/酱果 are the common Chinese ASR variants.
    tokens: ["浆果", "桨果", "姜果", "僵果", "江果", "酱果", "莓果", "浆果丛", "berries", "berry"],
  },
  {
    name: "twigs",
    label: "树枝",
    unit: "丛",
    mode: "collect",
    prefabs: ["sapling", "sapling_moon"],
    tokens: ["小树枝", "树枝", "树杈", "树支", "树苗", "sapling", "twigs", "twig"],
  },
  {
    name: "carrot",
    label: "胡萝卜",
    unit: "个",
    mode: "collect",
    prefabs: ["carrot", "carrot_planted"],
    tokens: ["胡萝卜", "萝卜", "carrot"],
  },
  {
    name: "reeds",
    label: "芦苇",
    unit: "丛",
    mode: "collect",
    prefabs: ["reeds"],
    tokens: ["芦苇", "苇子", "reeds", "reed"],
  },
  {
    name: "flower",
    label: "花",
    unit: "朵",
    mode: "collect",
    prefabs: ["flower", "flower_evil"],
    tokens: ["花朵", "鲜花", "花", "flower"],
  },
  {
    name: "tree",
    label: "树",
    unit: "棵",
    mode: "chop",
    prefabs: ["evergreen", "evergreen_sparse", "deciduoustree", "twiggytree"],
    // "树枝"/"树苗" belong to the twigs resource; overlap is resolved by
    // preferring the longest matched token, so bare "树" only wins on its own.
    tokens: ["常青树", "桦栗树", "桦树", "松树", "杉树", "多枝树", "大树", "树木", "树", "tree"],
  },
  {
    name: "rock",
    label: "岩石",
    unit: "块",
    mode: "mine",
    prefabs: ["rock1", "rock2", "rock_flintless", "rock_moon"],
    tokens: ["岩石", "石头", "石块", "石矿", "矿石", "巨石", "金矿", "矿", "rock", "boulder"],
  },
];

// Generic verbs do not force a mode; the resource's default mode is used.
export const COLLECT_VERBS = [
  "采集", "收集", "采", "摘", "捡", "拾", "拔", "薅", "割", "收", "gather", "collect", "pick", "harvest",
];
// Explicit work verbs override the resource default mode.
export const CHOP_VERBS = ["砍", "伐", "劈", "锯", "chop"];
export const MINE_VERBS = ["挖", "凿", "采矿", "采石", "铲", "mine"];

const VERB_MODE: Array<{ tokens: string[]; mode: GatherMode | undefined }> = [
  { tokens: CHOP_VERBS, mode: "chop" },
  { tokens: MINE_VERBS, mode: "mine" },
  { tokens: COLLECT_VERBS, mode: undefined },
];

export function normalizePrefab(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function longestTokenSpan(text: string, tokens: string[]): { span: TextSpan; token: string } | undefined {
  let best: { span: TextSpan; token: string } | undefined;
  for (const token of tokens) {
    const span = tokenSpan(text, token);
    if (!span) {
      continue;
    }
    const length = span.end - span.start;
    if (!best || length > best.span.end - best.span.start) {
      best = { span, token };
    }
  }
  return best;
}

function spansOverlap(left: TextSpan, right: TextSpan): boolean {
  return left.start < right.end && right.start < left.end;
}

/**
 * Find the explicit work verb mode present in the text, if any. Longer verbs
 * (采矿) are preferred over their prefixes (采) so a mining verb is not misread
 * as a generic collect verb.
 */
export function findGatherVerb(text: string): { span: TextSpan; mode: GatherMode | undefined } | undefined {
  const all = VERB_MODE.flatMap((entry) =>
    entry.tokens.map((token) => ({ token, mode: entry.mode })),
  );
  let best: { span: TextSpan; mode: GatherMode | undefined; length: number } | undefined;
  for (const { token, mode } of all) {
    const span = tokenSpan(text, token);
    if (!span) {
      continue;
    }
    const length = span.end - span.start;
    if (!best || length > best.length) {
      best = { span, mode, length };
    }
  }
  return best ? { span: best.span, mode: best.mode } : undefined;
}

/**
 * Return every resource that appears in the text, keeping only the
 * longest-token match per resource and dropping matches whose span is contained
 * inside a longer match of another resource (so "树枝" suppresses bare "树").
 */
export function findResourceMatches(text: string, verbMode?: GatherMode): ResourceMatch[] {
  const raw: ResourceMatch[] = [];
  for (const resource of RESOURCE_LEXICON) {
    const found = longestTokenSpan(text, resource.tokens);
    if (found) {
      raw.push({
        resource,
        mode: verbMode ?? resource.mode,
        span: found.span,
        token: found.token,
      });
    }
  }
  // Drop a match that overlaps a strictly longer match (e.g. 树 inside 树枝).
  return raw.filter((candidate) =>
    !raw.some((other) =>
      other !== candidate
      && spansOverlap(candidate.span, other.span)
      && (other.span.end - other.span.start) > (candidate.span.end - candidate.span.start)),
  );
}
