import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import { AiriBridge } from "../src/server/airi-bridge.js";
import type { GatewayConfig } from "../src/server/config.js";
import { GatewayStore } from "../src/server/database.js";
import { GatewayCore } from "../src/server/gateway.js";

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Airi bridge state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("Airi bridge authenticates, announces, forwards input, and fails closed on disconnect", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const port = typeof address === "object" && address ? address.port : 0;
  const received: Array<Record<string, unknown>> = [];
  let connection: import("ws").WebSocket | undefined;

  server.on("connection", (socket) => {
    connection = socket;
    socket.on("message", (raw) => {
      const event = JSON.parse(String(raw)) as { type: string; data: Record<string, unknown> };
      received.push(event as unknown as Record<string, unknown>);
      if (event.type === "module:authenticate") {
        socket.send(JSON.stringify({ type: "module:authenticated", data: { authenticated: true } }));
      }
      if (event.type === "extension:module:announce") {
        socket.send(JSON.stringify({
          type: "extension:module:announced",
          data: { name: event.data.name, identity: event.data.identity },
        }));
      }
    });
  });

  const store = new GatewayStore(":memory:");
  const core = new GatewayCore(store);
  const config: GatewayConfig = {
    host: "127.0.0.1",
    port: 8080,
    realtimeModel: "gpt-realtime-2.1",
    realtimeReasoningEffort: "low",
    realtimeVoice: "marin",
    databasePath: ":memory:",
    controllerMode: "airi",
    airiWsUrl: `ws://127.0.0.1:${port}/ws`,
    airiAuthToken: "secret",
    airiModuleName: "dst-companion",
  };
  const bridge = new AiriBridge(config, core);
  bridge.start();
  await waitFor(() => bridge.status().airiConnected === true);
  core.receiveState("bot-1", { HP: 100, Hunger: 80, Sanity: 90, X: 0, Z: 0, Entities: [], Inventory: [] });
  core.receivePlayerInput("bot-1", { text: "跟着我", source: "game" });
  await waitFor(() => received.some((event) => event.type === "input:text"));
  assert.equal(core.status().controllerMode, "airi");
  assert.equal(core.status().controllerAuthenticated, true);

  connection?.close();
  await waitFor(() => core.status().controllerConnected === false);
  bridge.stop();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  store.close();
});
