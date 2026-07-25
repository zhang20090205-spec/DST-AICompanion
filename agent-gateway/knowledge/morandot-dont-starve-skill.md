---
title: DST survival decision guide
source: morandot/dont-starve-skill
source_file: dont-starve-skill/SKILL.md
commit: 12dc27d3b6d0a261f0fbd14a046d492cba8c6e27
license: MIT
copyright: Copyright (c) 2026 moran
upstream: https://github.com/morandot/dont-starve-skill
---

# DST Survival Decision Guide

This local knowledge package is a derived, source-marked survival guide built
from the upstream Agent Skill. It is retrieved through SQLite FTS only; it is
not injected wholesale into the Realtime system instructions.

## Decision Order

Make the next survival decision before explaining it. Check light before night,
food before long work, and health, hunger, and sanity before taking combat or
travel risks. When conditions are unclear, choose a short reversible action and
report the condition that would change the plan.

## Seasonal Preparation

Prepare seasonal essentials before the season arrives. Keep a light source,
food, basic healing, and a safe retreat plan available. Treat version and game
mode as important context: mechanics differ between Don\'t Starve, DST, and
the DLCs, so do not present an uncertain detail as universal.

## Combat And Recovery

For bosses and nearby threats, state the decision, the prerequisites, the
escape route, and the recovery path. Avoid turning an uncertain encounter into
a command. The companion should protect against nearby hostile threats only;
non-hostile attacks, long travel, building, crafting, and rare-resource use
need an explicit player confirmation.

## Base, Food, And Team Play

Use build order, substitution options, and failure points rather than a bare
checklist. Cooking advice should name substitutions instead of inventing exact
recipe values. In DST, coordinate roles and proximity with the player; keep
the companion close, collect only nearby ordinary resources, and stop when the
player interrupts.

## Gathering And Resource Lexicon

Ordinary gathering is a low-risk action. Map a spoken resource word to a gather
mode and its prefab family, then use `gather_nearby`. `collect` picks a bush or
plant, `chop` fells a tree, `mine` breaks a boulder. The companion may walk a
short leash from the player to reach the resource; only report "附近没有 X"
after a trusted failed result, never as a guess.

| 说法 (spoken) | mode | prefab family |
| --- | --- | --- |
| 草 / 干草 / grass | collect | grass |
| 浆果 / 莓果 / berries (含 姜果/桨果 等口误) | collect | berrybush, berrybush2, berrybush_juicy |
| 树枝 / 小树枝 / 树苗 / twigs | collect | sapling, sapling_moon |
| 胡萝卜 / carrot | collect | carrot, carrot_planted |
| 芦苇 / reeds | collect | reeds |
| 花 / flower | collect | flower, flower_evil |
| 树 / 常青树 / 桦树 / 多枝树 / tree | chop | evergreen, evergreen_sparse, deciduoustree, twiggytree |
| 石头 / 岩石 / 巨石 / 矿石 / rock | mine | rock1, rock2, rock_flintless, rock_moon |

Verbs disambiguate mode: 采/收集/摘/捡 → collect, 砍/伐/劈 → chop, 挖/凿/采矿 →
mine. "全部/都/所有" means gather every same-family resource nearby
(`scope=all_same_prefab`); otherwise gather one. Bulk winter and combat prep
often starts here: grass and twigs for torches and tools, logs for fire and
building, rocks and flint for the science machine and pickaxe.

## Answer Quality

Separate stable game facts from subjective preference. Ask for a spoiler level
before lore details. Do not invent patch notes, numbers, mod compatibility, or
official text. Do not provide piracy, cheating, or server-fairness-breaking
guidance.

## Attribution

Source: `morandot/dont-starve-skill`, pinned commit
`12dc27d3b6d0a261f0fbd14a046d492cba8c6e27`, source file
`dont-starve-skill/SKILL.md`. Licensed under MIT. The upstream copyright and
permission notice is retained in `LICENSE-morandot-dont-starve-skill.txt`.
