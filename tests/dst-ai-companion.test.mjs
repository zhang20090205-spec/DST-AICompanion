import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modRoot = path.join(root, "DST Mod");

async function readModFile(...segments) {
  return readFile(path.join(modRoot, ...segments), "utf8");
}

test("removes the repeated UttAction system-message debug output", async () => {
  const brain = await readModFile("scripts", "brains", "fatimabrain.lua");

  assert.doesNotMatch(brain, /TheNet:SystemMessage\("UttAction/);
  assert.doesNotMatch(brain, /TheNet:SystemMessage\("Flag/);
  assert.doesNotMatch(brain, /TheNet:SystemMessage\("Goal has been changed/);
});

test("adds an opt-in public-chat command interface", async () => {
  const modinfo = await readModFile("modinfo.lua");
  const modmain = await readModFile("modmain.lua");

  assert.match(modinfo, /name = "Enable Text Commands"/);
  assert.match(modinfo, /default = 1/);
  assert.match(modinfo, /name = "Chat Prefix"/);
  assert.match(modinfo, /data = "!ai"/);
  assert.match(modmain, /GLOBAL\.Networking_Say/);
	assert.match(modmain, /GLOBAL\.Ents/);
  assert.match(modmain, /local text_command_hook_wrapper = nil/);
  assert.doesNotMatch(modmain, /rawget|rawset/);
  assert.doesNotMatch(modmain, /KnownModIndex/);
	assert.doesNotMatch(modmain, /\bpairs\s*\(\s*Ents\s*\)/);
  assert.match(modmain, /whisper == true or isemote == true/);
  assert.match(modmain, /QueueTextCommand/);
});

test("a missing portal cannot crash dedicated-server startup", async () => {
  const modmain = await readModFile("modmain.lua");

  assert.match(modmain, /if portal == nil then/);
  assert.match(modmain, /companion spawn was skipped/);
});

test("chat hook dispatches the original message once without unavailable Lua helpers", async () => {
  const modmain = await readModFile("modmain.lua");
  const originalCall = "original_networking_say(guid, userid, name, prefab, message, colour, whisper, isemote, user_vanity)";

  assert.equal(modmain.split(originalCall).length - 1, 1);
  assert.doesNotMatch(modmain, /\bselect\s*\(|\bpcall\s*\(/);
  assert.doesNotMatch(modmain, /table\.unpack|\bunpack\s*\(/);
});

test("command parser covers the documented commands and acknowledges them", async () => {
  const brain = await readModFile("scripts", "brains", "fatimabrain.lua");

  for (const action of [
    "Follow",
    "Stop",
    "Approach",
    "Goaway",
    "GoHome",
    "Wander",
    "Attack",
    "Give_cutgrass",
    "Give_rock",
    "Give_flint",
    "Give_log",
    "Give_twigs",
    "Give_food",
  ]) {
    assert.match(brain, new RegExp(`\\b${action}\\b`));
  }

  assert.match(brain, /function FAtiMABrain:QueueTextCommand/);
  assert.match(brain, /self\.inst\.components\.talker:Say\(acknowledgements\[action\]\)/);
  assert.match(brain, /"跟我"/);
  assert.match(brain, /"给我"/);
});

test("speech remains optional and leader access stays guarded", async () => {
	const brain = await readModFile("scripts", "brains", "fatimabrain.lua");

	assert.match(brain, /GetCompanionConfig\("Enable Speech"\)/);
  assert.match(brain, /function FAtiMABrain:GetLeader\(\)/);
	assert.match(brain, /return follower ~= nil and follower\.leader or nil/);
});

test("brain configuration lookups preserve the owning mod name", async () => {
	const brain = await readModFile("scripts", "brains", "fatimabrain.lua");

	assert.match(
		brain,
		/local function GetCompanionConfig\(optionname\)\s+return GetModConfigData\(optionname, KnownModIndex:GetModActualName\("The AI Companion"\)\)\s+end/,
	);

	for (const option of [
		"speak-chance",
		"personality",
		"OPE",
		"COS",
		"EXT",
		"AGR",
		"NEU",
		"Enable Speech",
	]) {
		assert.match(brain, new RegExp(`GetCompanionConfig\\("${option}"\\)`));
	}

	assert.doesNotMatch(brain, /GetModConfigData\("[^"\n]+"\)/);
});

test("disconnecting a player cannot leave a stale distance target", async () => {
	const brain = await readModFile("scripts", "brains", "fatimabrain.lua");

	assert.match(brain, /Player_character ~= nil and not Player_character:IsValid\(\)/);
	assert.match(brain, /p1 ~= nil and p1:IsValid\(\) and p2 ~= nil and p2:IsValid\(\)/);
});

test("GPT Live runtime removes legacy debug and graph code", async () => {
  const modmain = await readModFile("modmain.lua");

  assert.doesNotMatch(modmain, /io\.open\s*\(/);
  assert.doesNotMatch(modmain, /CHEATS_ENABLED|DEBUG_MENU_ENABLED|debugkeys|debughelpers/);
  assert.doesNotMatch(modmain, /fatimabrain|graph_data\.csv/);
});
