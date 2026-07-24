import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const modRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readModFile(...segments) {
  return readFile(path.join(modRoot, ...segments), "utf8");
}

test("runtime uses GPT Agent brain while preserving the legacy FAtiMA brain file", async () => {
  const modmain = await readModFile("modmain.lua");
  const legacy = await readModFile("scripts", "brains", "fatimabrain.lua");
  const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

  assert.match(modmain, /GLOBAL\.require "brains\/gptagentbrain"/);
  assert.match(legacy, /return FAtiMABrain/);
  assert.match(gpt, /local LegacyBrain = require "brains\/fatimabrain"/);
	assert.match(modmain, /local companion_count = math\.min\(1, math\.max\(0, requested_companion_count\)\)/);
});

test("GPT Agent brain speaks the locked gateway protocol", async () => {
  const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

  for (const path of [
    "/api/dst/v1/companions/",
    "/state",
    "/commands",
    "/results",
    "/player-input",
  ]) {
    assert.match(gpt, new RegExp(path.replaceAll("/", "\\/")));
  }

  assert.match(gpt, /local COMMAND_POLL_INTERVAL = 0\.25/);
  assert.match(gpt, /self\.inst:DoPeriodicTask\(COMMAND_POLL_INTERVAL, self\.OnCommandPoll, 0\)/);
});

test("GPT Agent command validation covers kind priority epoch and ttl", async () => {
  const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

  for (const kind of [
    "say_in_game",
    "follow_player",
    "stop_and_wait",
    "approach_or_retreat",
    "gather_nearby",
    "attack_nearby_threat",
    "equip_or_eat",
    "give_item",
    "clear_action_queue",
  ]) {
    assert.match(gpt, new RegExp(`${kind} = true`));
  }

  assert.match(gpt, /COMMAND_PRIORITIES/);
  assert.match(gpt, /command\.epoch < self\.GatewayEpoch/);
  assert.match(gpt, /command\.expiresAt <= NowMs\(\)/);
  assert.match(gpt, /ExpireActiveCommand/);
});

test("GPT Agent reports compact state and command results", async () => {
  const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

  for (const field of [
    "health",
    "hunger",
    "sanity",
    "temperature",
    "position",
    "player",
    "inventory",
    "nearby",
    "world",
    "currentAction",
    "isBusy",
    "isNearDanger",
  ]) {
    assert.match(gpt, new RegExp(`${field} =`));
  }

  assert.match(gpt, /status = status/);
  assert.match(gpt, /stateRevision = self\.StateRevision or 0/);
  assert.match(gpt, /"started"/);
  assert.match(gpt, /"succeeded"/);
  assert.match(gpt, /"failed"/);
  assert.match(gpt, /"cancelled"/);
});

test("GPT Agent dispatch is whitelisted and does not execute dynamic code", async () => {
  const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

  assert.match(gpt, /function GPTAgentBrain:ApplyCommand\(command\)/);
  assert.match(gpt, /SetCurrentCommandAction/);
  assert.match(gpt, /InterruptLocalAction/);
  assert.match(gpt, /function GPTAgentBrain:QueueTextCommand\(text, userid\)/);
  assert.match(gpt, /function GPTAgentBrain:SayAI\(text\)/);
  assert.match(gpt, /TheNet:SystemMessage\("\[AI\] " \.\. text\)/);

  assert.doesNotMatch(gpt, /\bloadstring\b|\bload\b|\bdofile\b|\bsetfenv\b|\bgetfenv\b/);
});

test("GPT Agent keeps one runtime brain and safely interrupts risky actions", async () => {
  const modmain = await readModFile("modmain.lua");
  const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

  assert.doesNotMatch(modmain, /CHEATS_ENABLED|sanitybadge|fatimabrain/);
  assert.match(gpt, /function GPTAgentBrain:DropCommandCombatTarget\(\)/);
  assert.match(gpt, /combat:DropTarget\(\)/);
  assert.match(gpt, /function GPTAgentBrain:ValidateAttackTarget\(target, confirmed\)/);
  assert.match(gpt, /args\.confirmed == true/);
  assert.match(gpt, /\["停下"\] = true/);
  assert.match(gpt, /self\.PlayerInputSequence = \(self\.PlayerInputSequence or 0\) \+ 1/);
	assert.match(gpt, /cannot give partial stack quantity safely/);
	assert.match(gpt, /AI_SPEECH_MIN_INTERVAL_MS/);
});

test("GPT Agent cancels every legacy periodic FAtiMA task before its own loop runs", async () => {
	const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

	for (const task of ["PerceptionsTask", "DSTActionTask", "SpeakActionTask", "visiontask"]) {
		assert.match(gpt, new RegExp(`if self\\.${task} ~= nil then\\s+self\\.${task}:Cancel\\(\\)`, "m"));
	}
	assert.match(gpt, /local STATE_POST_INTERVAL = 0\.5/);
	assert.match(gpt, /self\.GatewayStateTask = self\.inst:DoPeriodicTask\(STATE_POST_INTERVAL, self\.OnGatewayStatePost, 0\)/);
	assert.match(gpt, /function GPTAgentBrain:OnStop\(\)/);
});

test("GPT Agent replaces legacy autonomous behavior with its command-gated tree", async () => {
	const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

	assert.match(gpt, /function GPTAgentBrain:CreateGPTActionTree\(\)/);
	assert.match(gpt, /self:CreateGPTActionTree\(\)/);
	assert.match(gpt, /"GPTBufferedAction"/);
	assert.match(gpt, /"GPTFollow"/);
	assert.match(gpt, /"GPTApproach"/);
	assert.match(gpt, /"GPTRetreat"/);
	assert.match(gpt, /self\.OnAttacked = function\(\)\s*end/);
	assert.doesNotMatch(gpt, /TeleportToPlayer\(|ItemsNearby\(|self:Attack\(/);
});

test("Gateway failures interrupt local actions and leave the companion standing by", async () => {
	const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

	assert.match(gpt, /function GPTAgentBrain:EnterGatewayStandby\(reason\)/);
	assert.match(gpt, /self:InterruptLocalAction\("gateway unavailable", true\)/);
	assert.match(gpt, /self:EnterGatewayStandby\("state post failed"\)/);
	assert.match(gpt, /self:EnterGatewayStandby\("command poll failed"\)/);
	assert.match(gpt, /self:EnterGatewayStandby\("result post failed"\)/);
	assert.match(gpt, /self:EnterGatewayStandby\("player input forward failed"\)/);
});

test("Lua revalidates rare gives and honors entity movement targets", async () => {
	const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

	assert.match(gpt, /local ORDINARY_GIVE_PREFABS =/);
	assert.match(gpt, /function IsOrdinaryGiveItem\(item_name\)/);
	assert.match(gpt, /give_item requires player confirmation/);
	assert.match(gpt, /equip_or_eat requires itemName/);
	assert.match(gpt, /function GPTAgentBrain:ResolveMovementTarget\(target_guid\)/);
	assert.match(gpt, /self\.GPTMovementTargetGuid = EntityGuid\(target\)/);
	assert.match(gpt, /"GPTApproach"/);
	assert.match(gpt, /"GPTRetreat"/);
});
