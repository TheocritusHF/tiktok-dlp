import http from "node:http";

const BRIDGE_REQUEST_PATH = /^\/(?:api(?:\/|$)|media\/|thumbnail\/|post-media\/|post-download\/)/;

export function isBridgeRequestPath(pathname) {
  return BRIDGE_REQUEST_PATH.test(String(pathname || ""));
}

export function proxyRequest(request, response, targetPort) {
  const forwardedFor = [request.headers["x-forwarded-for"], request.socket.remoteAddress]
    .filter(Boolean)
    .join(", ");
  let upstreamResponse;
  const upstream = http.request({
    host: "127.0.0.1",
    port: targetPort,
    method: request.method,
    path: request.url,
    headers: {
      ...request.headers,
      "x-forwarded-for": forwardedFor,
      "x-forwarded-host": request.headers.host || "",
      "x-forwarded-proto": request.headers["x-forwarded-proto"] || "http",
    },
  }, (incoming) => {
    upstreamResponse = incoming;
    if (response.destroyed) {
      incoming.destroy();
      return;
    }
    incoming.on("error", (error) => response.destroy(error));
    response.writeHead(incoming.statusCode || 502, incoming.headers);
    incoming.pipe(response);
  });

  // A seek or swipe closes the response after the GET request has already ended.
  const cancelUpstream = () => {
    upstreamResponse?.destroy();
    upstream.destroy();
  };
  response.once("close", () => {
    if (!response.writableFinished) cancelUpstream();
  });
  request.once("aborted", cancelUpstream);
  request.once("error", cancelUpstream);
  upstream.on("error", (error) => {
    if (response.destroyed) return;
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Rewind service is starting" }));
  });
  request.pipe(upstream);
}
