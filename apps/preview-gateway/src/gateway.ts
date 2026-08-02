import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";

import {
  PreviewTicketError,
  type PreviewSessionStore,
  type PreviewTarget,
  type PreviewTicketSigner,
} from "@atoms/preview";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface PreviewGatewayOptions {
  readonly signer: PreviewTicketSigner;
  readonly store: PreviewSessionStore;
  readonly uiOrigin: string;
  readonly onError?: (error: unknown) => void;
}

class GatewayRequestError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function buildPreviewGateway(options: PreviewGatewayOptions): Server {
  const uiOrigin = parseUiOrigin(options.uiOrigin);
  const server = createServer((request, response) => {
    if (request.url === "/healthz") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end('{"status":"ok"}');
      return;
    }

    void resolveTarget(options, request.headers.host)
      .then((target) => {
        const upstreamUrl = new URL(request.url ?? "/", target.upstreamUrl);
        const transport = upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest;
        const upstreamRequest = transport(
          upstreamUrl,
          {
            method: request.method,
            headers: requestHeaders(
              request.headers,
              target,
              request.headers.host,
              upstreamUrl.host,
            ),
          },
          (upstreamResponse) => {
            response.writeHead(
              upstreamResponse.statusCode ?? 502,
              responseHeaders(upstreamResponse.headers, uiOrigin),
            );
            upstreamResponse.pipe(response);
          },
        );
        upstreamRequest.on("error", (error) => {
          options.onError?.(error);
          if (!response.headersSent) {
            writeError(response, 502, "Preview upstream unavailable");
          } else {
            response.destroy(error);
          }
        });
        request.on("aborted", () => upstreamRequest.destroy());
        request.pipe(upstreamRequest);
      })
      .catch((error: unknown) => {
        const statusCode =
          error instanceof GatewayRequestError ? error.statusCode : 500;
        if (!(error instanceof GatewayRequestError)) options.onError?.(error);
        writeError(response, statusCode, publicErrorMessage(statusCode));
      });
  });

  server.on("upgrade", (request, socket, head) => {
    void proxyUpgrade(options, request, socket, head).catch((error: unknown) => {
      const statusCode =
        error instanceof GatewayRequestError ? error.statusCode : 502;
      if (!(error instanceof GatewayRequestError)) options.onError?.(error);
      if (!socket.destroyed) {
        socket.write(
          `HTTP/1.1 ${String(statusCode)} ${statusText(statusCode)}\r\nConnection: close\r\n\r\n`,
        );
        socket.destroy();
      }
    });
  });
  return server;
}

async function resolveTarget(
  options: PreviewGatewayOptions,
  host: string | undefined,
): Promise<PreviewTarget> {
  if (host === undefined) throw new GatewayRequestError(401, "Missing host");
  let sessionId: string;
  try {
    sessionId = options.signer.verifyHost(host).sessionId;
  } catch (error) {
    if (error instanceof PreviewTicketError) {
      throw new GatewayRequestError(
        error.code === "EXPIRED_TICKET" ? 410 : 401,
        "Invalid preview ticket",
      );
    }
    throw error;
  }
  const target = await options.store.get(sessionId);
  if (target === null || target.sessionId !== sessionId) {
    throw new GatewayRequestError(404, "Preview session not found");
  }
  return target;
}

function requestHeaders(
  incoming: IncomingHttpHeaders,
  target: PreviewTarget,
  originalHost: string | undefined,
  upstreamHost: string,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !hopByHopHeaders.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  headers.host = upstreamHost;
  headers["x-forwarded-host"] = originalHost ?? "";
  headers["x-forwarded-proto"] = "https";
  for (const [name, value] of Object.entries(target.requestHeaders)) {
    headers[name] = value;
  }
  return headers;
}

function responseHeaders(
  incoming: IncomingHttpHeaders,
  uiOrigin: string,
): IncomingHttpHeaders {
  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (
      value !== undefined &&
      !hopByHopHeaders.has(name.toLowerCase()) &&
      !["content-security-policy", "x-frame-options"].includes(
        name.toLowerCase(),
      )
    ) {
      headers[name] = value;
    }
  }
  headers["cache-control"] = "no-store";
  headers["content-security-policy"] = [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-ancestors ${uiOrigin}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
  headers["permissions-policy"] =
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()";
  headers["referrer-policy"] = "no-referrer";
  headers["x-content-type-options"] = "nosniff";
  return headers;
}

async function proxyUpgrade(
  options: PreviewGatewayOptions,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const target = await resolveTarget(options, request.headers.host);
  const upstreamUrl = new URL(request.url ?? "/", target.upstreamUrl);
  const transport = upstreamUrl.protocol === "https:" ? httpsRequest : httpRequest;
  const headers = requestHeaders(
    request.headers,
    target,
    request.headers.host,
    upstreamUrl.host,
  );
  headers.connection = "Upgrade";
  headers.upgrade = request.headers.upgrade ?? "websocket";

  await new Promise<void>((resolve, reject) => {
    const upstreamRequest = transport(upstreamUrl, {
      method: request.method ?? "GET",
      headers,
    });
    upstreamRequest.once("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const statusLine = `HTTP/${upstreamResponse.httpVersion} ${String(upstreamResponse.statusCode ?? 101)} ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n`;
      socket.write(`${statusLine}${rawHeaderLines(upstreamResponse.rawHeaders)}\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      resolve();
    });
    upstreamRequest.once("response", () => {
      reject(new GatewayRequestError(502, "Upstream rejected WebSocket"));
    });
    upstreamRequest.once("error", reject);
    upstreamRequest.end();
  });
}

function rawHeaderLines(rawHeaders: readonly string[]): string {
  const lines: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name !== undefined && value !== undefined) lines.push(`${name}: ${value}\r\n`);
  }
  return lines.join("");
}

function parseUiOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.origin === "null") {
    throw new TypeError("uiOrigin must be an HTTP(S) origin");
  }
  return url.origin;
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  message: string,
): void {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify({ error: message }));
}

function publicErrorMessage(statusCode: number): string {
  if (statusCode === 401) return "Invalid preview URL";
  if (statusCode === 404) return "Preview not found";
  if (statusCode === 410) return "Preview expired";
  return "Preview gateway error";
}

function statusText(statusCode: number): string {
  if (statusCode === 401) return "Unauthorized";
  if (statusCode === 404) return "Not Found";
  if (statusCode === 410) return "Gone";
  return "Bad Gateway";
}
