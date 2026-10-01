import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

test("playback encoding bounds work, bypasses compatible media, and skips canceled queued clips", { timeout: 15_000 }, async (context) => {
  const fixture = await startFixture(context);
  const first = fixture.request(1);
  await fixture.waitFor((event) => event.type === "encoding" && event.id === 1);
  const pending = [2, 3, 4].map((id) => fixture.request(id));
  const rejected = await Promise.race(pending.map(async (request) => ({ request, response: await request.result })));
  assert.equal(rejected.response.status, 503);
  const queued = pending.filter((request) => request !== rejected.request);
  const compatible = await fixture.request(9).result;
  assert.equal(compatible.status, 200);
  assert.equal(compatible.body, "original-9");
  assert.deepEqual(fixture.encodings(), [1], "Compatible playback must bypass the occupied encoder");

  await queued[0].cancel();
  fixture.release(1);
  assert.equal((await first.result).status, 200);
  await fixture.waitFor((event) => event.type === "encoding" && event.id === queued[1].id);
  fixture.release(queued[1].id);
  assert.equal((await queued[1].result).status, 200);
  assert.deepEqual(fixture.encodings(), [1, queued[1].id]);
  assert.equal(fixture.maxActive(), 1, "Only one encoder may run at a time");
});

test("canceling one shared playback request preserves its remaining waiter", { timeout: 15_000 }, async (context) => {
  const fixture = await startFixture(context);
  const blocker = fixture.request(1);
  await fixture.waitFor((event) => event.type === "encoding" && event.id === 1);
  const first = fixture.request(2);
  await fixture.waitFor((event) => event.type === "probe" && event.id === 2);
  const second = fixture.request(2, { range: "bytes=0-5" });
  await second.sent;
  await first.cancel();
  assert.equal((await fixture.request(9).result).status, 200);
  fixture.release(1);
  assert.equal((await blocker.result).status, 200);
  await fixture.waitFor((event) => event.type === "encoding" && event.id === 2);
  fixture.release(2);
  const response = await second.result;
  assert.equal(response.status, 206);
  assert.equal(response.body, "encode");
  assert.deepEqual(fixture.encodings(), [1, 2], "Shared media requests must not duplicate or cancel their common conversion");
});

test("H264 bitrate limits use reported or computed rates and preserve unknown-rate playback", { timeout: 15_000 }, async (context) => {
  const fixture = await startFixture(context);
  for (const id of [6, 7]) {
    const encoded = fixture.request(id);
    await fixture.waitFor((event) => event.type === "encoding" && event.id === id);
    for (const compatibleId of [8, 9]) {
      const compatible = await fixture.request(compatibleId).result;
      assert.equal(compatible.status, 200);
      assert.equal(compatible.body, `original-${compatibleId}`);
    }
    fixture.release(id);
    assert.equal((await encoded.result).body, `encoded-${id}`);
  }
  assert.deepEqual(fixture.encodings(), [6, 7]);
});

test("abandoned queued clips release capacity for the newly active viewer before encoding finishes", { timeout: 15_000 }, async (context) => {
  const fixture = await startFixture(context);
  const first = fixture.request(1);
  await fixture.waitFor((event) => event.type === "encoding" && event.id === 1);
  const pending = [2, 3, 4].map((id) => fixture.request(id));
  const rejected = await Promise.race(pending.map(async (request) => ({ request, response: await request.result })));
  assert.equal(rejected.response.status, 503);
  const queued = pending.filter((request) => request !== rejected.request);
  await Promise.all(queued.map((request) => request.cancel()));

  const active = fixture.request(5);
  await fixture.waitFor((event) => event.type === "probe" && event.id === 5);
  // A compatible request proves the bridge is processing requests while the
  // first encoder remains blocked, without waiting on a guessed timeout.
  assert.equal((await fixture.request(9).result).status, 200);
  fixture.release(1);
  assert.equal((await first.result).status, 200);
  const next = await Promise.race([
    fixture.waitFor((event) => event.type === "encoding" && event.id === 5).then(() => ({ encoding: true })),
    active.result.then((response) => ({ response })),
  ]);
  assert.equal(next.encoding, true, `A live viewer was rejected behind abandoned queue entries: ${JSON.stringify(next.response)}`);
  fixture.release(5);
  assert.equal((await active.result).status, 200);
  assert.deepEqual(fixture.encodings(), [1, 5]);
});

async function startFixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "rewind-queue-"));
  const downloads = path.join(directory, "downloads");
  const bin = path.join(directory, "bin");
  const controlPath = path.join(directory, "control.sock");
  await mkdir(downloads);
  await mkdir(bin);
  const events = [];
  const subscribers = new Set();
  const eventTimers = new Set();
  const gates = new Map();
  const sockets = new Set();
  const requests = new Set();
  let activeEncoders = 0;
  let maxActiveEncoders = 0;
  let stopping = false;
  let child;
  let output = "";
  const control = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      const event = JSON.parse(text.slice(0, text.indexOf("\n")));
      if (event.type === "encoding") {
        activeEncoders += 1;
        maxActiveEncoders = Math.max(maxActiveEncoders, activeEncoders);
        gates.set(event.id, socket);
        if (stopping) socket.end("release\n");
      } else {
        if (event.type === "complete") activeEncoders -= 1;
        socket.end("continue\n");
      }
      events.push(event);
      for (const subscriber of subscribers) subscriber(event);
    });
  });
  control.listen(controlPath);
  await once(control, "listening");
  const backend = http.createServer((request, response) => {
    const url = new URL(request.url, "http://backend.test");
    const id = Number(url.searchParams.get("fileId"));
    const payload = url.pathname === "/ready" ? { status: "ready" } : {
      videos: [{ id, path: `/app/data/downloads/${id}.mp4`, filename: `${id}.mp4`, size_bytes: 10 }],
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  context.after(async () => {
    stopping = true;
    for (const timer of eventTimers) clearTimeout(timer);
    subscribers.clear();
    for (const socket of gates.values()) socket.end("release\n");
    for (const request of requests) request.destroy();
    if (child && child.exitCode === null) {
      const closed = once(child, "close");
      child.kill("SIGTERM");
      await closed;
    }
    for (const socket of sockets) socket.destroy();
    const controlClosed = once(control, "close");
    control.close();
    await controlClosed;
    const backendClosed = once(backend, "close");
    backend.close();
    backend.closeAllConnections();
    await backendClosed;
    await rm(directory, { recursive: true, force: true });
  });
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) await writeFile(path.join(downloads, `${id}.mp4`), `original-${id}`);
  const executable = `#!${process.execPath}
const net = require("node:net");
const fs = require("node:fs/promises");
const path = require("node:path");
const args = process.argv.slice(2);
const probing = path.basename(process.argv[1]) === "ffprobe";
const input = probing ? args.at(-1) : args[args.indexOf("-i") + 1];
const id = Number(path.basename(input, ".mp4"));
function signal(type) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(process.env.REWIND_TEST_CONTROL);
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ type, id }) + "\\n"));
    socket.on("data", () => { socket.end(); resolve(); });
  });
}
(async () => {
  if (probing) {
    await signal("probe");
    const bitrate = id === 6 ? { bit_rate: "2400000" } : id === 7 ? { bit_rate: "N/A", size: "500000", duration: "1" } : id === 8 ? { bit_rate: "2200000" } : {};
    process.stdout.write(JSON.stringify({ streams: [{ index: 0, codec_type: "video", codec_name: id >= 6 ? "h264" : "hevc", pix_fmt: "yuv420p", width: 96, height: 160, avg_frame_rate: "24/1" }], format: { format_name: "mp4", ...bitrate } }));
  } else {
    await signal("encoding");
    await fs.writeFile(args.at(-1), "encoded-" + id);
    await signal("complete");
  }
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
`;
  await writeFile(path.join(bin, "ffmpeg"), executable, { mode: 0o755 });
  await writeFile(path.join(bin, "ffprobe"), executable, { mode: 0o755 });
  const portServer = net.createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = portServer.address().port;
  const portClosed = once(portServer, "close");
  portServer.close();
  await portClosed;
  child = spawn(process.execPath, [fileURLToPath(new URL("../scripts/live-bridge.mjs", import.meta.url))], {
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      REWIND_TEST_CONTROL: controlPath,
      LIVE_LOCAL_MODE: "1",
      LIVE_BRIDGE_HOST: "127.0.0.1",
      LIVE_BRIDGE_PORT: String(port),
      LIVE_DOWNLOADS_PATH: downloads,
      LIVE_CACHE_PATH: path.join(directory, "cache"),
      LIVE_BACKEND_URL: `http://127.0.0.1:${backend.address().port}`,
      LIVE_IMPORT_API_TOKEN: "queue-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Bridge did not start: ${output}`)), 5_000);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Bridge exited ${code}: ${output}`)); });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("available at")) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
  });
  return {
    encodings: () => events.filter((event) => event.type === "encoding").map((event) => event.id),
    maxActive: () => maxActiveEncoders,
    release(id) {
      assert(gates.has(id), `Encoder ${id} has not started`);
      gates.get(id).end("release\n");
      gates.delete(id);
    },
    waitFor(predicate) {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          eventTimers.delete(timer);
          subscribers.delete(listener);
          reject(new Error(`Control event not observed: ${JSON.stringify(events)}\n${output}`));
        }, 5_000);
        const listener = (event) => {
          if (!predicate(event)) return;
          clearTimeout(timer);
          eventTimers.delete(timer);
          subscribers.delete(listener);
          resolve(event);
        };
        eventTimers.add(timer);
        subscribers.add(listener);
      });
    },
    request(id, headers = {}) {
      let request;
      let sent;
      const result = new Promise((resolve) => {
        request = http.get(`http://127.0.0.1:${port}/media/${id}?playback=2`, { headers }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => { body += chunk; });
          response.on("end", () => resolve({ status: response.statusCode, body }));
        });
        requests.add(request);
        request.once("close", () => requests.delete(request));
        request.on("error", (error) => resolve({ canceled: true, error: error.code }));
        sent = once(request, "finish");
      });
      return {
        id, result, sent,
        async cancel() {
          const closed = once(request, "close").catch(() => {});
          request.destroy();
          await closed;
        },
      };
    },
  };
}
