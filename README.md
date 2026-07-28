# DST AI Companion

This repository runs one local Don't Starve Together companion. It supports two
controller modes, selected by `DST_CONTROLLER_MODE`:

- **`airi` (primary)** — you talk to the **AIRI desktop app** (its own voice,
  personality, and avatar) and AIRI drives the DST character through the installed
  `dst-ai-companion` tools. This is the "talk to a character who plays the game
  with you" experience. Setup: [`docs/AIRI-companion-setup.md`](docs/AIRI-companion-setup.md).
- **`realtime` (fallback)** — a fast, low-latency **OpenAI Realtime**
  speech-to-speech voice agent in the browser that controls the character
  directly. Works even with an admin-scoped OpenAI key, but it is GPT's generic
  voice with no avatar/persona.

A retired FAtiMA executable is kept only for historical compatibility; it is not
used.

## What runs where

```text
Browser voice page  <-- WebRTC -->  OpenAI Realtime
       |  (mic + speech-to-speech, tool calls)
       v  localhost HTTP + SSE
Agent Gateway (Node.js, 127.0.0.1:8080)
       ^  localhost HTTP
       |  (compact snapshot + typed commands)
DST Mod (Lua)
```

The Lua Mod reports a compact, untrusted game snapshot and polls typed commands.
It never executes model-provided Lua. The Gateway validates every command, keeps
an interrupt epoch, and stores only local preferences, task summaries, and action
audits. Browser audio goes directly to OpenAI using a short-lived client secret;
`OPENAI_API_KEY` never leaves the local Gateway process.

The Gateway runs a deterministic **local fast path**: `停止/停下`, `跟着我`,
`过来`, and nearby `草/浆果/树枝` gathering are recognized and dispatched to the
Mod immediately, without a model round-trip. Unclear or higher-risk requests are
handed to the Realtime session for a short clarification instead.

## Local paths

| Purpose | Path |
| --- | --- |
| Editable source | `E:\advx饥荒\DST-AICompanion-source` |
| Gateway | `E:\advx饥荒\DST-AICompanion-source\agent-gateway` |
| Installed DST Mod | `D:\steam\steamapps\common\Don't Starve Together\mods\DST-AICompanion` |
| AIRI extension (optional) | `E:\advx饥荒\airi-extension` |
| Retired legacy service | `E:\advx饥荒\DST-AICompanion-source\FAtiMA-Server\FAtiMA-Server.exe` |

## Configuration (`agent-gateway/.env`)

This file is git-ignored and stays only on this computer.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | (required) | Mints the Realtime client secret. Keep it local. |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1` | Realtime model. |
| `OPENAI_REALTIME_REASONING_EFFORT` | `low` | Use `high` only when extra planning latency is acceptable. |
| `OPENAI_REALTIME_VOICE` | `marin` | Realtime voice. |
| `DST_CONTROLLER_MODE` | `realtime` | `realtime` = browser Realtime voice + fast path. `airi` = route through the AIRI app. |
| `DST_GATEWAY_HOST` / `DST_GATEWAY_PORT` | `127.0.0.1` / `8080` | Loopback only. |
| `DST_GATEWAY_DATABASE` | `data/dst-gpt-agent.sqlite` | Local SQLite (`:memory:` for tests). |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | (unset) | Outbound proxy so the Gateway can reach `api.openai.com` where it is blocked directly. Keep loopback in `NO_PROXY`. See below. |
| `AIRI_WS_URL` / `AIRI_AUTH_TOKEN` / `AIRI_MODULE_NAME` | ws://127.0.0.1:6121/ws / – / dst-companion | Only used in `airi` mode. |

### Reaching OpenAI through a proxy

If this machine cannot reach `api.openai.com` directly (e.g. mainland China), set
a proxy in `.env`:

```dotenv
HTTPS_PROXY=http://127.0.0.1:7897
HTTP_PROXY=http://127.0.0.1:7897
NO_PROXY=127.0.0.1,localhost,::1
```

The Gateway's Node `fetch` (which mints the Realtime client secret) is routed
through this proxy at startup via undici's `EnvHttpProxyAgent`. The **browser**
handles its own OpenAI traffic through the system proxy. Note the transport
caveat under "Troubleshooting" below.

## AIRI mode (primary): talk to the character

Route control through the [AIRI](https://github.com/moeru-ai/airi) desktop app so
you talk to a character — its own voice, personality, and avatar — that plays DST
for you. Full steps: [`docs/AIRI-companion-setup.md`](docs/AIRI-companion-setup.md).
In short:

1. Install and open AIRI (its server channel listens on `127.0.0.1:6121`).
2. Install the DST extension, then restart AIRI so it loads `dst-ai-companion`:
   `powershell -ExecutionPolicy Bypass -File .\scripts\Install-DST-Airi-Extension.ps1 -AiriExtensionsRoot "$env:APPDATA\ai.moeru.airi\extensions\v1"`.
3. Put AIRI's token (`%APPDATA%\ai.moeru.airi\server-channel-config.json`) into
   `AIRI_AUTH_TOKEN`, set `DST_CONTROLLER_MODE=airi`, and restart the Gateway.
4. In AIRI Settings configure a chat provider with **function-calling**, plus STT
   and TTS, and paste the persona from the setup doc. A domestic **StepFun
   (阶跃星辰)** key works well here — it's directly reachable (no proxy) and
   OpenAI-compatible: add it as an OpenAI provider with base URL
   `https://api.stepfun.com/v1` and model `step-3.5-flash` (function-calling
   verified). Note: an `sk-admin-` OpenAI key can NOT drive AIRI (chat/TTS return
   `401 missing_scope`); it only works for the realtime fallback.
5. Sync the mod, start a DST world with **The AI Companion** enabled, then talk to
   AIRI: "跟着我" / "把附近的浆果都采了" / "停下".

## Start realtime fallback mode

Fast, low-latency GPT voice in the browser (no AIRI persona); works with the
admin key.

1. In `agent-gateway/.env`, set `OPENAI_API_KEY` (and `HTTPS_PROXY` if needed) and
   `DST_CONTROLLER_MODE=realtime`.
2. After changing the Mod source, run
   `powershell -ExecutionPolicy Bypass -File .\scripts\Sync-DST-AICompanion-Mod.ps1`.
   It copies only `modinfo.lua`, `modmain.lua`, and `scripts/` to the installed
   Mod and verifies every copied file with SHA-256; it never deletes files.
3. Start the Gateway, either:
   - `powershell -ExecutionPolicy Bypass -File .\scripts\Start-DST-GPT-Agent.ps1`
     (builds, frees port 8080, sets the proxy env, then starts the Gateway), or
   - `cd agent-gateway && npm run build && npm start`.
   The Gateway listens on `127.0.0.1:8080` and logs `(controller: realtime)`.
4. Open `http://127.0.0.1:8080`, click **连接语音**, and allow microphone access.
5. Host or restart a local DST world with **The AI Companion** enabled.

The Gateway fails closed: if it loses the voice session or game connection, it
queues an immediate stop and the companion waits.

## In-game interaction

Voice happens in the browser page; text commands happen in DST chat with the
`!ai` prefix (case-insensitive; the prefix is required — plain "follow" is
ignored).

| Input | Result |
| --- | --- |
| Browser microphone | Chinese speech-to-speech with OpenAI Realtime. Say `停止`/`停下` to stop the current action. |
| `!ai 跟着我` / `!ai 停下` | Instant follow/stop via the local fast path. |
| `!ai 把附近的浆果都采了` | Nearby gathering; add `全部`/`所有`/`都` to collect every reachable instance of one prefab. |
| `!ai yes` / `!ai no` | Accepts or rejects an active high-risk confirmation (or say “是/否” to the voice agent). |

Allowed actions: follow, stop, approach/retreat, nearby ordinary gathering,
nearby hostile defense, equip/eat, give ordinary items, and speak. Building,
crafting, long-range exploration, attacking non-hostile targets, and rare-item
consumption require confirmation. DST is the only source of completion: a
"collect all of this prefab" request produces one factual `[AI]` result with the
real count; partial or failed gathers report the actual unfinished work.

## Safety contract

- Gateway binds only to `127.0.0.1`.
- Commands contain `id`, `epoch`, `priority`, `kind`, `args`, and `expiresAt`.
  `interrupt > player > autonomy`; stale epochs and expired commands are ignored.
- The Mod and Gateway both validate entity IDs, distances, command kinds, and
  text length.
- Raw audio and persistent transcripts are not stored. Local SQLite contains
  only explicit memory values, task/audit metadata (capped), and attributed
  knowledge.
- The bundled Markdown knowledge package is derived from the MIT-licensed
  `morandot/dont-starve-skill` at pinned commit
  `12dc27d3b6d0a261f0fbd14a046d492cba8c6e27`. Its source marker and full MIT
  notice live under `agent-gateway/knowledge/`.

## Verification

```powershell
cd E:\advx饥荒\DST-AICompanion-source
npm test            # Lua static asserts + companion checks (26)

cd .\agent-gateway
npm test            # gateway + client protocol tests (99)
npm run typecheck
npm run build
```

Manual checks: open `http://127.0.0.1:8080`, connect voice, and speak — expect an
emotional Realtime reply. In game, `!ai 把附近浆果都采了`, then say `停止` and
verify the action ends by the next poll. Confirm no Lua errors in the DST log.

## Troubleshooting

- **No voice audio through a proxy.** The browser Realtime path uses WebRTC; its
  media is ICE/UDP and does not traverse an HTTP proxy. A plain HTTP/SOCKS proxy
  (e.g. Clash's mixed port) will carry the signaling but not the audio unless
  TUN/system-tunnel mode is enabled. If the model connects but you hear nothing,
  enable your proxy's TUN mode, or fall back to a WebSocket transport.
- **`!ai` does nothing.** Ensure `Enable Text Commands` is on and use the `!ai`
  prefix. Speaking inside DST does not reach the Gateway — voice is browser-only.
- **500 / cannot reach OpenAI.** Set `HTTPS_PROXY` in `.env` (see above) and
  restart the Gateway; `/api/health` should show `realtimeConfigured: true`.

## Upstream references

- Original Mod: <https://github.com/votus777/DST-AICompanion>
- OpenAI Realtime WebRTC: <https://developers.openai.com/api/docs/guides/realtime>
- AIRI (optional controller): <https://github.com/moeru-ai/airi>
