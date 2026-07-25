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

test("only modmain accesses the mod GLOBAL table for its sandboxed tonumber", async () => {
  const modmain = await readModFile("modmain.lua");
  const legacy = await readModFile("scripts", "brains", "fatimabrain.lua");
  const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

  assert.match(modmain, /local tonumber = GLOBAL\.tonumber/);
  assert.doesNotMatch(legacy, /GLOBAL\.tonumber/);
  assert.doesNotMatch(gpt, /GLOBAL\.tonumber/);
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

test("GPT Agent never starts the legacy FAtiMA loop before its own poll runs", async () => {
	const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

	assert.doesNotMatch(gpt, /LegacyBrain\.OnStart\(self\)/);
	assert.doesNotMatch(gpt, /LegacyBrain\.OnStop\(self\)/);
	assert.match(gpt, /Do not call LegacyBrain\.OnStart here/);
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

test("ordinary !ai text is forwarded to Gateway without a local follow shortcut", async () => {
	const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

	assert.match(gpt, /self:ForwardPlayerInput\(text, userid\)/);
	assert.match(gpt, /if LOCAL_STOP_TEXT\[normalized\] then/);
	assert.match(gpt, /self:InterruptLocalAction\("local player stop", true\)/);
	assert.doesNotMatch(gpt, /LOCAL_FOLLOW_TEXT/);
	assert.doesNotMatch(gpt, /local player follow/);
	assert.doesNotMatch(gpt, /SayAI\("Following\."\)/);
	assert.doesNotMatch(gpt, /SayAI\("Stopping\."\)/);
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

test("gather commands report started, emit progress, and only finish after the local scan is exhausted", async () => {
	const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

	assert.match(
		gpt,
		/self:ReportCommandResult\(command\.id, "started"\)\s+local waits_for_action, apply_reason = self:ApplyCommand\(command\)\s+if waits_for_action == nil then\s+self:CompleteActiveCommand\("failed", apply_reason or "command could not be applied"\)\s+elseif waits_for_action == false then\s+self:CompleteActiveCommand\("succeeded"\)\s+elseif waits_for_action == "completed" then\s+return\s+end/m,
	);
	assert.match(gpt, /local MAX_GATHER_TARGETS = 40/);
	assert.match(gpt, /local MAX_GATHER_RESULT_TARGETS = 10000/);
	assert.match(gpt, /function GPTAgentBrain:RefreshGatherSession\(session\)/);
	assert.match(gpt, /function GPTAgentBrain:IsGatherTargetInRange\(session, entity\)/);
	assert.match(gpt, /local leader = self:EnsurePlayerTarget\(nil\)[\s\S]*?leader:GetDistanceSqToInst\(entity\)\) <= NEARBY_RANGE/);
	assert.match(gpt, /return nil, "player is not nearby"/);
	assert.match(gpt, /session\.scope == "all_same_prefab"/);
	assert.match(gpt, /CanonicalPrefab\(entity\.prefab\) ~= session\.targetPrefab/);
	assert.match(gpt, /session\.overflowGuids\[guid\] = true/);
	assert.match(gpt, /session\.remaining = #candidates \+ self:GatherOverflowCount\(session\)/);
	assert.match(gpt, /function GPTAgentBrain:StartNextGatherTarget\(target\)/);
	assert.match(gpt, /self:ReportCommandResult\(self\.ActiveCommand\.id, "progress", progress_reason, self:BuildGatherOutcome\(session\)\)/);
	assert.match(gpt, /if session\.limitReached then\s+self:CompleteActiveCommand\("partial", "gather target limit reached"\)/m);
	assert.match(gpt, /elseif session\.skipped > 0 then\s+self:CompleteActiveCommand\("partial"/m);
	assert.match(gpt, /elseif session\.completed > 0 then[\s\S]*?self:CompleteActiveCommand\("succeeded"\)/);
	assert.match(gpt, /self:CompleteActiveCommand\("partial", "inventory full"\)/);
	assert.match(gpt, /buffered:AddSuccessAction\(function\(\)[\s\S]*?self:FinishBufferedCommand\("succeeded"\)\s+end\)/);
	assert.match(gpt, /buffered:AddFailAction\(function\(\)[\s\S]*?self:FinishBufferedCommand\("failed", "buffered action failed"\)\s+end\)/);
});

test("active command cancellation and expiry produce honest terminal states", async () => {
	const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");

	assert.match(gpt, /self:CompleteActiveCommand\("cancelled", "replaced by newer command"\)/);
	assert.match(
		gpt,
		/function GPTAgentBrain:InterruptLocalAction\(reason, report_active, preserve_gather_session\)\s+if report_active and self\.ActiveCommand ~= nil then\s+self:CompleteActiveCommand\("cancelled", SafeText\(reason, MAX_RESULT_REASON\)\)\s+end/,
	);
	assert.match(
		gpt,
		/function GPTAgentBrain:ExpireActiveCommand\(\)\s+if self\.ActiveCommand ~= nil and IsFiniteNumber\(self\.ActiveCommand\.expiresAt\) and self\.ActiveCommand\.expiresAt <= NowMs\(\) then\s+if self\.ActiveCommand\.kind == "gather_nearby" and self\.GPTGatherSession ~= nil then\s+self:CompleteActiveCommand\("partial", "command expired"\)\s+self:InterruptLocalAction\("command expired", false\)\s+else\s+self:InterruptLocalAction\("command expired", true\)\s+end\s+end\s+end/m,
	);
	assert.match(gpt, /self:CompleteActiveCommand\("cancelled", "action cleared"\)/);
});

test("follow reports mode enablement once while movement and game speech retain honest effects", async () => {
	const gpt = await readModFile("scripts", "brains", "gptagentbrain.lua");
	const movementCompletion = gpt.match(/function GPTAgentBrain:CheckMovementCommandCompletion\(\)([\s\S]*?)\nend\n\nfunction GPTAgentBrain:ShouldKeepBufferedCommandWorking/);

	assert.match(gpt, /function GPTAgentBrain:CheckMovementCommandCompletion\(\)/);
	assert.ok(movementCompletion);
	assert.doesNotMatch(gpt, /FOLLOW_COMPLETE_RANGE/);
	assert.doesNotMatch(movementCompletion[1], /follow_player/);
	assert.match(gpt, /self\.UttAction = "Follow"[\s\S]*?return false/);
	assert.match(gpt, /distance >= RETREAT_COMPLETE_RANGE/);
	assert.match(gpt, /distance <= APPROACH_COMPLETE_RANGE/);
	assert.match(gpt, /if not self:SayAI\(text\) then\s+return nil, "in-game speech could not be delivered"\s+end/m);
	assert.match(gpt, /function GPTAgentBrain:SayAI\(text\)[\s\S]*?return false[\s\S]*?local delivered = false[\s\S]*?return delivered/);
	assert.match(gpt, /self\.inst\.components\.talker:Say\(text\)/);
	assert.match(gpt, /TheNet:SystemMessage\("\[AI\] " \.\. text\)/);
});
