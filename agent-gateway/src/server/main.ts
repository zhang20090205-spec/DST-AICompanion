import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";
import { GatewayStore } from "./database.js";
import { createGatewayApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GatewayCore } from "./gateway.js";
import { AiriBridge } from "./airi-bridge.js";

// If an outbound proxy is configured, route Node's global fetch through it.
// This is required on networks that cannot reach api.openai.com directly (the
// OpenAI Realtime client-secret call is the only outbound fetch). undici's
// EnvHttpProxyAgent reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY from the environment,
// which the config import (dotenv) has already populated from .env by now.
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
  console.log("Outbound proxy enabled for OpenAI Realtime (from HTTP(S)_PROXY).");
}

const config = loadConfig();
const store = new GatewayStore(config.databasePath);
const core = new GatewayCore(store);
// AIRI is an optional controller. In the default "realtime" mode we leave the
// core in its native realtime state (browser Realtime voice + local fast path);
// only "airi" mode constructs and starts the WebSocket bridge to the AIRI app.
const airi = config.controllerMode === "airi" ? new AiriBridge(config, core) : undefined;
const app = createGatewayApp(config, core, airi ? () => airi.status() : undefined);

const timer = setInterval(() => {
  core.runAutonomy();
  core.watchdog();
}, 1_000);
timer.unref();

const shutdown = async () => {
  clearInterval(timer);
  airi?.stop();
  await app.close();
  store.close();
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });
airi?.start();
console.log(`DST Agent Gateway listening at http://${config.host}:${config.port} (controller: ${config.controllerMode})`);
