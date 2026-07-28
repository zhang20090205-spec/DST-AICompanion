#!/usr/bin/env node
// DST AI Companion — MCP (stdio) server.
//
// Exposes the same DST tools as the AIRI kit.tool extension, but over the Model
// Context Protocol so AIRI's mcp-stdio-manager surfaces them to the chat model.
// Each tool proxies to the local Gateway's /api/airi/v1 endpoints (loopback);
// the Gateway remains the only thing that talks to DST.
//
// IMPORTANT: stdout is the JSON-RPC channel. Never write logs to stdout — use
// stderr only.
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:8080";
const DEFAULT_COMPANION_ID = "default";
const DEFAULT_API_PREFIX = "/api/airi/v1";
const DEFAULT_ACTION_WAIT_MS = 120_000;
const OBSERVATION_TTL_MS = 20_000;
const TERMINAL_STATUSES = new Set(["succeeded", "partial", "failed", "cancelled"]);
const OBSERVATION_EXEMPT_TOOLS = new Set(["dst_observe", "dst_stop", "dst_say_in_game"]);

const gatewayBaseUrl = parseLoopbackHttpUrl(process.env.DST_AIRI_GATEWAY_URL ?? process.env.DST_GATEWAY_URL ?? DEFAULT_GATEWAY_URL);
const apiPrefix = normalizeApiPrefix(process.env.DST_AIRI_GATEWAY_API_PREFIX ?? DEFAULT_API_PREFIX);
const companionId = sanitizeCompanionId(process.env.DST_AIRI_COMPANION_ID ?? DEFAULT_COMPANION_ID);
const actionWaitMs = boundedInt(process.env.DST_AIRI_ACTION_WAIT_MS, 1_000, DEFAULT_ACTION_WAIT_MS, DEFAULT_ACTION_WAIT_MS);
const authToken = safeOptionalText(process.env.DST_AIRI_GATEWAY_TOKEN ?? process.env.AIRI_AUTH_TOKEN, 4096);

let lastObservedAt = 0;
let lastObservation = null;

function parseLoopbackHttpUrl(rawValue) {
  let url;
  try { url = new URL(rawValue); } catch { throw new Error("DST_AIRI_GATEWAY_URL must be a valid loopback HTTP URL."); }
  const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (!["http:", "https:"].includes(url.protocol) || !loopbackHosts.has(url.hostname)) {
    throw new Error("DST_AIRI_GATEWAY_URL must use http/https on a loopback host.");
  }
  url.hash = ""; url.username = ""; url.password = "";
  return url;
}
function normalizeApiPrefix(value) {
  const t = String(value || "").trim();
  return (!t || !t.startsWith("/") || t.includes("..")) ? DEFAULT_API_PREFIX : t.replace(/\/+$/, "");
}
function sanitizeCompanionId(value) {
  const t = String(value || "").trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(t) ? t : DEFAULT_COMPANION_ID;
}
function safeOptionalText(value, maxLength) {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t ? t.slice(0, maxLength) : undefined;
}
function boundedInt(value, min, max, fallback) {
  const p = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(p) ? Math.max(min, Math.min(max, p)) : fallback;
}
function companionPath(path) { return `${apiPrefix}/companions/${encodeURIComponent(companionId)}${path}`; }
function gatewayUrl(path, query) {
  const url = new URL(path, gatewayBaseUrl);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  return url;
}
function redact(value) {
  return String(value ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|authorization)\s*[:=]\s*[^,\s;]+/gi, "$1=[redacted]")
    .replace(/\s+/g, " ").trim().slice(0, 240);
}
function publicError(error) {
  if (error && typeof error === "object" && error.publicError) return error.publicError;
  const message = redact(error instanceof Error ? error.message : error);
  return { ok: false, error: { code: "gateway_request_failed", message: message || "Local Gateway request failed." } };
}
function httpError(status, body) {
  const msg = body && typeof body === "object" && typeof body.error === "string" ? body.error : `Gateway request failed (${status}).`;
  const error = new Error(msg);
  error.publicError = { ok: false, error: { code: status === 404 ? "gateway_api_not_found" : "gateway_http_error", message: redact(msg), status } };
  return error;
}
async function requestJson(method, path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000);
  timeout.unref?.();
  try {
    const headers = { Accept: "application/json" };
    let body;
    if (options.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(options.body); }
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await fetch(gatewayUrl(path, options.query), { method, headers, body, signal: controller.signal });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) throw httpError(response.status, parsed);
    return parsed;
  } catch (error) {
    if (error instanceof SyntaxError) { const w = new Error("Gateway returned invalid JSON."); w.publicError = { ok: false, error: { code: "gateway_invalid_json", message: "Gateway returned invalid JSON." } }; throw w; }
    if (error?.name === "AbortError") { const w = new Error("Gateway request timed out."); w.publicError = { ok: false, error: { code: "gateway_timeout", message: "Gateway request timed out." } }; throw w; }
    throw error;
  } finally { clearTimeout(timeout); }
}
function decodeToolOutput(envelope) {
  if (!envelope || typeof envelope !== "object") return {};
  if (!("output" in envelope)) return envelope;
  const output = envelope.output;
  if (typeof output === "string") { try { return JSON.parse(output); } catch { return { ok: false, error: { code: "gateway_invalid_tool_output", message: "Gateway tool output was not valid JSON." } }; } }
  return output && typeof output === "object" ? output : {};
}
function compactArgs(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null));
}
function isTerminalLifecycle(l) { return !!l && typeof l === "object" && (l.terminal === true || TERMINAL_STATUSES.has(l.status)); }
async function waitForCommandTerminal(commandId) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < actionWaitMs) {
    const remaining = actionWaitMs - (Date.now() - startedAt);
    const timeoutMs = Math.max(1, Math.min(10_000, remaining));
    const response = await requestJson("GET", companionPath(`/commands/${encodeURIComponent(commandId)}/wait`), { query: { timeoutMs }, timeoutMs: timeoutMs + 2_000 });
    latest = response.command ?? response.lifecycle ?? response;
    if (isTerminalLifecycle(latest)) return { completed: true, timedOut: false, lifecycle: latest };
  }
  return { completed: false, timedOut: true, maxWaitMs: actionWaitMs, lifecycle: latest, instruction: "The DST command did not reach a trusted terminal result within the wait limit. Do not claim success." };
}
async function observeGameState() {
  const snapshot = await requestJson("GET", companionPath("/state"), { timeoutMs: 5_000 });
  lastObservedAt = Date.now();
  lastObservation = snapshot;
  return { ok: true, observedAt: lastObservedAt, companionId, snapshot };
}
function requireRecentObservation(dstTool) {
  if (OBSERVATION_EXEMPT_TOOLS.has(dstTool)) return undefined;
  if (!lastObservedAt || Date.now() - lastObservedAt > OBSERVATION_TTL_MS) {
    return { ok: false, error: { code: "observe_required", message: "Call dst_observe first, then choose one action from the trusted observation." } };
  }
  return undefined;
}
async function callGatewayTool(dstTool, input) {
  const blocked = requireRecentObservation(dstTool);
  if (blocked) return blocked;
  const callId = `mcp-${randomUUID()}`;
  const args = compactArgs(input);
  const envelope = await requestJson("POST", companionPath(`/tools/${encodeURIComponent(dstTool)}`), { body: { callId, args }, timeoutMs: 10_000 });
  const output = decodeToolOutput(envelope);
  const commandId = typeof envelope.commandId === "string" ? envelope.commandId : (typeof output.commandId === "string" ? output.commandId : undefined);
  const shouldWait = commandId && output.pending === true;
  const terminalWait = shouldWait ? await waitForCommandTerminal(commandId) : undefined;
  return { callId, ok: output.ok !== false, commandId: commandId ?? null, observedAt: lastObservedAt || null, output, ...(terminalWait ? { terminalWait } : {}) };
}

const emptySchema = { type: "object", properties: {}, additionalProperties: false };
const TOOLS = [
  { name: "dst_observe", description: "Read the latest trusted Gateway snapshot before choosing any DST action.", inputSchema: emptySchema, run: () => observeGameState() },
  { name: "dst_say_in_game", description: "Send concise DST chat for normal conversation only. Do not use for action preambles or guessed results.", inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 120 } }, required: ["text"], additionalProperties: false }, run: (a) => callGatewayTool("dst_say_in_game", a) },
  { name: "dst_follow", description: "Follow the current local player after dst_observe confirms the current context.", inputSchema: emptySchema, run: (a) => callGatewayTool("dst_follow", a) },
  { name: "dst_stop", description: "Immediately stop the companion and wait in place. Safety action; no prior observation required.", inputSchema: emptySchema, run: (a) => callGatewayTool("dst_stop", a) },
  { name: "dst_move", description: "Approach or retreat from a nearby observed player or entity. Never invent a target.", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["approach", "retreat"] }, targetGuid: { type: "number" } }, required: ["mode"], additionalProperties: false }, run: (a) => callGatewayTool("dst_move", a) },
  { name: "dst_gather", description: "Collect/chop/mine ordinary resources. mode=collect for grass/berries/twigs/carrots/reeds/flowers, chop for trees, mine for rocks. A targetPrefab alone is enough. scope=all_same_prefab for 'collect all nearby'.", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["collect", "chop", "mine"] }, scope: { type: "string", enum: ["single", "all_same_prefab"] }, targetGuid: { type: "number" }, targetPrefab: { type: "string", maxLength: 64 } }, additionalProperties: false }, run: (a) => callGatewayTool("dst_gather", a) },
  { name: "dst_defend", description: "Attack only a nearby threat from the latest observation. Gateway may require player confirmation.", inputSchema: { type: "object", properties: { targetGuid: { type: "number" } }, additionalProperties: false }, run: (a) => callGatewayTool("dst_defend", a) },
  { name: "dst_equip_or_eat", description: "Equip a suitable item or eat ordinary food from the latest observed inventory. Gateway handles risky confirmation.", inputSchema: { type: "object", properties: { action: { type: "string", enum: ["equip", "eat"] }, itemName: { type: "string", maxLength: 64 } }, required: ["action"], additionalProperties: false }, run: (a) => callGatewayTool("dst_equip_or_eat", a) },
  { name: "dst_give_item", description: "Give a nearby player an ordinary item from observed inventory. Gateway handles risky confirmation.", inputSchema: { type: "object", properties: { itemName: { type: "string", maxLength: 64 }, quantity: { type: "number", minimum: 1, maximum: 40 } }, required: ["itemName"], additionalProperties: false }, run: (a) => callGatewayTool("dst_give_item", a) },
];
const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

const INSTRUCTIONS = [
  "These tools control a Don't Starve Together (DST) companion. Observe before action is mandatory.",
  "Call dst_observe before any gameplay action unless the player explicitly asks to stop.",
  "Use only GUIDs, prefabs, inventory items, danger, and player distance from the latest observation.",
  "Never invent target IDs, item names, gathered counts, or completion status.",
  "A tool result is not success unless terminalWait.completed is true and its lifecycle status is succeeded.",
  "If terminalWait.timedOut is true, say the action is still pending or unknown, not complete.",
  "For partial, failed, cancelled, awaiting_player, or deferred results, report the real status only.",
].join("\n");

const server = new Server(
  { name: "dst-ai-companion", version: "0.1.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOL_MAP.get(request.params.name);
  if (!tool) return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: "unknown_tool", message: `Unknown tool: ${request.params.name}` } }) }], isError: true };
  let result;
  try { result = await tool.run(request.params.arguments ?? {}); }
  catch (error) { result = publicError(error); }
  const isError = result && result.ok === false;
  return { content: [{ type: "text", text: JSON.stringify(result) }], isError: Boolean(isError) };
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`dst-ai-companion MCP server ready (gateway ${gatewayBaseUrl.origin}, companion ${companionId})\n`);
