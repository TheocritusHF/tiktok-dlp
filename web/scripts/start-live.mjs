import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBridgeRequestPath, proxyRequest } from "./start-live-core.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(here, "..");
const gatewayPort = positiveInteger(process.env.LIVE_GATEWAY_PORT, 3000);
const bridgePort = positiveInteger(process.env.LIVE_BRIDGE_PORT, 8787);
const frontendPort = positiveInteger(process.env.LIVE_FRONTEND_PORT, 3001);
const children = new Set();
let stopping = false;

start(process.execPath, ["scripts/live-bridge.mjs"]);
start("npm", ["run", "start", "--", "--port", String(frontendPort), "--hostname", "0.0.0.0"]);

const gateway = http.createServer((request, response) => {
  const pathname = new URL(request.url || "/", "http://rewind.local").pathname;
  const targetPort = isBridgeRequestPath(pathname)
    ? bridgePort
    : frontendPort;
  proxyRequest(request, response, targetPort);
});

gateway.listen(gatewayPort, "0.0.0.0", () => {
  console.log(`[rewind] App available at http://0.0.0.0:${gatewayPort}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(signal));
}

function start(command, args) {
  const child = spawn(command, args, {
    cwd: projectDir,
    env: process.env,
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[rewind] ${command} stopped unexpectedly (${signal || code})`);
      stop("SIGTERM", 1);
    }
  });
}

function stop(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  gateway.close();
  for (const child of children) child.kill(signal);
  const timer = setTimeout(() => process.exit(exitCode), 1_000);
  timer.unref();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
