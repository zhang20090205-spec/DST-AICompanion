import { GatewayStore } from "./database.js";
import { createGatewayApp } from "./app.js";
import { loadConfig } from "./config.js";
import { GatewayCore } from "./gateway.js";
import { AiriBridge } from "./airi-bridge.js";

const config = loadConfig();
const store = new GatewayStore(config.databasePath);
const core = new GatewayCore(store);
const airi = new AiriBridge(config, core);
const app = createGatewayApp(config, core, () => airi.status());

const timer = setInterval(() => {
  core.runAutonomy();
  core.watchdog();
}, 1_000);
timer.unref();

const shutdown = async () => {
  clearInterval(timer);
  airi.stop();
  await app.close();
  store.close();
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });
airi.start();
console.log(`DST Airi Agent Gateway listening at http://${config.host}:${config.port}`);
