import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { UPSTREAM_TOKEN } from "./fixture-config.mjs";

// The fixture runs on an internal, job-owned Docker network with no host ports.
const counts = { http: 0, websocket: 0, rejectedAuth: 0, wrongOrigin: 0 };
const server = createServer(async (request, response) => {
  if (request.url === "/__ci_diagnostics") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(counts));
    return;
  }
  counts.http += 1;
  if (request.headers["x-ci-upstream-auth"] !== UPSTREAM_TOKEN) {
    counts.rejectedAuth += 1;
    response.writeHead(401);
    response.end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  response.writeHead(200, {
    "content-type": "application/json",
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
    "cache-control": "public, max-age=3600",
  });
  response.end(JSON.stringify({
    method: request.method, path: request.url,
    body: Buffer.concat(chunks).toString("utf8"), authenticated: true,
  }));
});
server.on("upgrade", (request, socket, head) => {
  counts.websocket += 1;
  if (request.headers["x-ci-upstream-auth"] !== UPSTREAM_TOKEN) {
    counts.rejectedAuth += 1;
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(String(request.headers["sec-websocket-key"]) + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  if (head.length) socket.write(head);
  socket.on("error", () => {});
  socket.pipe(socket); // Byte-forwarding fixture, not an E2B/browser server.
});
server.listen(3100, "0.0.0.0");
const wrongOrigin = createServer((_request, response) => {
  counts.wrongOrigin += 1;
  response.writeHead(200);
  response.end("wrong-origin-fixture");
});
wrongOrigin.on("upgrade", (_request, socket) => {
  counts.wrongOrigin += 1;
  socket.end("HTTP/1.1 500 Unexpected upstream contact\r\n\r\n");
});
wrongOrigin.listen(3101, "0.0.0.0");
