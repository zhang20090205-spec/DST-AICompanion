export const COMMAND_KINDS = [
  "say_in_game",
  "follow_player",
  "stop_and_wait",
  "approach_or_retreat",
  "gather_nearby",
  "attack_nearby_threat",
  "equip_or_eat",
  "give_item",
  "clear_action_queue",
] as const;

export const COMMAND_PRIORITIES = ["interrupt", "player", "autonomy"] as const;

export type CommandKind = (typeof COMMAND_KINDS)[number];
export type CommandPriority = (typeof COMMAND_PRIORITIES)[number];
export type CommandStatus = "started" | "succeeded" | "failed" | "cancelled";

export interface Position {
  x: number;
  z: number;
}

export interface NearbyEntity {
  guid: number;
  prefab: string;
  distance: number;
  tags: string[];
  collectable?: boolean;
  choppable?: boolean;
  mineable?: boolean;
  attackable?: boolean;
  edible?: boolean;
  equippable?: boolean;
}

export interface CompanionState {
  revision: number;
  receivedAt: number;
  health: number | null;
  hunger: number | null;
  sanity: number | null;
  temperature: number | null;
  position: Position;
  player: {
    guid: number | null;
    userid: string | null;
    distance: number | null;
    position: Position | null;
  };
  inventory: Array<{ prefab: string; quantity: number; guid?: number }>;
  nearby: NearbyEntity[];
  world: {
    phase: string;
    isDay: boolean;
    isDusk: boolean;
    isNight: boolean;
  };
  currentAction: string | null;
  isBusy: boolean;
  isNearDanger: boolean;
}

export interface Command {
  id: string;
  epoch: number;
  priority: CommandPriority;
  kind: CommandKind;
  args: Record<string, unknown>;
  expiresAt: number;
}

export interface CommandResult {
  id: string;
  status: CommandStatus;
  reason?: string;
  stateRevision: number;
}

export interface PlayerInput {
  id?: string;
  userid?: string;
  text: string;
  source: "game" | "voice" | "browser";
}

export interface PendingConfirmation {
  id: string;
  companionId: string;
  requestedAt: number;
  expiresAt: number;
  prompt: string;
  command: Omit<Command, "id" | "epoch" | "expiresAt">;
}
