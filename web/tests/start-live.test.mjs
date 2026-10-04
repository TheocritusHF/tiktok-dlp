import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isBridgeRequestPath, proxyRequest } from "../scripts/start-live-core.mjs";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("start-live sends every archive and ordered-media route to the bridge", () => {
  for (const pathname of [
    "/api/health",
    "/media/12",
    "/thumbnail/12.jpg",
    "/post-media/12/0",
    "/post-download/12",
  ]) {
    assert.equal(isBridgeRequestPath(pathname), true, pathname);
  }
  for (const pathname of [
    "/",
    "/dashboard/media",
    "/post-media-lookalike/12/0",
    "/post-download-lookalike/12",
  ]) {
    assert.equal(isBridgeRequestPath(pathname), false, pathname);
  }
});

test("gateway streams range bytes before the upstream body completes", { timeout: 5_000 }, async (context) => {
  const upstreamReady = Promise.withResolvers();
  const port = await startProxyFixture(context, (request, response) => {
    assert.equal(request.headers.range, "bytes=2-7");
    response.writeHead(206, {
      "content-range": "bytes 2-7/10",
      "content-length": "6",
      "content-type": "video/mp4",
      "cache-control": "private, max-age=604800",
    });
    response.write("234");
    upstreamReady.resolve(response);
  });
  const client = http.get(`http://127.0.0.1:${port}/media/1`, {
    headers: { range: "bytes=2-7" },
  });
  const [response] = await once(client, "response");
  assert.equal(response.statusCode, 206);
  assert.equal(response.headers["content-range"], "bytes 2-7/10");
  assert.equal(response.headers["cache-control"], "private, max-age=604800");
  const [firstChunk] = await once(response, "data");
  assert.equal(firstChunk.toString(), "234");
  const finished = once(response, "end");
  (await upstreamReady.promise).end("567");
  await finished;
});

for (const beforeHeaders of [false, true]) {
  test(`gateway cancels abandoned media ${beforeHeaders ? "before headers" : "during streaming"}`, {
    timeout: 5_000,
  }, async (context) => {
    const upstreamReady = Promise.withResolvers();
    const upstreamClosed = Promise.withResolvers();
    const port = await startProxyFixture(context, (_request, response) => {
      response.once("close", () => upstreamClosed.resolve());
      if (!beforeHeaders) {
        response.writeHead(200, { "content-type": "video/mp4" });
        response.write(Buffer.alloc(1024));
      }
      upstreamReady.resolve();
    });
    const client = http.get(`http://127.0.0.1:${port}/media/1`);
    client.on("error", () => {});
    const received = beforeHeaders ? null : once(client, "response");
    await upstreamReady.promise;
    if (received) {
      const [response] = await received;
      response.on("error", () => {});
      await once(response, "data");
    }
    client.destroy();
    await upstreamClosed.promise;
  });
}

test("gateway closes the browser response when an upstream media stream breaks", {
  timeout: 5_000,
}, async (context) => {
  const upstreamReady = Promise.withResolvers();
  const port = await startProxyFixture(context, (_request, response) => {
    response.writeHead(200, { "content-length": "100", "content-type": "video/mp4" });
    response.write("first chunk");
    upstreamReady.resolve(response);
  });
  const response = await fetch(`http://127.0.0.1:${port}/media/1`);
  const body = response.arrayBuffer();
  const rejected = assert.rejects(body);
  (await upstreamReady.promise).destroy();
  await rejected;
});

test("start-live fails when a child exits cleanly", async (context) => {
  const fixtureDir = await mkdtemp(path.join(os.tmpdir(), "rewind-supervisor-"));
  context.after(() => rm(fixtureDir, { recursive: true, force: true }));

  const fakeNpm = path.join(fixtureDir, "npm");
  await writeFile(fakeNpm, "#!/usr/bin/env node\nprocess.exit(0);\n");
  await chmod(fakeNpm, 0o755);
  const [gatewayPort, bridgePort, frontendPort] = await reservePorts(3);

  const child = spawn(process.execPath, ["scripts/start-live.mjs"], {
    cwd: projectDir,
    env: {
      ...process.env,
      PATH: `${fixtureDir}${path.delimiter}${process.env.PATH || ""}`,
      LIVE_GATEWAY_PORT: String(gatewayPort),
      LIVE_BRIDGE_PORT: String(bridgePort),
      LIVE_FRONTEND_PORT: String(frontendPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const result = await waitForExit(child);
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
  assert.match(stderr, /npm stopped unexpectedly \(0\)/);
});

async function reservePorts(count) {
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  })));
  const ports = servers.map((server) => server.address().port);
  await Promise.all(servers.map((server) => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  return ports;
}

async function startProxyFixture(context, handler) {
  const upstream = http.createServer(handler);
  await listen(upstream);
  const gateway = http.createServer((request, response) => {
    proxyRequest(request, response, upstream.address().port);
  });
  await listen(gateway);
  context.after(async () => {
    await Promise.all([gateway, upstream].map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    })));
  });
  return gateway.address().port;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("start-live did not exit after its child stopped"));
    }, 5_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}
