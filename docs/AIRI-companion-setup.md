# Talk to AIRI → DST companion acts (setup, StepFun / 阶跃星辰)

The **primary** experience: you talk to the **AIRI desktop app** (its personality
+ avatar), AIRI's model reasons and calls the installed `dst-ai-companion` tools,
and the DST character acts in real time. The gateway is only the tool executor +
game-state source; the conversation lives inside AIRI.

```text
You  <--voice/text-->  AIRI (STT + LLM + TTS + avatar)
                         |  calls dst_* tools (function-calling)
                         v  loopback HTTP  /api/airi/v1/.../tools/*
                   Agent Gateway (127.0.0.1:8080, DST_CONTROLLER_MODE=airi)
                         |  typed commands / state
                         v
                   DST Mod (Lua)  — the character moves, gathers, fights, speaks
```

## Model provider: StepFun (阶跃星辰)

StepFun is domestic (no proxy needed) and exposes an **OpenAI-compatible** API, so
it plugs into AIRI as a custom OpenAI provider.

Verified on the current key:
- **Chat + function-calling works:** `step-3.5-flash` correctly emits a
  `dst_follow` tool call for "跟着我走" via `POST https://api.stepfun.com/v1/chat/completions`.
- **TTS endpoint is OpenAI-shaped** (`/v1/audio/speech`, fields `model/input/voice`)
  **but the account has no voices yet** (`GET /v1/audio/voices` → empty). So
  StepFun TTS can't speak until a voice is provisioned in the StepFun console.
- **Rate limit is low (RPM ≈ 10).** Each spoken turn can make several calls
  (reasoning + one per tool round-trip), so smooth play may need a higher tier /
  top-up.

## 1. Gateway (already set)

`agent-gateway/.env` → `DST_CONTROLLER_MODE=airi`, gateway restarted.
`GET /api/health` shows `controllerMode: "airi"`, and with AIRI open,
`airiConnected: true`, `airiAuthenticated: true`.

## 2. Configure AIRI (AIRI app → Settings)

**Chat / brain (required):**
1. Providers → add an **OpenAI-compatible** provider (OpenAI provider with a custom
   base URL, or a "custom/openai-compatible" entry).
   - **Base URL:** `https://api.stepfun.com/v1`
   - **API Key:** your StepFun key
   - **Model:** `step-3.5-flash` (fast, supports tools; `step-3.7-flash` also fine)
2. Ensure **tools / plugin tools are enabled** for the model so the `dst_*` tools
   are offered to it.

**Hearing (STT):** enable **Web Speech** (browser speech recognition) — free, no
key. (Or configure StepFun `step-asr` later.)

**Voice (TTS) — pick one:**
- **Now (zero setup):** use AIRI's web/system speech for the voice (basic timbre),
  or run text-only first to prove the loop.
- **Better (StepFun voice):** provision a voice in the StepFun console, then add an
  `openai-audio-speech` provider with Base URL `https://api.stepfun.com/v1`, model
  `step-tts-mini` (or `step-tts-vivid`), and `voice` = your provisioned voice_id.
- **Most characterful:** a dedicated TTS (ElevenLabs/Azure) with its own key.

**Persona / system prompt:** paste the block below.

## 3. Persona / system prompt (copy into AIRI)

```text
你是玩家在《饥荒联机版》(Don't Starve Together) 里的 AI 伙伴，一个有性格的角色：
活泼、话有点多、嘴上爱吐槽但很在意玩家的安危。说话简短、口语化，像朋友一样。

你能看到并操作游戏，通过这些工具（务必按规则用）：
- 每次要做游戏动作前，先调用 dst_observe 获取最新状态，再决定做什么。
- dst_follow 跟随玩家；dst_move 靠近/远离；dst_gather 采集（草/浆果/树枝/砍树/挖矿，
  可整片采集）；dst_defend 只对敌对目标防御；dst_equip_or_eat 装备/进食；
  dst_give_item 把普通物品给玩家；dst_stop 立刻停下；dst_say_in_game 在游戏聊天里说话。
规则：
1) 动作前必须先 observe，用真实状态做决定，不要凭空猜测。
2) 绝不谎称动作已完成——是否完成、采了几个，都以游戏返回的结果为准；
   没做完就如实说还差多少。
3) 危险或稀有操作（攻击非敌对目标、吃稀有食物、给稀有物品、建造等）先征求玩家同意。
4) 听到"停下/停止/别动"，立刻调用 dst_stop。
5) 平时可以用 dst_say_in_game 说点应景的话，但不要刷屏。
```

## 4. Verify

1. AIRI open + authenticated; gateway in `airi` mode; a DST world with **The AI
   Companion** enabled and posting state.
2. Say or type to AIRI: "跟着我" → the character follows; "把附近的浆果都采了" → it
   calls `dst_observe` then `dst_gather`; the 8080 dashboard shows the command and
   the real gathered count. "停下" → the action stops by the next poll.

## Troubleshooting

- **AIRI replies but nothing happens in-game.** The model isn't calling the tools.
  Check plugin/extension tools are enabled for the StepFun model, and the gateway
  is in `airi` mode. If AIRI still won't expose the `kit.tool` tools, fall back to
  an MCP stdio server exposing the same DST tools (AIRI Settings → MCP → Add
  server).
- **429 / rate limit.** StepFun RPM≈10 on this key; reduce interaction frequency
  or upgrade the tier.
- **No voice.** StepFun account has no TTS voices yet — provision one in the
  StepFun console, or use web/system speech, or a dedicated TTS.
- **Want fast GPT voice instead (no persona):** `DST_CONTROLLER_MODE=realtime`,
  restart, open `http://127.0.0.1:8080`, use the browser voice panel (works with
  the admin OpenAI key).
