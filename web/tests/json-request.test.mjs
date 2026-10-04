import assert from "node:assert/strict";
import test from "node:test";
import { fetchJson, JSON_REQUEST_TIMEOUT_MS } from "../lib/json-request.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const phase of ["headers", "body"]) {
  test(`JSON request times out while waiting for ${phase} and aborts its transport`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let requestSignal;
    const stalled = deferred();
    const request = fetchJson("/api/videos", {}, {
      fetchImpl: async (_url, init) => {
        requestSignal = init.signal;
        return phase === "headers" ? stalled.promise : { ok: true, json: () => stalled.promise };
      },
    });
    const rejected = assert.rejects(request, { name: "TimeoutError", message: "Request timed out. Please retry." });
    await Promise.resolve();
    t.mock.timers.tick(JSON_REQUEST_TIMEOUT_MS);
    await rejected;
    assert.equal(requestSignal.aborted, true);
  });
}

test("JSON requests preserve server errors and reject malformed successful bodies", async () => {
  await assert.rejects(fetchJson("/api/videos", {}, {
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: "Archive unavailable" }) }),
  }), { message: "Archive unavailable", status: 503 });
  await assert.rejects(fetchJson("/api/videos", {}, {
    fetchImpl: async () => ({ ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } }),
  }), { name: "SyntaxError" });
});

test("changing request scope cancels the old body and allows a fresh request to recover", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = new AbortController();
  const staleBody = deferred();
  let transportSignal;
  const request = fetchJson("/api/videos?creatorId=old", { signal: scope.signal }, {
    fetchImpl: async (_url, init) => {
      transportSignal = init.signal;
      return { ok: true, json: () => staleBody.promise };
    },
  });
  const rejected = assert.rejects(request, { name: "AbortError" });
  await Promise.resolve();
  scope.abort();
  await rejected;
  assert.equal(transportSignal.aborted, true);
  staleBody.resolve({ items: [{ id: "old" }] });
  assert.deepEqual(await fetchJson("/api/videos?creatorId=new", {}, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ items: [{ id: "new" }] }) }),
  }), { items: [{ id: "new" }] });
  t.mock.timers.tick(JSON_REQUEST_TIMEOUT_MS);
});

test("completed JSON requests remove their deadline and caller abort listener", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const caller = new AbortController();
  let transportSignal;
  assert.deepEqual(await fetchJson("/api/videos", { signal: caller.signal }, {
    fetchImpl: async (_url, init) => {
      transportSignal = init.signal;
      return { ok: true, json: async () => ({ items: [] }) };
    },
  }), { items: [] });
  caller.abort();
  t.mock.timers.tick(JSON_REQUEST_TIMEOUT_MS);
  assert.equal(transportSignal.aborted, false);
});

test("an already canceled JSON request never opens a transport", async () => {
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(fetchJson("/api/videos", { signal: caller.signal }, {
    fetchImpl: () => assert.fail("Canceled request must not fetch"),
  }), { name: "AbortError" });
});
