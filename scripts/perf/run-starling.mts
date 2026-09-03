// Keep a harness-configured Starling running on 64738 until this process is killed.
// Run from the e2e repo root: node --import tsx scripts/perf/run-starling.mts
import { StarlingServer } from "../../src/util/starling.ts";

const server = await StarlingServer.start();
console.log(`starling up: port=${server.port} operator=${server.operatorPort} udp=${server.voicePortOpen}`);
const bye = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
setInterval(() => {
  if (!server.running) {
    console.log("starling exited");
    process.exit(1);
  }
}, 2000);
