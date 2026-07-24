-- Debug Helpers
GLOBAL.CHEATS_ENABLED = true
GLOBAL.DEBUG_MENU_ENABLED = true
GLOBAL.require 'debugkeys' 
GLOBAL.require 'debughelpers'

io = GLOBAL.io
local io =  GLOBAL.require "io"
local os = GLOBAL.require "os"
graph_data = MODROOT.."graph_data.csv"

-- Modern DST rejects arbitrary file writes from mods. The legacy CSV graph exporter
-- is therefore disabled; it is unrelated to the companion's FAtiMA communication.
local graph_switch = 0
local header = ""
local dt = nil

local ArtificalWalterEnabled = false
local text_command_hook_wrapper = nil

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

local function SetSelfAI()
	local brain = GLOBAL.require "brains/fatimabrain"
	GLOBAL.ThePlayer:SetBrain(brain)
	GLOBAL.ThePlayer:RestartBrain()
	ArtificalWalterEnabled = true
end

local function SetSelfNormal()
	local brain = GLOBAL.require "brains/wilsonbrain"
	GLOBAL.ThePlayer:SetBrain(brain)
	GLOBAL.ThePlayer:RestartBrain()
	ArtificalWalterEnabled = false
end

local function MakeClickableBrain(self, owner)
	local BrainBadge = self
	
    BrainBadge:SetClickable(true)

    -- Make the brain pulse for a cool effect
	local x = 0
	local darker = true
	local function BrainPulse(self)
		if not darker then
			x = x+.1
			if x >=1 then
				darker = true
				x = 1
			end
		else 
			x = x-.1
			if x <=.5 then
				darker = false
				x = .5
			end
		end

		BrainBadge.anim:GetAnimState():SetMultColour(x,x,x,1)
		self.BrainPulse = self:DoTaskInTime(.15, BrainPulse)
	end
	
	BrainBadge.OnMouseButton = function(self,button,down,x,y)	
		if down == true and GLOBAL.TheWorld.ismastersim then
			if ArtificalWalterEnabled then
				self.owner.BrainPulse:Cancel()
				BrainBadge.anim:GetAnimState():SetMultColour(1,1,1,1)
				SetSelfNormal()
			else
				BrainPulse(self.owner)
				SetSelfAI()
			end
		end
	end
end

local function GetPerceptionData() 
	local brain = GLOBAL.require "brains/fatimabrain"
	dt = brain.ReturnPerceptionData()
end

local function ReturnHeaderlist() 
	local str = ""
	local num = 0 
	if dt ~= nil then
		for i, _ in pairs(dt) do 
			str = str .. "\n".. tostring(num) .. " : " .. tostring(i) 
			num = num + 1
		end
	end
	return str
end 

local function WriteCSVHeader()

	if header == "" and dt ~= nil then
    	for k, v in pairs(dt) do  
			if type(v) ~= "table" then 
				if header == "" then header = tostring(k) else header = header..",".. tostring(k) end
			end
		end
		file:write(header) 
		file:write("\n") 

		-- print(ReturnHeaderlist())
		GLOBAL.TheNet:SystemMessage("Header has been written")
	end
end 

local function WriteGraphData()

	local row = ""
	local h = {}
	for w in (header .. ","):gmatch("([^,]*),") do -- split header string into each cols ("," split)
		table.insert(h, w) 
	end

	if header ~= "" and dt ~= nil then 
		for k, v in pairs(h) do 

			if dt[v] ~= nil and type(dt[v]) ~= 'table' then 
				if row == "" then row = tostring(dt[v]) else row = row..",".. tostring(dt[v]) end
			else
				if row == "" then row = "None" else row = row..",".. "None" end
			end
		end

		file:write(row) 
		file:write("\n") 
	end
end


AddClassPostConstruct("widgets/sanitybadge", MakeClickableBrain)

local function FindPortal()
	local ents = GLOBAL.TheSim:FindEntities(0, 0, 0, 10000, {"antlion_sinkhole_blocker"}) 
    for i, v in ipairs(ents) do
        if v.entity:IsVisible() and v.prefab == "multiplayer_portal" then
            return v
        end
    end
end

AddSimPostInit(function ()

	if GLOBAL.TheWorld.ismastersim and GetModConfigData('fatima-character-num') > 0 then
		InstallTextCommandHook()
		-- Find the Portal
		local portal = FindPortal()
		if portal == nil then
			print("[DST AI Companion] No multiplayer portal was found; companion spawn was skipped.")
			return
		end

		-- Spawn the characters required in the mod config
		local i = 0
		while i < GetModConfigData("fatima-character-num") do
			local char = GLOBAL.SpawnPrefab("wx78") -- change wilson to wx78 

			char:AddTag("FAtiMA-Brain")
		
			-- Move Spawned characters near the portal
			char.Transform:SetPosition(portal.Transform:GetWorldPosition())

			local brain = GLOBAL.require "brains/fatimabrain"
			char:SetBrain(brain)
			char:RestartBrain()
			i = i + 1
		end

	end
		
end)

AddGamePostInit(function() -- just called the func once
	-- The legacy CSV graph exporter is disabled because current dedicated servers
	-- reject arbitrary Mod file writes.
end
)

AddPlayerPostInit(function()
	if graph_switch == 1 then 
	GLOBAL.TheWorld:DoPeriodicTask(1, GetPerceptionData)
	GLOBAL.TheWorld:DoPeriodicTask(1, WriteCSVHeader)
	GLOBAL.TheWorld:DoPeriodicTask(1, WriteGraphData)
	end
end
)
