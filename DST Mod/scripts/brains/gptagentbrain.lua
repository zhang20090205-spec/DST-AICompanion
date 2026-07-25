require "behaviours/follow"

local LegacyBrain = require "brains/fatimabrain"

local GATEWAY_BASE_URL = "http://127.0.0.1:8080"
local COMPANION_ID = "default"
local STATE_POST_INTERVAL = 0.5
local COMMAND_POLL_INTERVAL = 0.25
local NEARBY_RANGE = 21
-- Gathering may look and walk beyond the reported nearby radius so the companion
-- can fetch resources that are a little further out, and roam up to a leash from
-- the player instead of demanding the resource sit right next to both of them.
local GATHER_SEARCH_RANGE = 40
local PLAYER_LEASH_RANGE = 40
local ATTACK_COMMAND_RANGE = 12
local MAX_NEARBY = 40
local MAX_GATHER_TARGETS = 40
local MAX_GATHER_RESULT_TARGETS = 10000
local MAX_INVENTORY = 40
local MAX_TEXT_LENGTH = 120
local MAX_RESULT_REASON = 160
local AI_SPEECH_MIN_INTERVAL_MS = 500
local APPROACH_COMPLETE_RANGE = 10
local RETREAT_COMPLETE_RANGE = 15

local COMMAND_KINDS = {
	say_in_game = true,
	follow_player = true,
	stop_and_wait = true,
	approach_or_retreat = true,
	gather_nearby = true,
	attack_nearby_threat = true,
	equip_or_eat = true,
	give_item = true,
	clear_action_queue = true,
}

local COMMAND_PRIORITIES = {
	interrupt = true,
	player = true,
	autonomy = true,
}

local WORK_ACTION_BY_GATHER_MODE = {
	collect = "PICKUP",
	chop = "CHOP",
	mine = "MINE",
}

local BUFFERED_COMMAND_ACTIONS = {
	PICK = true,
	PICKUP = true,
	CHOP = true,
	MINE = true,
	ATTACK = true,
	EQUIP = true,
	EAT = true,
}

local ORDINARY_GIVE_PREFABS = {
	cutgrass = true,
	twigs = true,
	log = true,
	rocks = true,
	flint = true,
	seeds = true,
	seeds_cooked = true,
	berries = true,
	berries_cooked = true,
	berries_juicy = true,
	berries_juicy_cooked = true,
	carrot = true,
	carrot_cooked = true,
	corn = true,
	corn_cooked = true,
	smallmeat = true,
	cookedsmallmeat = true,
}

local LOCAL_STOP_TEXT = {
	stop = true,
	wait = true,
	hold = true,
	["停止"] = true,
	["停下"] = true,
	["别动"] = true,
}

local LOCAL_YES_TEXT = {
	yes = true,
	["是"] = true,
	["确认"] = true,
}

local LOCAL_NO_TEXT = {
	no = true,
	["否"] = true,
	["取消"] = true,
}

local function GetCompanionConfig(optionname)
	return GetModConfigData(optionname, KnownModIndex:GetModActualName("The AI Companion"))
end

local function GetGatewayBaseUrl()
	local configured = GetCompanionConfig("GPT Gateway URL")
	if type(configured) == "string" and configured ~= "" then
		return configured
	end
	return GATEWAY_BASE_URL
end

local function IsFiniteNumber(value)
	return type(value) == "number" and value == value and value ~= math.huge and value ~= -math.huge
end

local function Clamp(value, minimum, maximum, fallback)
	if not IsFiniteNumber(value) then
		return fallback
	end
	if value < minimum then
		return minimum
	end
	if value > maximum then
		return maximum
	end
	return value
end

local function Trim(text)
	return tostring(text or ""):gsub("^%s*(.-)%s*$", "%1")
end

local function LowerText(text)
	return string.lower(Trim(text))
end

local function SafeText(text, max_length)
	if type(text) ~= "string" then
		return ""
	end
	text = text:gsub("[%c]", " "):gsub("%s+", " "):gsub("^%s*(.-)%s*$", "%1")
	if #text > max_length then
		text = string.sub(text, 1, max_length)
	end
	return text
end

local function NowMs()
	if os ~= nil and type(os.time) == "function" then
		return os.time() * 1000
	end
	return math.floor(TheSim:GetRealTime() * 1000)
end

local function JsonDecodeObject(result)
	if type(result) ~= "string" or result == "" then
		return nil
	end
	local ok, decoded = pcall(json.decode, result)
	if ok and type(decoded) == "table" then
		return decoded
	end
	return nil
end

local function EntityGuid(entity)
	return entity ~= nil and IsFiniteNumber(entity.GUID) and math.floor(entity.GUID) or nil
end

local function EntityPosition(entity)
	if entity == nil or entity.Transform == nil then
		return nil
	end
	local x, _, z = entity.Transform:GetWorldPosition()
	return {
		x = Clamp(x, -10000, 10000, 0),
		z = Clamp(z, -10000, 10000, 0),
	}
end

local function EntityTags(entity)
	local tags = {}
	local count = 0
	if entity ~= nil and type(entity.tags) == "table" then
		for tag, _ in pairs(entity.tags) do
			if type(tag) == "string" and count < 12 then
				count = count + 1
				tags[count] = SafeText(tag, 32)
			end
		end
	end
	return tags
end

local function HasAnyHostileLabel(entity)
	local prefab = string.lower(tostring(entity ~= nil and entity.prefab or ""))
	if string.find(prefab, "hound", 1, true)
		or string.find(prefab, "spider", 1, true)
		or string.find(prefab, "tentacle", 1, true)
		or string.find(prefab, "frog", 1, true)
		or string.find(prefab, "merm", 1, true)
		or string.find(prefab, "bee", 1, true) then
		return true
	end
	if entity ~= nil and entity.HasTag ~= nil then
		return entity:HasTag("monster") or entity:HasTag("hostile")
	end
	return false
end

local function IsValidEntity(entity)
	return entity ~= nil and entity.IsValid ~= nil and entity:IsValid()
end

local function ItemStackSize(item)
	if not IsValidEntity(item) then
		return 0
	end
	if item.components ~= nil and item.components.stackable ~= nil then
		return item.components.stackable:StackSize()
	end
	return 1
end

local function IsOrdinaryGiveItem(item_name)
	if type(item_name) ~= "string" then
		return false
	end
	local normalized = string.lower(item_name):gsub("[%s%-]+", "_")
	return ORDINARY_GIVE_PREFABS[normalized] == true
end

local function IsNearAttackRange(inst, target)
	return IsValidEntity(inst)
		and IsValidEntity(target)
		and math.sqrt(inst:GetDistanceSqToInst(target)) <= ATTACK_COMMAND_RANGE
end

local function IsVisibleEntity(entity)
	return IsValidEntity(entity) and (entity.entity == nil or entity.entity:IsVisible())
end

local function CanonicalPrefab(prefab)
	return string.lower(SafeText(tostring(prefab or ""), 64))
end

-- Mirror of the Gateway resource lexicon families. A spoken resource can spawn
-- as several prefab variants; the companion matches and reports them all as one
-- canonical family primary so trusted gather outcomes line up with the command.
local GATHER_PREFAB_FAMILY = {
	grass = "grass",
	berrybush = "berrybush",
	berrybush2 = "berrybush",
	berrybush_juicy = "berrybush",
	sapling = "sapling",
	sapling_moon = "sapling",
	carrot = "carrot",
	carrot_planted = "carrot",
	reeds = "reeds",
	flower = "flower",
	flower_evil = "flower",
	evergreen = "evergreen",
	evergreen_sparse = "evergreen",
	deciduoustree = "evergreen",
	twiggytree = "evergreen",
	rock1 = "rock1",
	rock2 = "rock1",
	rock_flintless = "rock1",
	rock_moon = "rock1",
}

local function CanonicalGatherPrefab(prefab)
	local canonical = CanonicalPrefab(prefab)
	return GATHER_PREFAB_FAMILY[canonical] or canonical
end

local function IsGatherableEntity(entity, mode)
	if not IsVisibleEntity(entity) then
		return false
	end
	if mode == "chop" then
		return entity:HasTag("CHOP_workable")
	elseif mode == "mine" then
		return entity:HasTag("MINE_workable")
	end
	return entity:HasTag("pickable")
		or (entity.components ~= nil
			and entity.components.inventoryitem ~= nil
			and entity.components.inventoryitem.canbepickedup
			and not entity:HasTag("heavy"))
end

local function IsPlayerEntity(inst, entity)
	if not IsValidEntity(entity) or entity == inst then
		return false
	end
	for _, player in ipairs(AllPlayers or {}) do
		if player == entity then
			return true
		end
	end
	return false
end

local function InventoryItemRecord(item)
	if not IsValidEntity(item) or type(item.prefab) ~= "string" then
		return nil
	end
	local quantity = ItemStackSize(item)
	return {
		prefab = SafeText(item.prefab, 64),
		quantity = math.floor(Clamp(quantity, 1, 999, 1)),
		guid = EntityGuid(item),
	}
end

local function FindInventoryItem(inst, item_name, predicate)
	if inst.components == nil or inst.components.inventory == nil then
		return nil
	end
	local normalized = LowerText(item_name)
	for _, item in pairs(inst.components.inventory.itemslots or {}) do
		if IsValidEntity(item)
			and (normalized == "" or string.lower(tostring(item.prefab or "")) == normalized)
			and (predicate == nil or predicate(item)) then
			return item
		end
	end
	for _, item in pairs(inst.components.inventory.equipslots or {}) do
		if IsValidEntity(item)
			and (normalized == "" or string.lower(tostring(item.prefab or "")) == normalized)
			and (predicate == nil or predicate(item)) then
			return item
		end
	end
	return nil
end

local function ActionWfn(command, action)
	return "GPT(" .. tostring(command.id) .. ":" .. tostring(action) .. ")"
end

local GPTAgentBrain = Class(LegacyBrain, function(self, inst, server)
	LegacyBrain._ctor(self, inst, server or GetGatewayBaseUrl())
	self.inst = inst
	self.GatewayServer = server or GetGatewayBaseUrl()
	self.CompanionId = COMPANION_ID
	self.GatewayEpoch = 0
	self.StateRevision = 0
	self.StateInFlight = false
	self.CommandPollInFlight = false
	self.GatewayOffline = false
	self.GatewayStateTask = nil
	self.ActiveCommand = nil
	self.ActiveActionWFN = nil
	self.GPTCommandCombatTarget = nil
	self.GPTGiveItemName = nil
	self.GPTGiveQuantity = 1
	self.GPTGatherSession = nil
	self.GPTMovementTargetGuid = nil
	self.PlayerInputSequence = 0
	self.LastAISayAt = 0
	-- The legacy callback auto-targets attackers. GPT mode only attacks through
	-- a validated command, so keep the event inert after the compatibility setup.
	self.OnAttacked = function()
	end

	self.OnGatewayState = function(result, isSuccessful, http_code)
		self:OnStatePosted(result, isSuccessful, http_code)
	end
	self.OnGatewayCommands = function(result, isSuccessful, http_code)
		self:OnCommandsPolled(result, isSuccessful, http_code)
	end
	self.OnGatewayResult = function(result, isSuccessful, http_code)
		self:OnResultPosted(result, isSuccessful, http_code)
	end
	self.OnCommandPoll = function()
		self:PollCommands()
	end
	self.OnGatewayStatePost = function()
		self:Perceptions()
	end
end)

function GPTAgentBrain:GatewayPath(path)
	return self.GatewayServer .. "/api/dst/v1/companions/" .. self.CompanionId .. path
end

function GPTAgentBrain:EnterGatewayStandby(reason)
	local was_offline = self.GatewayOffline == true
	self.GatewayOffline = true
	self:InterruptLocalAction("gateway unavailable", true)
	if not was_offline then
		print("[DST GPT Agent] Gateway unavailable; companion is standing by: " .. SafeText(reason, MAX_RESULT_REASON))
	end
end

function GPTAgentBrain:MarkGatewayOnline()
	if self.GatewayOffline then
		print("[DST GPT Agent] Gateway connection restored.")
	end
	self.GatewayOffline = false
end

function GPTAgentBrain:IsActiveBufferedCommand(action)
	return self.ActiveCommand ~= nil
		and self.CurrentAction ~= nil
		and self.CurrentAction.Type == "Action"
		and (action == nil or self.CurrentAction.Action == action)
end

function GPTAgentBrain:GetGPTMovementTarget()
	if IsFiniteNumber(self.GPTMovementTargetGuid) then
		local target = Ents[math.floor(self.GPTMovementTargetGuid)]
		if IsVisibleEntity(target) and math.sqrt(self.inst:GetDistanceSqToInst(target)) <= NEARBY_RANGE then
			return target
		end
	end
	return nil
end

function GPTAgentBrain:ResolveMovementTarget(target_guid)
	if IsFiniteNumber(target_guid) then
		local target = Ents[math.floor(target_guid)]
		if IsVisibleEntity(target) and math.sqrt(self.inst:GetDistanceSqToInst(target)) <= NEARBY_RANGE then
			return target
		end
		return nil
	end
	local leader = self:EnsurePlayerTarget(nil)
	if IsVisibleEntity(leader) and math.sqrt(self.inst:GetDistanceSqToInst(leader)) <= NEARBY_RANGE then
		return leader
	end
	return nil
end

function GPTAgentBrain:CheckMovementCommandCompletion()
	local command = self.ActiveCommand
	if command == nil then
		return
	end
	if command.kind ~= "approach_or_retreat" then
		return
	end
	local target = self:GetGPTMovementTarget()
	if target == nil then
		self:CompleteActiveCommand("failed", "movement target is unavailable")
		return
	end
	local distance = math.sqrt(self.inst:GetDistanceSqToInst(target))
	if command.args ~= nil and command.args.mode == "retreat" then
		if distance >= RETREAT_COMPLETE_RANGE then
			self:CompleteActiveCommand("succeeded")
		end
	elseif distance <= APPROACH_COMPLETE_RANGE then
		self:CompleteActiveCommand("succeeded")
	end
end

function GPTAgentBrain:ShouldKeepBufferedCommandWorking(action, target)
	if not IsVisibleEntity(target) then
		return false
	end
	if action == "CHOP" then
		return target:HasTag("CHOP_workable")
	elseif action == "MINE" then
		return target:HasTag("MINE_workable")
	elseif action == "ATTACK" then
		return self.inst.components.combat ~= nil and self.inst.components.combat:CanAttack(target)
	end
	return false
end

function GPTAgentBrain:FinishBufferedCommand(status, reason)
	if self.CurrentAction ~= nil and self.CurrentAction.Action == "ATTACK" then
		self:DropCommandCombatTarget()
	end
	self.CurrentAction = nil
	if self.ActiveCommand ~= nil
		and self.ActiveCommand.kind == "gather_nearby"
		and self.GPTGatherSession ~= nil then
		self:FinishGatherTarget(status, reason)
		return
	end
	self:CompleteActiveCommand(status, reason)
end

function GPTAgentBrain:BuildBufferedCommandAction()
	if not self:IsActiveBufferedCommand() then
		return nil
	end
	local current = self.CurrentAction
	local action_name = current.Action
	if not BUFFERED_COMMAND_ACTIONS[action_name] or ACTIONS[action_name] == nil then
		self:FinishBufferedCommand("failed", "unsupported buffered command action")
		return nil
	end
	local target = current.Target ~= "-" and Ents[tonumber(current.Target)] or nil
	local invobject = current.InvObject ~= "-" and Ents[tonumber(current.InvObject)] or nil
	if (action_name == "PICK" or action_name == "PICKUP" or action_name == "CHOP" or action_name == "MINE" or action_name == "ATTACK")
		and not IsVisibleEntity(target) then
		self:FinishBufferedCommand("failed", "command target is unavailable")
		return nil
	end
	if (action_name == "EQUIP" or action_name == "EAT") and not IsValidEntity(invobject) then
		self:FinishBufferedCommand("failed", "command inventory item is unavailable")
		return nil
	end

	local buffered = BufferedAction(self.inst, target, ACTIONS[action_name], invobject)
	buffered:AddSuccessAction(function()
		if self.CurrentAction ~= current or self.ActiveCommand == nil then
			return
		end
		if self:ShouldKeepBufferedCommandWorking(action_name, target) then
			return
		end
		self:FinishBufferedCommand("succeeded")
	end)
	buffered:AddFailAction(function()
		if self.CurrentAction ~= current or self.ActiveCommand == nil then
			return
		end
		if self:ShouldKeepBufferedCommandWorking(action_name, target) then
			return
		end
		self:FinishBufferedCommand("failed", "buffered action failed")
	end)
	return buffered
end

function GPTAgentBrain:CreateGPTActionTree()
	local root = PriorityNode({
		IfNode(function()
			return self.UttAction == "Stop"
		end, "GPTStop", StandStill(self.inst)),
		IfNode(function()
			return self:IsActiveBufferedCommand("GIVETOPLAYER")
		end, "GPTGive", DoAction(self.inst, function()
			return self:Give()
		end, "GPTGive", true)),
		IfNode(function()
			return self:IsActiveBufferedCommand() and self.CurrentAction.Action ~= "GIVETOPLAYER"
		end, "GPTBufferedAction", DoAction(self.inst, function()
			return self:BuildBufferedCommandAction()
		end, "GPTBufferedAction", true)),
		IfNode(function()
			return self.UttAction == "Follow" and IsValidEntity(self:GetLeader())
		end, "GPTFollow", Follow(self.inst, function()
			return self:GetLeader()
		end, 0, 1, 3)),
		IfNode(function()
			return self.UttAction == "Approach" and self:GetGPTMovementTarget() ~= nil
		end, "GPTApproach", Approach(self.inst, function()
			return self:GetGPTMovementTarget()
		end, 10, true)),
		IfNode(function()
			return self.UttAction == "Goaway" and self:GetGPTMovementTarget() ~= nil
		end, "GPTRetreat", RunAway(self.inst, function()
			return self:GetGPTMovementTarget()
		end, 15, 10)),
	}, 1)
	self.bt = BT(self.inst, root)
end

function GPTAgentBrain:OnStart()
	-- Do not call LegacyBrain.OnStart here.  That starts the old FAtiMA HTTP
	-- perception/decision/speech timers and registers its autonomous callbacks.
	-- The GPT brain only reuses safe DST helper methods from the legacy class;
	-- its runtime loop is entirely the Gateway state post + command poll below.
	if self.inst.entity ~= nil then
		self.inst.entity:SetCanSleep(false)
	end
	if self.inst.components.trader ~= nil then
		self.inst.components.trader:Enable()
	end
	if self.inst.components.combat ~= nil then
		self.inst.components.combat.lastattacker = nil
	end
	if self:GetLeader() == nil then
		self:SetPlayerCharacter()
	end
	self:SetLeader()
	self:CreateGPTActionTree()
	if self.GatewayStateTask ~= nil then
		self.GatewayStateTask:Cancel()
	end
	self.GatewayStateTask = self.inst:DoPeriodicTask(STATE_POST_INTERVAL, self.OnGatewayStatePost, 0)
	if self.CommandPollTask ~= nil then
		self.CommandPollTask:Cancel()
	end
	self.CommandPollTask = self.inst:DoPeriodicTask(COMMAND_POLL_INTERVAL, self.OnCommandPoll, 0)
	print("[DST GPT Agent] Brain Start")
end

function GPTAgentBrain:OnStop()
	if self.GatewayStateTask ~= nil then
		self.GatewayStateTask:Cancel()
		self.GatewayStateTask = nil
	end
	if self.CommandPollTask ~= nil then
		self.CommandPollTask:Cancel()
		self.CommandPollTask = nil
	end
	if self.PerceptionsTask ~= nil then
		self.PerceptionsTask:Cancel()
		self.PerceptionsTask = nil
	end
	if self.DSTActionTask ~= nil then
		self.DSTActionTask:Cancel()
		self.DSTActionTask = nil
	end
	if self.SpeakActionTask ~= nil then
		self.SpeakActionTask:Cancel()
		self.SpeakActionTask = nil
	end
	if self.visiontask ~= nil then
		self.visiontask:Cancel()
		self.visiontask = nil
	end
	-- LegacyBrain.OnStop removes listeners created by LegacyBrain.OnStart. They
	-- are intentionally never registered in GPT mode, so do not invoke it.
end

function GPTAgentBrain:BuildCompactState()
	if self:GetLeader() == nil then
		self:SetPlayerCharacter()
		self:SetLeader()
	end
	if self:HasHome() == nil then
		self:FindValidHome()
	end

	local x, _, z = self.inst.Transform:GetWorldPosition()
	local leader = self:GetLeader()
	local inventory = {}
	local inventory_count = 0
	local inv = self.inst.components.inventory
	if inv ~= nil then
		for _, item in pairs(inv.itemslots or {}) do
			if inventory_count < MAX_INVENTORY then
				local record = InventoryItemRecord(item)
				if record ~= nil then
					inventory_count = inventory_count + 1
					inventory[inventory_count] = record
				end
			end
		end
		for _, item in pairs(inv.equipslots or {}) do
			if inventory_count < MAX_INVENTORY then
				local record = InventoryItemRecord(item)
				if record ~= nil then
					inventory_count = inventory_count + 1
					inventory[inventory_count] = record
				end
			end
		end
	end

	local nearby = {}
	local nearby_candidates = {}
	local is_near_danger = false
	local ents = TheSim:FindEntities(x, 0, z, NEARBY_RANGE, nil, { "INLIMBO", "NOCLICK", "CLASSIFIED", "FX" }, nil)
	for _, entity in ipairs(ents or {}) do
		if entity ~= self.inst and IsVisibleEntity(entity) and type(entity.prefab) == "string" then
			local distance = math.sqrt(self.inst:GetDistanceSqToInst(entity))
			local attackable = self.inst.components.combat ~= nil and self.inst.components.combat:CanAttack(entity) or false
			local player_distance = nil
			if IsValidEntity(leader) then
				player_distance = math.sqrt(leader:GetDistanceSqToInst(entity))
			end
			local record = {
				guid = EntityGuid(entity),
				prefab = SafeText(entity.prefab, 64),
				distance = Clamp(distance, 0, 250, 250),
				position = EntityPosition(entity),
				playerDistance = player_distance ~= nil and Clamp(player_distance, 0, 250, 250) or nil,
				tags = EntityTags(entity),
				collectable = entity:HasTag("pickable") or (entity.components ~= nil and entity.components.inventoryitem ~= nil and entity.components.inventoryitem.canbepickedup and not entity:HasTag("heavy")),
				choppable = entity:HasTag("CHOP_workable"),
				mineable = entity:HasTag("MINE_workable"),
				attackable = attackable,
				edible = self.inst.components.eater ~= nil and self.inst.components.eater:CanEat(entity) or false,
				equippable = entity:HasTag("_equippable"),
			}
			if record.guid ~= nil and record.prefab ~= "" then
				nearby_candidates[#nearby_candidates + 1] = record
				if distance <= 12 and attackable and HasAnyHostileLabel(entity) then
					is_near_danger = true
				end
			end
		end
	end
	table.sort(nearby_candidates, function(left, right)
		if left.distance == right.distance then
			return left.guid < right.guid
		end
		return left.distance < right.distance
	end)
	for index = 1, math.min(#nearby_candidates, MAX_NEARBY) do
		nearby[index] = nearby_candidates[index]
	end

	local player = {
		guid = nil,
		userid = nil,
		distance = nil,
		position = nil,
	}
	if IsValidEntity(leader) then
		player.guid = EntityGuid(leader)
		player.userid = type(leader.userid) == "string" and SafeText(leader.userid, 128) or nil
		player.distance = math.sqrt(self.inst:GetDistanceSqToInst(leader))
		player.position = EntityPosition(leader)
	end

	local world_state = TheWorld ~= nil and TheWorld.state or {}
	local current_action = nil
	if self.CurrentAction ~= nil then
		current_action = SafeText(self.CurrentAction.Action, 64)
	elseif self.UttAction ~= nil then
		current_action = SafeText(self.UttAction, 64)
	end

	return {
		health = self.inst.components.health ~= nil and self.inst.components.health.currenthealth or nil,
		hunger = self.inst.components.hunger ~= nil and self.inst.components.hunger.current or nil,
		sanity = self.inst.components.sanity ~= nil and self.inst.components.sanity.current or nil,
		temperature = self.inst.GetTemperature ~= nil and self.inst:GetTemperature() or nil,
		position = {
			x = Clamp(x, -10000, 10000, 0),
			z = Clamp(z, -10000, 10000, 0),
		},
		player = player,
		inventory = inventory,
		nearby = nearby,
		world = {
			phase = SafeText(world_state.phase or "unknown", 24),
			isDay = world_state.isday == true,
			isDusk = world_state.isdusk == true,
			isNight = world_state.isnight == true,
		},
		currentAction = current_action,
		isBusy = self.CurrentAction ~= nil,
		isNearDanger = is_near_danger,
	}
end

function GPTAgentBrain:Perceptions()
	if self.StateInFlight then
		return
	end
	self.StateInFlight = true
	local state = self:BuildCompactState()
	TheSim:QueryServer(
		self:GatewayPath("/state"),
		self.OnGatewayState,
		"POST",
		json.encode(state))
end

function GPTAgentBrain:OnStatePosted(result, isSuccessful, http_code)
	self.StateInFlight = false
	if not isSuccessful then
		print("[DST GPT Agent] State post failed: " .. tostring(http_code))
		self:EnterGatewayStandby("state post failed")
		return
	end
	local response = JsonDecodeObject(result)
	if response == nil then
		self:EnterGatewayStandby("invalid state response")
		return
	end
	self:MarkGatewayOnline()
	if IsFiniteNumber(response.stateRevision) then
		self.StateRevision = math.floor(response.stateRevision)
	end
	if IsFiniteNumber(response.epoch) and response.epoch > self.GatewayEpoch then
		self.GatewayEpoch = math.floor(response.epoch)
		self:InterruptLocalAction("gateway epoch advanced", true)
	end
end

function GPTAgentBrain:Decide(layer)
	self:PollCommands()
end

function GPTAgentBrain:Speech(layer)
end

function GPTAgentBrain:PollCommands()
	if self.CommandPollInFlight then
		return
	end
	self:ExpireActiveCommand()
	self:CheckMovementCommandCompletion()
	self.CommandPollInFlight = true
	TheSim:QueryServer(
		self:GatewayPath("/commands"),
		self.OnGatewayCommands,
		"GET")
end

function GPTAgentBrain:OnCommandsPolled(result, isSuccessful, http_code)
	self.CommandPollInFlight = false
	if not isSuccessful then
		print("[DST GPT Agent] Command poll failed: " .. tostring(http_code))
		self:EnterGatewayStandby("command poll failed")
		return
	end
	local response = JsonDecodeObject(result)
	if response == nil then
		self:EnterGatewayStandby("invalid command response")
		return
	end
	self:MarkGatewayOnline()
	if IsFiniteNumber(response.epoch) and response.epoch > self.GatewayEpoch then
		self.GatewayEpoch = math.floor(response.epoch)
		self:InterruptLocalAction("gateway interrupt", true)
	end
	if type(response.commands) ~= "table" or #response.commands < 1 then
		return
	end
	self:DispatchCommand(response.commands[1])
end

function GPTAgentBrain:ValidateCommand(command)
	if type(command) ~= "table" then
		return false, "command was not an object"
	end
	if type(command.id) ~= "string" or command.id == "" or #command.id > 128 then
		return false, "command id is invalid"
	end
	if not IsFiniteNumber(command.epoch) or command.epoch < 0 then
		return false, "command epoch is invalid"
	end
	if type(command.kind) ~= "string" or not COMMAND_KINDS[command.kind] then
		return false, "command kind is not allowed"
	end
	if type(command.priority) ~= "string" or not COMMAND_PRIORITIES[command.priority] then
		return false, "command priority is invalid"
	end
	if type(command.args) ~= "table" then
		command.args = {}
	end
	if not IsFiniteNumber(command.expiresAt) then
		return false, "command expiry is invalid"
	end
	if command.expiresAt <= NowMs() then
		return false, "command expired"
	end
	if command.epoch < self.GatewayEpoch then
		return false, "command epoch is stale"
	end
	return true
end

function GPTAgentBrain:DispatchCommand(command)
	local valid, reason = self:ValidateCommand(command)
	if not valid then
		if type(command) == "table" and type(command.id) == "string" then
			self:ReportCommandResult(command.id, "failed", reason)
		end
		return
	end

	if command.epoch > self.GatewayEpoch or command.priority == "interrupt" then
		self.GatewayEpoch = math.floor(command.epoch)
		self:InterruptLocalAction("command interrupt", true)
	end
	if self.ActiveCommand ~= nil then
		self:CompleteActiveCommand("cancelled", "replaced by newer command")
	end

	self.ActiveCommand = command
	self.ActiveActionWFN = nil
	self.GPTGiveItemName = nil
	self.GPTGiveQuantity = 1
	self.GPTGatherSession = nil
	self:ReportCommandResult(command.id, "started")

	local waits_for_action, apply_reason = self:ApplyCommand(command)
	if waits_for_action == nil then
		self:CompleteActiveCommand("failed", apply_reason or "command could not be applied")
	elseif waits_for_action == false then
		self:CompleteActiveCommand("succeeded")
	elseif waits_for_action == "completed" then
		return
	end
end

function GPTAgentBrain:ApplyCommand(command)
	local args = command.args or {}
	if command.kind == "clear_action_queue" then
		self:InterruptLocalAction(SafeText(args.reason or "clear action queue", 80), false)
		return false
	elseif command.kind == "say_in_game" then
		local text = SafeText(args.text, MAX_TEXT_LENGTH)
		if text == "" then
			return nil, "say_in_game text is empty"
		end
		if not self:SayAI(text) then
			return nil, "in-game speech could not be delivered"
		end
		return false
	elseif command.kind == "follow_player" then
		local leader = self:EnsurePlayerTarget(nil)
		if not IsVisibleEntity(leader) then
			return nil, "no valid player to follow"
		end
		self:InterruptLocalAction("follow player", false)
		self.UttAction = "Follow"
		self.Utterance = "follow"
		-- Following is a persistent mode, not a navigation task that becomes
		-- complete only when a distance threshold happens to be crossed.  Report
		-- that the mode was enabled now; the Follow behaviour below keeps running.
		return false
	elseif command.kind == "stop_and_wait" then
		self:InterruptLocalAction("stop and wait", false)
		self.UttAction = "Stop"
		self.Utterance = "stop"
		return false
	elseif command.kind == "approach_or_retreat" then
		local target = self:ResolveMovementTarget(args.targetGuid)
		if target == nil then
			return nil, "no valid nearby movement target"
		end
		if IsPlayerEntity(self.inst, target) then
			self:EnsurePlayerTarget(EntityGuid(target))
		end
		self:InterruptLocalAction("approach or retreat", false)
		self.GPTMovementTargetGuid = EntityGuid(target)
		if args.mode == "retreat" then
			self.UttAction = "Goaway"
			self.Utterance = "retreat"
		else
			self.UttAction = "Approach"
			self.Utterance = "approach"
		end
		return true
	elseif command.kind == "gather_nearby" then
		return self:ApplyGatherCommand(command)
	elseif command.kind == "attack_nearby_threat" then
		return self:ApplyAttackCommand(command)
	elseif command.kind == "equip_or_eat" then
		return self:ApplyEquipOrEatCommand(command)
	elseif command.kind == "give_item" then
		return self:ApplyGiveItemCommand(command)
	end
	return nil, "unsupported command kind"
end

function GPTAgentBrain:EnsurePlayerTarget(target_guid)
	if IsFiniteNumber(target_guid) then
		local target = Ents[math.floor(target_guid)]
		if IsPlayerEntity(self.inst, target) then
			if type(target.userid) == "string" then
				self:SetCommandLeader(target.userid)
			end
			if self.inst.components.follower == nil then
				self.inst:AddComponent("follower")
			end
			self.inst.components.follower:SetLeader(target)
			return target
		end
	end
	if self:GetLeader() == nil then
		self:SetPlayerCharacter()
		self:SetLeader()
	end
	return self:GetLeader()
end

function GPTAgentBrain:IsGatherTargetInRange(session, entity)
	if entity == self.inst
		or not IsGatherableEntity(entity, session.mode)
		or CanonicalGatherPrefab(entity.prefab) ~= session.targetPrefab
		or math.sqrt(self.inst:GetDistanceSqToInst(entity)) > GATHER_SEARCH_RANGE then
		return false
	end
	-- “Nearby” is the companion's local sensory radius, but a bulk gather must
	-- not pull it away from the player.  The companion may roam up to a leash to
	-- reach a resource; if the player moves beyond that leash mid-session, the
	-- remaining entities become skipped and the truthful terminal result is
	-- partial instead of silently wandering after them.
	local leader = self:EnsurePlayerTarget(nil)
	return IsValidEntity(leader)
		and math.sqrt(leader:GetDistanceSqToInst(entity)) <= PLAYER_LEASH_RANGE
end

function GPTAgentBrain:ResolveGatherTarget(mode, target_guid, target_prefab)
	local canonical_prefab = CanonicalGatherPrefab(target_prefab)
	local leader = self:EnsurePlayerTarget(nil)
	local function is_valid_target(entity)
		return entity ~= self.inst
			and IsGatherableEntity(entity, mode)
			and math.sqrt(self.inst:GetDistanceSqToInst(entity)) <= GATHER_SEARCH_RANGE
			and IsValidEntity(leader)
			and math.sqrt(leader:GetDistanceSqToInst(entity)) <= PLAYER_LEASH_RANGE
			and (canonical_prefab == "" or CanonicalGatherPrefab(entity.prefab) == canonical_prefab)
	end
	if IsFiniteNumber(target_guid) then
		local target = Ents[math.floor(target_guid)]
		if is_valid_target(target) then
			return target
		end
		return nil
	end

	local x, _, z = self.inst.Transform:GetWorldPosition()
	local ents = TheSim:FindEntities(x, 0, z, GATHER_SEARCH_RANGE, nil, { "INLIMBO", "NOCLICK", "CLASSIFIED", "FX" }, nil)
	local best = nil
	local best_distance = nil
	for _, entity in ipairs(ents or {}) do
		if is_valid_target(entity) then
			local distance = self.inst:GetDistanceSqToInst(entity)
			if best == nil or distance < best_distance then
				best = entity
				best_distance = distance
			end
		end
	end
	return best
end

function GPTAgentBrain:IsGatherInventoryFull()
	local inventory = self.inst.components ~= nil and self.inst.components.inventory or nil
	if inventory == nil then
		return true
	end
	if type(inventory.IsFull) == "function" then
		return inventory:IsFull()
	end
	local occupied = 0
	for _, item in pairs(inventory.itemslots or {}) do
		if IsValidEntity(item) then
			occupied = occupied + 1
		end
	end
	return inventory.maxslots ~= nil and occupied >= inventory.maxslots
end

function GPTAgentBrain:GatherPendingCount(session)
	local count = 0
	for _, _ in pairs(session.pendingGuids or {}) do
		count = count + 1
	end
	return count
end

function GPTAgentBrain:GatherOverflowCount(session)
	local count = 0
	for _, _ in pairs(session.overflowGuids or {}) do
		count = count + 1
	end
	return count
end

function GPTAgentBrain:RefreshGatherSession(session)
	-- First turn targets that disappeared, became unworkable, or left the
	-- command radius into explicit skips. This prevents a false "all done"
	-- result when another player takes a resource while the companion works.
	for guid, _ in pairs(session.pendingGuids) do
		if guid ~= session.currentTargetGuid and not self:IsGatherTargetInRange(session, Ents[guid]) then
			session.pendingGuids[guid] = nil
			session.processedGuids[guid] = true
			session.skipped = session.skipped + 1
		end
	end
	for guid, _ in pairs(session.overflowGuids or {}) do
		if not self:IsGatherTargetInRange(session, Ents[guid]) then
			session.overflowGuids[guid] = nil
			session.skipped = session.skipped + 1
		end
	end

	if session.scope == "all_same_prefab" then
		local x, _, z = self.inst.Transform:GetWorldPosition()
		local ents = TheSim:FindEntities(x, 0, z, GATHER_SEARCH_RANGE, nil, { "INLIMBO", "NOCLICK", "CLASSIFIED", "FX" }, nil)
		for _, entity in ipairs(ents or {}) do
			local guid = EntityGuid(entity)
			if guid ~= nil
				and self:IsGatherTargetInRange(session, entity)
				and session.pendingGuids[guid] == nil
				and session.overflowGuids[guid] == nil
				and session.processedGuids[guid] ~= true then
				if session.completed + session.skipped + self:GatherPendingCount(session) < MAX_GATHER_TARGETS then
					session.pendingGuids[guid] = true
				else
					session.limitReached = true
					session.overflowGuids[guid] = true
				end
			end
		end
	end

	local candidates = {}
	for guid, _ in pairs(session.pendingGuids) do
		local entity = Ents[guid]
		if self:IsGatherTargetInRange(session, entity) then
			candidates[#candidates + 1] = entity
		end
	end
	table.sort(candidates, function(left, right)
		local left_distance = self.inst:GetDistanceSqToInst(left)
		local right_distance = self.inst:GetDistanceSqToInst(right)
		if left_distance == right_distance then
			return EntityGuid(left) < EntityGuid(right)
		end
		return left_distance < right_distance
	end)

	session.remaining = #candidates + self:GatherOverflowCount(session)
	session.attempted = session.completed + session.remaining + session.skipped
	return candidates
end

function GPTAgentBrain:BuildGatherOutcome(session)
	if session == nil then
		return nil
	end
	return {
		gather = {
			scope = session.scope,
			mode = session.mode,
			targetPrefab = session.targetPrefab,
			attempted = math.floor(Clamp(session.attempted, 0, MAX_GATHER_RESULT_TARGETS, 0)),
			completed = math.floor(Clamp(session.completed, 0, MAX_GATHER_RESULT_TARGETS, 0)),
			remaining = math.floor(Clamp(session.remaining, 0, MAX_GATHER_RESULT_TARGETS, 0)),
			skipped = math.floor(Clamp(session.skipped, 0, MAX_GATHER_RESULT_TARGETS, 0)),
		},
	}
end

function GPTAgentBrain:SetCurrentCommandAction(command, action, target, invobject, recipe, preserve_runtime)
	if not preserve_runtime then
		self:InterruptLocalAction("new command action", false)
	end
	local target_guid = EntityGuid(target)
	local inv_guid = EntityGuid(invobject)
	local wfn = ActionWfn(command, action)
	self.CurrentAction = {
		Type = "Action",
		Action = action,
		Target = target_guid ~= nil and tostring(target_guid) or "-",
		Name = wfn,
		WFN = wfn,
		InvObject = inv_guid ~= nil and tostring(inv_guid) or "-",
		Recipe = recipe or "-",
		PosX = "-",
		PosY = "-",
		PosZ = "-",
	}
	self.ActiveActionWFN = wfn
end

function GPTAgentBrain:StartNextGatherTarget(target)
	local session = self.GPTGatherSession
	if session == nil or self.ActiveCommand == nil or target == nil then
		return false
	end
	local target_guid = EntityGuid(target)
	if target_guid == nil then
		return false
	end
	session.currentTargetGuid = target_guid
	local action = WORK_ACTION_BY_GATHER_MODE[session.mode] or "PICKUP"
	if session.mode == "collect" and target:HasTag("pickable") then
		action = "PICK"
	end
	self:SetCurrentCommandAction(self.ActiveCommand, action, target, nil, nil, true)
	return true
end

function GPTAgentBrain:FinishGatherTarget(status, reason)
	local session = self.GPTGatherSession
	if session == nil or self.ActiveCommand == nil then
		return
	end
	local target_guid = session.currentTargetGuid
	session.currentTargetGuid = nil
	if target_guid == nil then
		self:CompleteActiveCommand("failed", "gather action lost its target")
		return
	end
	session.pendingGuids[target_guid] = nil
	session.processedGuids[target_guid] = true
	if status == "succeeded" then
		session.completed = session.completed + 1
	else
		session.skipped = session.skipped + 1
	end

	local candidates = self:RefreshGatherSession(session)
	-- Report every resolved target, including the last one.  The Gateway keeps
	-- this non-terminal update separate from the one truthful terminal result.
	local progress_reason = status == "succeeded" and "gather target completed" or SafeText(reason or "gather target skipped", MAX_RESULT_REASON)
	self:ReportCommandResult(self.ActiveCommand.id, "progress", progress_reason, self:BuildGatherOutcome(session))
	if #candidates > 0 and self:IsGatherInventoryFull() then
		self:CompleteActiveCommand("partial", "inventory full")
		return
	end
	if #candidates > 0 then
		if not self:StartNextGatherTarget(candidates[1]) then
			self:CompleteActiveCommand("partial", "next gather target is unavailable")
		end
		return
	end

	if session.limitReached then
		self:CompleteActiveCommand("partial", "gather target limit reached")
	elseif session.skipped > 0 then
		self:CompleteActiveCommand("partial", SafeText(reason or "one or more gather targets were unavailable", MAX_RESULT_REASON))
	elseif session.completed > 0 then
		-- A gather command is only successful once a rescan has proved that
		-- no same-prefab, in-range resources remain.
		self:CompleteActiveCommand("succeeded")
	else
		self:CompleteActiveCommand("failed", SafeText(reason or "no gather target completed", MAX_RESULT_REASON))
	end
end

function GPTAgentBrain:ApplyGatherCommand(command)
	local args = command.args or {}
	local leader = self:EnsurePlayerTarget(nil)
	if not IsValidEntity(leader) or math.sqrt(self.inst:GetDistanceSqToInst(leader)) > PLAYER_LEASH_RANGE then
		return nil, "player is not nearby"
	end
	local mode = "collect"
	if args.mode == "chop" or args.mode == "mine" then
		mode = args.mode
	end
	local scope = args.scope == "all_same_prefab" and "all_same_prefab" or "single"
	local target = self:ResolveGatherTarget(mode, args.targetGuid, args.targetPrefab)
	if target == nil then
		return nil, "no valid nearby gather target"
	end
	local target_prefab = CanonicalGatherPrefab(args.targetPrefab)
	if target_prefab == "" then
		target_prefab = CanonicalGatherPrefab(target.prefab)
	end
	self:InterruptLocalAction("start gather", false, true)
	self.GPTGatherSession = {
		scope = scope,
		mode = mode,
		targetPrefab = target_prefab,
		pendingGuids = {},
		overflowGuids = {},
		processedGuids = {},
		currentTargetGuid = nil,
		attempted = 0,
		completed = 0,
		remaining = 0,
		skipped = 0,
		limitReached = false,
	}
	local session = self.GPTGatherSession
	local target_guid = EntityGuid(target)
	if target_guid ~= nil then
		session.pendingGuids[target_guid] = true
	end
	local candidates = self:RefreshGatherSession(session)
	if #candidates < 1 then
		self:CompleteActiveCommand("failed", "no valid nearby gather target")
		return "completed"
	end
	if self:IsGatherInventoryFull() then
		self:CompleteActiveCommand("partial", "inventory full")
		return "completed"
	end
	if not self:StartNextGatherTarget(candidates[1]) then
		self:CompleteActiveCommand("failed", "gather action could not start")
		return "completed"
	end
	return true
end

function GPTAgentBrain:ApplyAttackCommand(command)
	local args = command.args or {}
	local target = nil
	if IsFiniteNumber(args.targetGuid) then
		target = Ents[math.floor(args.targetGuid)]
	else
		target = self:FindNearbyAttackTarget()
	end
	local valid, reason = self:ValidateAttackTarget(target, args.confirmed == true)
	if not valid then
		return nil, reason
	end
	self:SetCurrentCommandAction(command, "ATTACK", target, nil, nil)
	self.GPTCommandCombatTarget = target
	self.inst.components.combat:SetTarget(target)
	return true
end

function GPTAgentBrain:ValidateAttackTarget(target, confirmed)
	if not IsVisibleEntity(target) or self.inst.components.combat == nil or not self.inst.components.combat:CanAttack(target) then
		return false, "no valid nearby attack target"
	end
	if not IsNearAttackRange(self.inst, target) then
		return false, "attack target is outside command range"
	end
	if not confirmed and not HasAnyHostileLabel(target) then
		return false, "attack target requires confirmation"
	end
	return true
end

function GPTAgentBrain:FindNearbyAttackTarget()
	local x, _, z = self.inst.Transform:GetWorldPosition()
	local ents = TheSim:FindEntities(x, 0, z, ATTACK_COMMAND_RANGE, nil, { "INLIMBO", "NOCLICK", "CLASSIFIED", "FX" }, nil)
	for _, entity in ipairs(ents or {}) do
		if entity ~= self.inst
			and IsVisibleEntity(entity)
			and self.inst.components.combat ~= nil
			and self.inst.components.combat:CanAttack(entity)
			and HasAnyHostileLabel(entity) then
			return entity
		end
	end
	return nil
end

function GPTAgentBrain:ApplyEquipOrEatCommand(command)
	local args = command.args or {}
	local action = args.action == "equip" and "equip" or "eat"
	local item_name = SafeText(args.itemName or "", 64)
	if item_name == "" then
		return nil, "equip_or_eat requires itemName"
	end
	local item = nil
	if action == "equip" then
		item = FindInventoryItem(self.inst, item_name, function(candidate)
			return candidate.components ~= nil and candidate.components.equippable ~= nil
		end)
		if item == nil then
			return nil, "no equippable inventory item"
		end
		self:SetCurrentCommandAction(command, "EQUIP", nil, item, nil)
	else
		item = FindInventoryItem(self.inst, item_name, function(candidate)
			return self.inst.components.eater ~= nil and self.inst.components.eater:CanEat(candidate)
		end)
		if item == nil then
			return nil, "no edible inventory item"
		end
		self:SetCurrentCommandAction(command, "EAT", nil, item, nil)
	end
	return true
end

function GPTAgentBrain:ApplyGiveItemCommand(command)
	local args = command.args or {}
	local item_name = SafeText(args.itemName, 64)
	if item_name == "" then
		return nil, "give_item requires itemName"
	end
	if not IsOrdinaryGiveItem(item_name) and args.confirmed ~= true then
		return nil, "give_item requires player confirmation"
	end
	local leader = self:EnsurePlayerTarget(nil)
	if not IsValidEntity(leader) or math.sqrt(self.inst:GetDistanceSqToInst(leader)) > NEARBY_RANGE then
		return nil, "player is not nearby"
	end
	local item = FindInventoryItem(self.inst, item_name, nil)
	if item == nil then
		return nil, "item is not in inventory"
	end
	local requested_quantity = math.floor(Clamp(args.quantity, 1, 40, 1))
	local exact_item = FindInventoryItem(self.inst, item_name, function(candidate)
		return ItemStackSize(candidate) == requested_quantity
	end)
	if exact_item == nil then
		local enough_item = FindInventoryItem(self.inst, item_name, function(candidate)
			return ItemStackSize(candidate) >= requested_quantity
		end)
		if enough_item ~= nil then
			return nil, "cannot give partial stack quantity safely"
		end
		return nil, "not enough item quantity"
	end
	self:SetCurrentCommandAction(command, "GIVETOPLAYER", leader, item, nil)
	self.GPTGiveItemName = exact_item.prefab
	self.GPTGiveQuantity = requested_quantity
	return true
end

function GPTAgentBrain:FindGiveItem()
	if self.GPTGiveItemName == nil or self.inst.components.inventory == nil then
		return nil
	end
	return FindInventoryItem(self.inst, self.GPTGiveItemName, function(candidate)
		return ItemStackSize(candidate) == self.GPTGiveQuantity
	end)
end

function GPTAgentBrain:CheckItemToGive()
	if self.CurrentAction ~= nil and self.CurrentAction.Action == "GIVETOPLAYER" then
		local item = self:FindGiveItem()
		if item ~= nil then
			return true, item
		end
		return false, nil
	end
	return LegacyBrain.CheckItemToGive(self)
end

function GPTAgentBrain:Give()
	local was_gpt_give = self.ActiveCommand ~= nil and self.CurrentAction ~= nil and self.CurrentAction.Action == "GIVETOPLAYER"
	if was_gpt_give and self:FindGiveItem() == nil then
		self:CompleteActiveCommand("failed", "requested give quantity is unavailable")
		self.CurrentAction = nil
		return nil
	end
	local action = LegacyBrain.Give(self)
	if action ~= nil and self.ActiveCommand ~= nil then
		action:AddSuccessAction(function()
			self:CompleteActiveCommand("succeeded")
		end)
		action:AddFailAction(function()
			self:CompleteActiveCommand("failed", "give action failed")
		end)
	elseif action == nil and was_gpt_give then
		self:CompleteActiveCommand("failed", "give action could not start")
	end
	return action
end

function GPTAgentBrain:OnActionEndEvent(name, value)
	if self.ActiveCommand ~= nil and self.ActiveActionWFN ~= nil and name == self.ActiveActionWFN then
		if self.ActiveCommand.kind == "gather_nearby" then
			-- Gather completion is measured by the BufferedAction callbacks after
			-- a rescan, not by the legacy action event alone.
			return
		end
		self:CompleteActiveCommand("succeeded")
	end
end

function GPTAgentBrain:OnPropertyChangedEvent(name, value)
end

function GPTAgentBrain:OnDeleteEntity(guid)
end

function GPTAgentBrain:ClearAction()
	if self.CurrentAction ~= nil and self.ActiveCommand ~= nil then
		self:CompleteActiveCommand("cancelled", "action cleared")
	end
	self.CurrentAction = nil
end

function GPTAgentBrain:DropCommandCombatTarget()
	if self.GPTCommandCombatTarget == nil or self.inst.components == nil or self.inst.components.combat == nil then
		self.GPTCommandCombatTarget = nil
		return
	end
	local combat = self.inst.components.combat
	if combat.target == self.GPTCommandCombatTarget then
		combat:DropTarget()
	end
	if combat.lastattacker == self.GPTCommandCombatTarget then
		combat.lastattacker = nil
	end
	self.GPTCommandCombatTarget = nil
end

function GPTAgentBrain:InterruptLocalAction(reason, report_active, preserve_gather_session)
	if report_active and self.ActiveCommand ~= nil then
		self:CompleteActiveCommand("cancelled", SafeText(reason, MAX_RESULT_REASON))
	end
	self:DropCommandCombatTarget()
	self.CurrentAction = nil
	self.Utterance = nil
	self.Keyword = nil
	self.UttAction = nil
	self.GPTGiveItemName = nil
	self.GPTGiveQuantity = 1
	if not preserve_gather_session then
		self.GPTGatherSession = nil
	end
	self.GPTMovementTargetGuid = nil
	self.ActiveActionWFN = nil
	if self.inst.ClearBufferedAction ~= nil then
		self.inst:ClearBufferedAction()
	end
	if self.inst.components ~= nil and self.inst.components.locomotor ~= nil then
		self.inst.components.locomotor:Clear()
		if self.inst.components.locomotor.isrunning then
			self.inst.components.locomotor:StopMoving()
		end
	end
end

function GPTAgentBrain:ExpireActiveCommand()
	if self.ActiveCommand ~= nil and IsFiniteNumber(self.ActiveCommand.expiresAt) and self.ActiveCommand.expiresAt <= NowMs() then
		if self.ActiveCommand.kind == "gather_nearby" and self.GPTGatherSession ~= nil then
			self:CompleteActiveCommand("partial", "command expired")
			self:InterruptLocalAction("command expired", false)
		else
			self:InterruptLocalAction("command expired", true)
		end
	end
end

function GPTAgentBrain:ReportCommandResult(command_id, status, reason, outcome)
	local body = {
		id = command_id,
		status = status,
		stateRevision = self.StateRevision or 0,
	}
	if type(reason) == "string" and reason ~= "" then
		body.reason = SafeText(reason, MAX_RESULT_REASON)
	end
	if type(outcome) == "table" then
		body.outcome = outcome
	end
	TheSim:QueryServer(
		self:GatewayPath("/results"),
		self.OnGatewayResult,
		"POST",
		json.encode(body))
end

function GPTAgentBrain:CompleteActiveCommand(status, reason)
	if self.ActiveCommand == nil then
		return
	end
	local command_id = self.ActiveCommand.id
	local gather_outcome = nil
	if self.ActiveCommand.kind == "gather_nearby" and self.GPTGatherSession ~= nil and status ~= "started" then
		gather_outcome = self:BuildGatherOutcome(self.GPTGatherSession)
	end
	self:ReportCommandResult(command_id, status, reason, gather_outcome)
	if status ~= "started" and status ~= "progress" then
		self.ActiveCommand = nil
		self.ActiveActionWFN = nil
		self.GPTGiveItemName = nil
		self.GPTGiveQuantity = 1
		self.GPTGatherSession = nil
	end
end

function GPTAgentBrain:OnResultPosted(result, isSuccessful, http_code)
	if not isSuccessful then
		print("[DST GPT Agent] Result post failed: " .. tostring(http_code))
		self:EnterGatewayStandby("result post failed")
		return
	end
	self:MarkGatewayOnline()
end

function GPTAgentBrain:ForwardPlayerInput(text, userid)
	local safe_text = SafeText(text, MAX_TEXT_LENGTH)
	if safe_text == "" then
		return false
	end
	self.PlayerInputSequence = (self.PlayerInputSequence or 0) + 1
	local body = {
		id = self.CompanionId .. "-input-" .. tostring(self.PlayerInputSequence),
		userid = type(userid) == "string" and SafeText(userid, 128) or nil,
		text = safe_text,
		source = "game",
	}
	TheSim:QueryServer(
		self:GatewayPath("/player-input"),
		function(result, isSuccessful, http_code)
			if not isSuccessful then
				print("[DST GPT Agent] Player input forward failed: " .. tostring(http_code))
				self:EnterGatewayStandby("player input forward failed")
				return
			end
			self:MarkGatewayOnline()
		end,
		"POST",
		json.encode(body))
	return true
end

function GPTAgentBrain:QueueTextCommand(text, userid)
	local normalized = LowerText(text)
	if normalized == "" then
		return false
	end
	self:ForwardPlayerInput(text, userid)
	if LOCAL_STOP_TEXT[normalized] then
		self:InterruptLocalAction("local player stop", true)
		self.UttAction = "Stop"
		self.Utterance = "stop"
		return true
	elseif LOCAL_YES_TEXT[normalized] then
		return true
	elseif LOCAL_NO_TEXT[normalized] then
		return true
	end
	return true
end

function GPTAgentBrain:SayAI(text)
	text = SafeText(text, MAX_TEXT_LENGTH)
	if text == "" then
		return false
	end
	local now = NowMs()
	if self.LastAISayAt ~= nil and now - self.LastAISayAt < AI_SPEECH_MIN_INTERVAL_MS then
		return false
	end
	local delivered = false
	if self.inst.components ~= nil and self.inst.components.talker ~= nil then
		local ok = pcall(function()
			self.inst.components.talker:Say(text)
		end)
		delivered = delivered or ok
	end
	if TheNet ~= nil and TheNet.SystemMessage ~= nil then
		local ok = pcall(function()
			TheNet:SystemMessage("[AI] " .. text)
		end)
		delivered = delivered or ok
	end
	if delivered then
		self.LastAISayAt = now
	end
	return delivered
end

return GPTAgentBrain
