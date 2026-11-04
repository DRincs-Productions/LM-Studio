import { sign } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { getClientIdToken, readCredential } from "./auth.js";

export interface RelayMessage {
  version: 1;
  type: string;
  messageId?: string;
  replyTo?: string;
  requestId?: string;
  jobId?: string;
  [key: string]: unknown;
}

interface InboxWaiter {
  predicate: (message: RelayMessage) => boolean;
  resolve: (message: RelayMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const MAX_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MESSAGE_QUEUES = new WeakMap<WebSocket, MessageInbox>();

export async function relayStatus(): Promise<void> {
  return withRelay(async (_socket, ready) => {
    if (ready.serverOnline !== true) throw new Error("Client is authenticated, but the paired server is offline.");
  });
}

export async function callRelay(message: RelayMessage, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RelayMessage> {
  const messageId = message.messageId;
  if (!messageId) throw new Error("Relay request is missing a messageId.");
  return withRelay(async (socket) => {
    const reply = waitForMessage(socket, (candidate) => candidate.replyTo === messageId && candidate.type !== "job.progress", timeoutMs);
    sendJson(socket, message);
    return reply;
  });
}

async function withRelay<T>(operation: (socket: WebSocket, ready: RelayMessage) => Promise<T>): Promise<T> {
  const credential = readCredential();
  if (!credential) throw new Error("Sign in first with `shadow-client login`.");
  if (!credential.registered) throw new Error("Client enrollment is incomplete. Run `shadow-client register`.");
  const relayBase = process.env.SHADOW_RELAY_URL;
  if (!relayBase) throw new Error("Set SHADOW_RELAY_URL to the relay HTTPS URL before connecting.");
  const url = new URL(relayBase);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname)) url.protocol = "ws:";
  if (url.protocol !== "wss:" && url.protocol !== "ws:") throw new Error("SHADOW_RELAY_URL must use HTTPS/WSS (or local HTTP/WS during development).");
  url.pathname = `${url.pathname.replace(/\/$/, "")}/connect`;
  url.search = new URLSearchParams({ role: "client", clientId: credential.clientId }).toString();
  const idToken = await getClientIdToken();
  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${idToken}` },
    maxPayload: MAX_MESSAGE_BYTES,
    perMessageDeflate: false,
  });
  socket.on("error", () => undefined);
  MESSAGE_QUEUES.set(socket, new MessageInbox(socket));
  try {
    await waitForOpen(socket);
    const challenge = await waitForMessage(socket, (message) => message.type === "relay.challenge" || message.type === "relay.ready");
    let ready = challenge;
    if (challenge.type === "relay.challenge") {
      if (typeof challenge.challenge !== "string") throw new Error("Relay sent an invalid authentication challenge.");
      const nonce = Buffer.from(challenge.challenge, "base64url");
      const signature = sign(null, nonce, credential.privateKey).toString("base64url");
      sendJson(socket, { version: 1, type: "auth.proof", challenge: challenge.challenge, signature });
      ready = await waitForMessage(socket, (message) => message.type === "relay.ready", 10_000);
      if (ready.type !== "relay.ready") throw new Error("Relay client authentication failed.");
    }
    return await operation(socket, ready);
  } catch (error) {
    if (error instanceof Error && error.message.includes("Relay request timed out")) throw error;
    throw normalizeRelayError(error);
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000, "Request complete");
  }
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Relay connection timed out.")), 15_000);
    const onOpen = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("Relay closed the connection before authentication."));
    function finish(error?: Error): void {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("close", onClose);
      if (error) reject(error);
      else resolve();
    }
    socket.once("open", onOpen);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: RelayMessage) => boolean,
  timeoutMs = 10_000,
): Promise<RelayMessage> {
  const inbox = MESSAGE_QUEUES.get(socket);
  if (!inbox) return Promise.reject(new Error("Relay message listener is unavailable."));
  return inbox.wait(predicate, timeoutMs);
}

function sendJson(socket: WebSocket, message: unknown): void {
  const body = JSON.stringify(message);
  if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) throw new Error("Relay request exceeds the 64 KiB message limit.");
  socket.send(body);
}

function errorText(message: RelayMessage): string {
  const error = message.error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "Relay rejected the request.";
}

function normalizeRelayError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error("Relay connection failed.");
}

class MessageInbox {
  private readonly messages: RelayMessage[] = [];
  private readonly waiters = new Set<InboxWaiter>();

  constructor(socket: WebSocket) {
    socket.on("message", (raw: RawData, isBinary: boolean) => {
      if (isBinary) return this.failAll(new Error("Relay returned an unexpected binary message."));
      let message: RelayMessage;
      try {
        message = JSON.parse(raw.toString()) as RelayMessage;
      } catch {
        return this.failAll(new Error("Relay returned an invalid JSON message."));
      }
      if (message.type === "error" && message.replyTo === undefined) {
        return this.failAll(new Error(errorText(message)));
      }
      const waiter = [...this.waiters].find((entry) => entry.predicate(message));
      if (waiter) this.resolve(waiter, message);
      else {
        this.messages.push(message);
        if (this.messages.length > 32) this.messages.shift();
      }
    });
    socket.on("error", (error: Error) => this.failAll(error));
    socket.on("close", (code: number, reason: Buffer) => {
      this.failAll(new Error(`Relay closed the connection (${code}): ${reason.toString()}`));
    });
  }

  wait(predicate: (message: RelayMessage) => boolean, timeoutMs: number): Promise<RelayMessage> {
    const queuedIndex = this.messages.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(this.messages.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Relay request timed out after ${timeoutMs} ms.`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private resolve(waiter: InboxWaiter, message: RelayMessage): void {
    this.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}
