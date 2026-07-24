local text_command_hook_wrapper = nil
local tonumber = GLOBAL.tonumber

local function GetCompanionConfig(name)
	return GetModConfigData(name)
end

local function FindCompanionBrain()
	for _, entity in pairs(GLOBAL.Ents or {}) do
		if entity ~= nil and entity:IsValid() and entity:HasTag("FAtiMA-Brain") then
			local brain = entity.brain
			if brain ~= nil and brain.QueueTextCommand ~= nil then
				return brain
			end
		end
	end
end

local function HandleTextCommand(userid, message, whisper, isemote)
	if GetCompanionConfig("Enable Text Commands") ~= 1
		or whisper == true or isemote == true or type(message) ~= "string" then
		return
	end

	local prefix = GetCompanionConfig("Chat Prefix") or "!ai"
	if string.sub(string.lower(message), 1, #prefix) ~= string.lower(prefix) then
		return
	end

	local command = string.gsub(string.sub(message, #prefix + 1), "^%s*(.-)%s*$", "%1")
	if command == "" then
		return
	end

	local brain = FindCompanionBrain()
	if brain ~= nil then
		brain:QueueTextCommand(command, userid)
	end
end

local function InstallTextCommandHook()
	if not GLOBAL.TheWorld.ismastersim or type(GLOBAL.Networking_Say) ~= "function" then
		return
	end

	if text_command_hook_wrapper == GLOBAL.Networking_Say then
		return
	elseif text_command_hook_wrapper ~= nil then
		print("[DST AI Companion] Networking_Say was replaced; text commands are disabled.")
		return
	end

	local original_networking_say = GLOBAL.Networking_Say
	text_command_hook_wrapper = function(guid, userid, name, prefab, message, colour, whisper, isemote, user_vanity)
		original_networking_say(guid, userid, name, prefab, message, colour, whisper, isemote, user_vanity)
		HandleTextCommand(userid, message, whisper, isemote)
	end
	GLOBAL.Networking_Say = text_command_hook_wrapper
end

local function FindPortal()
	local ents = GLOBAL.TheSim:FindEntities(0, 0, 0, 10000, {"antlion_sinkhole_blocker"}) 
    for i, v in ipairs(ents) do
        if v.entity:IsVisible() and v.prefab == "multiplayer_portal" then
            return v
        end
    end
end

AddSimPostInit(function ()

	local requested_companion_count = tonumber(GetModConfigData('fatima-character-num')) or 0
	local companion_count = math.min(1, math.max(0, requested_companion_count))
	if GLOBAL.TheWorld.ismastersim and companion_count > 0 then
		InstallTextCommandHook()
		-- Find the Portal
		local portal = FindPortal()
		if portal == nil then
			print("[DST AI Companion] No multiplayer portal was found; companion spawn was skipped.")
			return
		end

		-- Spawn the characters required in the mod config
		local i = 0
		while i < companion_count do
			local char = GLOBAL.SpawnPrefab("wx78") -- change wilson to wx78 

			char:AddTag("FAtiMA-Brain")
		
			-- Move Spawned characters near the portal
			char.Transform:SetPosition(portal.Transform:GetWorldPosition())

			local brain = GLOBAL.require "brains/gptagentbrain"
			char:SetBrain(brain)
			char:RestartBrain()
			i = i + 1
		end

	end
		
end)
