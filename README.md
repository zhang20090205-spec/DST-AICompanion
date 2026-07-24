# DST AI Companion: GPT Live Agent

This repository runs one local Don't Starve Together companion as a Chinese
voice-and-text game agent. The old FAtiMA executable is retained only for
historical compatibility. GPT Live mode does not use it.

## What runs where

```text
DST Mod (Lua) <--- localhost HTTP ---> Agent Gateway (Node.js)
                                             |
                                             +--- Browser voice companion <--- WebRTC ---> OpenAI Realtime
```

The Lua Mod reports a compact, untrusted game snapshot and polls typed commands.
It never executes model-provided Lua. The Gateway validates every command, keeps
an interrupt epoch, and stores only local preferences, task summaries, and action
audits. Browser audio goes directly to OpenAI using a short-lived client secret;
`OPENAI_API_KEY` remains in the local Gateway process.

## Local paths

| Purpose | Path |
| --- | --- |
| Editable source | `E:\advx饥荒\DST-AICompanion-source` |
| Installed DST Mod | `D:\steam\steamapps\common\Don't Starve Together\mods\DST-AICompanion` |
| Gateway | `E:\advx饥荒\DST-AICompanion-source\agent-gateway` |
| Retired legacy service | `E:\advx饥荒\DST-AICompanion-source\FAtiMA-Server\FAtiMA-Server.exe` |

## Start GPT Live mode

1. In `agent-gateway/.env`, set `OPENAI_API_KEY` to your OpenAI API key. This
   file is ignored by Git. Optionally set `OPENAI_REALTIME_MODEL`,
   `OPENAI_REALTIME_VOICE`, and `DST_GATEWAY_DATABASE`.
2. Run `powershell -ExecutionPolicy Bypass -File .\scripts\Start-DST-GPT-Agent.ps1`
   from this repository. The script builds the Gateway, stops only the identified
   legacy FAtiMA process, confirms that port 8080 is free, then starts the local
   Gateway on `127.0.0.1:8080`.
3. Open `http://127.0.0.1:8080` in a browser, allow microphone access, and select
   the voice connection button.
4. Host or restart a local DST world with **The AI Companion** enabled.

The Gateway intentionally fails closed: if it loses the voice session or game
connection, it queues an immediate stop and the companion waits. It does not
fall back to FAtiMA.

## In-game interaction

The default chat prefix is `!ai`.

| Input | Result |
| --- | --- |
| `!ai 跟着我，附近有树就砍一棵` | Sends natural-language intent to the Gateway/Realtime session. |
| `!ai stop` or `!ai 停下` | Stops immediately in Lua, then notifies the Gateway. |
| `!ai yes` / `!ai no` | Accepts or rejects an active high-risk confirmation. |
| Browser microphone | Chinese VAD interaction; player speech interrupts the current reply and game action. |

The companion can speak in a bubble and emits `[AI]` messages into DST chat. Its
allowed actions are follow, stop, approach/retreat, nearby ordinary gathering,
nearby hostile defense, equip/eat, give ordinary items, and speak. Building,
crafting, long-range exploration, attacking non-hostile targets, and rare-item
consumption require confirmation.

## Safety contract

- Gateway binds only to `127.0.0.1`.
- Commands contain `id`, `epoch`, `priority`, `kind`, `args`, and `expiresAt`.
  `interrupt > player > autonomy`; stale epochs and expired commands are ignored.
- The Mod and Gateway both validate entity IDs, distances, command kinds, and
  text length.
- Raw audio and persistent transcripts are not stored. Local SQLite contains
  only explicit memory values, task/audit metadata, and attributed knowledge.
- The bundled Markdown knowledge package is derived from the MIT-licensed
  `morandot/dont-starve-skill` at pinned commit
  `12dc27d3b6d0a261f0fbd14a046d492cba8c6e27`. Its source marker and full MIT
  notice live under `agent-gateway/knowledge/`.

## Verification

```powershell
cd E:\advx饥荒\DST-AICompanion-source
npm test

cd .\agent-gateway
npm test
npm run typecheck
npm run build
```

Manual game checks: issue `!ai stop` during a movement action, speak while the
companion is responding, verify the action ends by the next poll, and confirm no
Lua errors are reported in the DST log.

## Upstream references

- Original Mod: <https://github.com/votus777/DST-AICompanion>
- OpenAI Realtime WebRTC: <https://developers.openai.com/api/docs/guides/realtime-webrtc>
- OpenAI Realtime conversations: <https://developers.openai.com/api/docs/guides/realtime-conversations>
