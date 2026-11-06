import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index.js";

interface RelayIdentity {
  uid: string;
  role: "server" | "client";
  serverId?: string;
  clientId?: string;
  publicKey?: string;
}

interface SocketAttachment extends RelayIdentity {
  connectionId: string;
  authenticated: boolean;
  challenge?: string;
  pendingMessageIds: string[];
}

interface RelayMessage {
  version: 1;
  type: string;
  messageId?: string;
  replyTo?: string;
  requestId?: string;
  jobId?: string;
  clientId?: string;
  [key: string]: unknown;
}

const MESSAGE_LIMIT_BYTES = 64 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_REQUEST_TYPES = new Set([
  "job.submit", "job.status", "job.list", "job.cancel", "job.retry", "asset.list", "asset.get",
]);
const SERVER_RESPONSE_TYPES = new Set([
  "job.accepted", "job.progress", "job.completed", "job.failed", "job.cancelled",
  "job.status", "job.list", "job.cancel.accepted", "job.retry.accepted",
  "asset.list", "asset.available", "asset.unavailable", "error",
]);

export class AccountRelay extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    let identity: RelayIdentity;
    try {
      identity = JSON.parse(request.headers.get("x-shadow-relay-identity") ?? "") as RelayIdentity;
    } catch {
      return new Response("Unauthorized.", { status: 401 });
    }
    if (!identity.uid || (identity.role !== "server" && identity.role !== "client")) {
      return new Response("Unauthorized.", { status: 401 });
    }

    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= 16) return new Response("Too many active connections.", { status: 429 });
    const pair = new WebSocketPair();
    const clientSocket = pair[0];
    const serverSocket = pair[1];
    const attachment: SocketAttachment = {
      ...identity,
      connectionId: crypto.randomUUID(),
      authenticated: identity.role === "server",
      pendingMessageIds: [],
    };
    if (identity.role === "client") {
      if (!identity.clientId || !UUID_PATTERN.test(identity.clientId) || !identity.publicKey) {
        return new Response("Unauthorized.", { status: 401 });
      }
      attachment.challenge = randomChallenge();
    } else if (!identity.serverId || !UUID_PATTERN.test(identity.serverId)) {
      return new Response("Unauthorized.", { status: 401 });
    }

    if (identity.role === "server") {
      for (const socket of this.ctx.getWebSockets("server")) {
        socket.close(4001, "Server connection replaced");
      }
    }

    serverSocket.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(serverSocket, [identity.role]);
    if (identity.role === "client") {
      sendJson(serverSocket, {
        version: 1,
        type: "relay.challenge",
        messageId: crypto.randomUUID(),
        challenge: attachment.challenge,
      });
    } else {
      sendJson(serverSocket, { version: 1, type: "relay.ready", messageId: crypto.randomUUID() });
    }

    return new Response(null, { status: 101, webSocket: clientSocket });
  }

  async webSocketMessage(socket: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || rawMessage instanceof ArrayBuffer) return this.close(socket, 4002, "Invalid message format");
    if (new TextEncoder().encode(rawMessage).byteLength > MESSAGE_LIMIT_BYTES) {
      return this.close(socket, 4003, "Message exceeds size limit");
    }
    let message: RelayMessage;
    try {
      message = JSON.parse(rawMessage) as RelayMessage;
    } catch {
      return this.close(socket, 4002, "Invalid JSON message");
    }
    if (message.version !== 1 || typeof message.type !== "string") {
      return this.close(socket, 4004, "Unsupported protocol version");
    }

    if (attachment.role === "client" && !attachment.authenticated) {
      return this.authenticateClientSocket(socket, attachment, message);
    }
    if (message.type === "relay.ping") {
      sendJson(socket, { version: 1, type: "relay.pong", messageId: message.messageId ?? crypto.randomUUID() });
      return;
    }
    if (attachment.role === "client") return this.handleClientMessage(socket, attachment, message);
    if (attachment.role === "server") return this.handleServerMessage(message);
    return this.close(socket, 4001, "Unknown connection role");
  }

  webSocketClose(_socket: WebSocket, _code: number, _reason: string): void {
    // The runtime has already closed the socket when this event is delivered.
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, "WebSocket error");
  }

  private async authenticateClientSocket(
    socket: WebSocket,
    attachment: SocketAttachment,
    message: RelayMessage,
  ): Promise<void> {
    if (message.type !== "auth.proof" || message.challenge !== attachment.challenge || typeof message.signature !== "string") {
      return this.close(socket, 4001, "Client proof required");
    }
    let signature: Uint8Array<ArrayBuffer>;
    let key: CryptoKey;
    try {
      signature = decodeBase64Url(message.signature);
      key = await crypto.subtle.importKey("spki", pemToBytes(attachment.publicKey!), { name: "Ed25519" }, false, ["verify"]);
    } catch {
      return this.close(socket, 4001, "Invalid client key proof");
    }
    const valid = await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      signature,
      decodeBase64Url(attachment.challenge!),
    ).catch(() => false);
    if (!valid) return this.close(socket, 4001, "Invalid client key proof");
    attachment.authenticated = true;
    delete attachment.challenge;
    socket.serializeAttachment(attachment);
    sendJson(socket, {
      version: 1,
      type: "relay.ready",
      messageId: crypto.randomUUID(),
      serverOnline: this.hasActiveServer(),
    });
  }

  private handleClientMessage(socket: WebSocket, attachment: SocketAttachment, message: RelayMessage): void {
    if (!CLIENT_REQUEST_TYPES.has(message.type) || !isUuid(message.messageId)) {
      return this.sendError(socket, message.messageId, "invalid_payload", "Unsupported client message.");
    }
    if (message.requestId !== undefined && !isUuid(message.requestId)) {
      return this.sendError(socket, message.messageId, "invalid_payload", "requestId must be a UUID.");
    }
    if (message.jobId !== undefined && !isUuid(message.jobId)) {
      return this.sendError(socket, message.messageId, "invalid_payload", "jobId must be a UUID.");
    }
    const serverSocket = this.ctx.getWebSockets("server").find((candidate) => {
      const server = candidate.deserializeAttachment() as SocketAttachment | null;
      return candidate.readyState === WebSocket.OPEN
        && server?.role === "server"
        && server.authenticated
        && server.serverId === attachment.serverId;
    });
    if (!serverSocket) return this.sendError(socket, message.messageId, "server_offline", "The paired server is offline.");
    if (attachment.pendingMessageIds.length >= 64) {
      return this.sendError(socket, message.messageId, "resource_unavailable", "Too many requests are awaiting server responses.");
    }
    attachment.pendingMessageIds.push(message.messageId);
    socket.serializeAttachment(attachment);
    try {
      serverSocket.send(JSON.stringify({
        ...message,
        uid: attachment.uid,
        clientId: attachment.clientId,
        originClientId: attachment.clientId,
        originConnectionId: attachment.connectionId,
      }));
    } catch {
      attachment.pendingMessageIds = attachment.pendingMessageIds.filter((id) => id !== message.messageId);
      socket.serializeAttachment(attachment);
      this.sendError(socket, message.messageId, "server_offline", "The paired server is offline.");
    }
  }

  private handleServerMessage(message: RelayMessage): void {
    if (!SERVER_RESPONSE_TYPES.has(message.type) || !isUuid(message.messageId)) return;
    if (message.replyTo && isUuid(message.replyTo)) {
      for (const clientSocket of this.ctx.getWebSockets("client")) {
        const attachment = clientSocket.deserializeAttachment() as SocketAttachment | null;
        if (!attachment?.authenticated || !attachment.pendingMessageIds.includes(message.replyTo)) continue;
        if (message.uid !== attachment.uid || message.clientId !== attachment.clientId) return;
        sendJson(clientSocket, message);
        if (message.type !== "job.progress") {
          attachment.pendingMessageIds = attachment.pendingMessageIds.filter((id) => id !== message.replyTo);
          clientSocket.serializeAttachment(attachment);
        }
        return;
      }
      return;
    }
    if (message.clientId && isUuid(message.clientId)) {
      for (const clientSocket of this.ctx.getWebSockets("client")) {
        const attachment = clientSocket.deserializeAttachment() as SocketAttachment | null;
        if (attachment?.authenticated && attachment.clientId === message.clientId) sendJson(clientSocket, message);
      }
    }
  }

  private hasActiveServer(): boolean {
    return this.ctx.getWebSockets("server").some((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      return socket.readyState === WebSocket.OPEN && attachment?.role === "server" && attachment.authenticated;
    });
  }

  private sendError(socket: WebSocket, replyTo: unknown, code: string, message: string): void {
    sendJson(socket, {
      version: 1,
      type: "error",
      messageId: crypto.randomUUID(),
      ...(isUuid(replyTo) ? { replyTo } : {}),
      error: { code, message, retryable: code === "server_offline" || code === "resource_unavailable" },
    });
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // The peer may already be disconnected.
    }
  }
}

function sendJson(socket: WebSocket, message: unknown): void {
  try {
    socket.send(JSON.stringify(message));
  } catch {
    socket.close(1011, "Unable to send relay message");
  }
}

function randomChallenge(): string {
  const value = crypto.getRandomValues(new Uint8Array(32));
  return encodeBase64Url(value);
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function pemToBytes(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}
