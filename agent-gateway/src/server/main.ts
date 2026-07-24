import { GatewayStore } from "./database.js";
import { createGatewayApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GatewayCore } from "./gateway.js";

const config = loadConfig();
const store = new GatewayStore(config.databasePath);
const core = new GatewayCore(store);
const app = createGatewayApp(config, core);

const timer = setInterval(() => {
  core.runAutonomy();
  core.watchdog();
}, 1_000);
timer.unref();

const shutdown = async () => {
  clearInterval(timer);
  await app.close();
  store.close();
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });
console.log(`DST GPT Agent Gateway listening at http://${config.host}:${config.port}`);
