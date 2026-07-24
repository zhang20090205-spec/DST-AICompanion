# DST-AICompanion

`DST-AICompanion` is a server-side companion Mod for Don't Starve Together. It
spawns a WX-78 companion, sends its perception data to the included FAtiMA
server, and executes the server's decisions in the game world.

This repository originated as an academic prototype based on FAtiMA-DST. It has
been updated locally for current DST dedicated-server restrictions.

## Local installation

The editable repository and the installed Mod are kept in sync at:

| Purpose | Local path |
| --- | --- |
| Editable source | `E:\advx饥荒\DST-AICompanion-source` |
| Installed DST Mod | `D:\steam\steamapps\common\Don't Starve Together\mods\DST-AICompanion` |
| FAtiMA server | `E:\advx饥荒\DST-AICompanion-source\FAtiMA-Server\FAtiMA-Server.exe` |

Start `FAtiMA-Server.exe`, then host or restart a world with **The AI Companion**
enabled. The server must keep running while the companion is active. Use one
companion first; the original AI state is largely global and has not been
validated for multiple companions.

## Player commands

Text commands are enabled by default and work without any speech-recognition
software. Only public, non-emote chat messages beginning with the configured
prefix are handled; normal chat, whispers, and emotes remain unchanged.

Default prefix: `!ai`

| Command examples | Effect |
| --- | --- |
| `!ai follow`, `!ai 跟我` | Follow the player who sent the command |
| `!ai stop`, `!ai 停下` | Wait in place |
| `!ai help`, `!ai 救我` | Approach the player |
| `!ai attack`, `!ai 攻击` | Attack the player's current combat target |
| `!ai home`, `!ai 回基地` | Return to the companion's home portal/camp |
| `!ai explore`, `!ai 找资源` | Wander and explore |
| `!ai give grass`, `!ai 给我石头` | Drop the requested resource when available |
| `!ai resume`, `!ai 继续` | Clear the manual command and resume autonomous behavior |

The Mod options can disable text commands or change the prefix to `/ai`.
The companion acknowledges recognized commands in a speech bubble. Unknown
commands do not change its behavior.

## Feature status

| Feature | Status | Notes |
| --- | --- | --- |
| Spawn and autonomous FAtiMA control | Available | WX-78 sends perceptions to `localhost:8080` and executes decisions. |
| World perception and HTTP decision loop | Available | Perception, decision, action-end, property-change, and delete events are implemented. |
| Resource work and survival actions | Available when selected by FAtiMA | The Mod contains pickup, chop, mine, hammer, dig, craft, eat, combat, and item-drop paths. |
| Personality options | Available | `Adventurer`, `Camper`, `Supporter`, and `None` are configurable. |
| Player text interaction | Available | Added here through the protected `Networking_Say` server hook. |
| Voice interaction from the upstream README | Not bundled | It requires a separate `Speech System`; upstream does not include it. `Enable Speech` stays off by default. |
| Graph CSV export | Disabled | Current DST servers reject arbitrary Mod file writes, which previously crashed the server. |
| Stuck recovery | Available | The brain resets itself after repeated no-progress checks. `Ctrl+R` remains a manual recovery option. |
| Multiple companions | Not validated | The original brain shares global state; use one companion. |

## Important compatibility fixes

- The screen spam `服务器 UttAction: None` was an unconditional debug message
  emitted every perception tick, not a server error. It has been removed.
- The legacy graph exporter no longer opens files in the Mod directory, avoiding
  current DST's `invalid filepath` failure.
- Follower/leader access is guarded so the companion can start before a player
  has been assigned.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| Number of characters | 1 | Number of WX-78 companions to spawn. One is recommended. |
| Personality | None | Selects the FAtiMA personality profile. |
| Enable Text Commands | ON | Enables public-chat command handling. |
| Chat Prefix | `!ai` | Command prefix, selectable as `!ai` or `/ai`. |
| Enable Speech | OFF | Requires the unavailable external Speech System. |
| Enable Showing Graph | OFF | Retained for compatibility; CSV output is disabled. |

## Validation

Run the regression checks from the editable source directory:

```powershell
cd E:\advx饥荒\DST-AICompanion-source
npm test
```

The checks validate the Lua source structure without adding dependencies. Full
game behavior still requires an active DST server and the FAtiMA executable.

## Upstream

- Original repository: <https://github.com/votus777/DST-AICompanion>
- FAtiMA toolkit: <https://github.com/GAIPS/FAtiMA-Toolkit>
