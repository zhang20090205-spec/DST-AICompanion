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
export const GATHER_SCOPES = ["single", "all_same_prefab"] as const;
export const GATHER_MODES = ["collect", "chop", "mine"] as const;
export const FEEDBACK_POLICIES = ["silent_success", "issues_only", "always_result"] as const;
export const FEEDBACK_CHANNELS = ["voice_only_preamble"] as const;

export type CommandKind = (typeof COMMAND_KINDS)[number];
export type CommandPriority = (typeof COMMAND_PRIORITIES)[number];
export type GatherScope = (typeof GATHER_SCOPES)[number];
export type GatherMode = (typeof GATHER_MODES)[number];
export type CommandStatus = "started" | "progress" | "succeeded" | "partial" | "failed" | "cancelled";
export type FeedbackPolicy = (typeof FEEDBACK_POLICIES)[number];
export type FeedbackChannel = (typeof FEEDBACK_CHANNELS)[number];

export interface Position {
  x: number;
  z: number;
}

export interface NearbyEntity {
  guid: number;
  prefab: string;
  distance: number;
  position?: Position;
  playerDistance?: number;
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

export interface GatherProgress {
  scope: GatherScope;
  mode: GatherMode;
  targetPrefab: string;
  attempted: number;
  completed: number;
  remaining: number;
  skipped: number;
}

export interface CommandOutcome {
  gather?: GatherProgress;
}

export interface CommandResult {
  id: string;
  status: CommandStatus;
  reason?: string;
  stateRevision: number;
  outcome?: CommandOutcome;
}

export interface FeedbackDirective {
  policy: FeedbackPolicy;
  channel: FeedbackChannel;
}

export type PlayerInputAction = "forwarded" | "duplicate" | "interrupted" | "confirmed" | "rejected" | "routed" | "blocked";
export type PlayerInputRoute = "realtime" | "local_safety" | "confirmation" | "fast_intent";

export interface SafeCommandSummary {
  id: string;
  kind: CommandKind;
  args: Record<string, unknown>;
  feedback: FeedbackDirective;
}

export interface PlayerInput {
  id?: string;
  userid?: string;
  text: string;
  source: "game" | "voice" | "browser";
}

export interface PlayerInputReceipt {
  action: PlayerInputAction;
  inputId?: string;
  route?: PlayerInputRoute;
  intent?: string;
  reason?: string;
  confirmation?: string;
  command?: SafeCommandSummary;
}

export interface PendingConfirmation {
  id: string;
  companionId: string;
  requestedAt: number;
  expiresAt: number;
  prompt: string;
  command: Omit<Command, "id" | "epoch" | "expiresAt">;
}
