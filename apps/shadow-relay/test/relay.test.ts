import { createExecutionContext } from "cloudflare:test";
import { env as testEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { authenticateRequest, type Env } from "../src/index.js";

const uid = "firebase-user-123";
const serverId = "148a32da-6c82-4b0e-a1c3-a567070d5511";
const clientId = "8ca526fe-d203-4589-bf90-fcabfd981f7e";
const publicKey = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA//////////////////////////////////////////8=\n-----END PUBLIC KEY-----";

afterEach(() => vi.unstubAllGlobals());

function makeEnv(state = "setup"): Env {
  return {
    ACCOUNT_RELAY: testEnv.ACCOUNT_RELAY,
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_API_KEY: "test-key",
    RELAY_STATE: state,
  };
}

function request(url: string, token?: string, websocket = false): Request {
  return new Request(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(websocket ? { Upgrade: "websocket" } : {}),
    },
  });
}

function mockFirebase(options: {
  verified?: boolean;
  google?: boolean;
  accountServerId?: string;
  authorizedClient?: boolean;
  publicKeyPem?: string;
} = {}) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    calls.push(url.href);
    if (url.hostname === "identitytoolkit.googleapis.com") {
      return Response.json({ users: [{
        localId: uid,
        emailVerified: options.verified ?? true,
        providerUserInfo: options.google === false ? [{ providerId: "password" }] : [{ providerId: "google.com" }],
      }] });
    }
    if (url.hostname === "firestore.googleapis.com") {
      if (url.pathname.endsWith(`/accounts/${uid}`)) {
        return Response.json({ fields: { serverId: { stringValue: options.accountServerId ?? serverId } } });
      }
      if (url.pathname.endsWith(`/accounts/${uid}/authorizedClients/${clientId}`) && options.authorizedClient !== false) {
        return Response.json({ fields: { publicKey: { stringValue: options.publicKeyPem ?? publicKey } } });
      }
      return new Response("not found", { status: 404 });
    }
    throw new Error(`Unexpected outbound request to ${url.origin}`);
  }));
  return calls;
}

async function enrolledKey() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  let binary = "";
  for (const byte of spki) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(binary)}\n-----END PUBLIC KEY-----`;
  return { privateKey: pair.privateKey, pem };
}

function receiveJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for relay message")), 1500);
    socket.addEventListener("message", (event) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    }, { once: true });
  });
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("relay fail-closed behavior", () => {
  it("reports setup and rejects connections before Firebase or Durable Object access", async () => {
    const calls = mockFirebase();
    const response = await worker.fetch(
      request(`https://relay.test/connect?role=server&serverId=${serverId}`, "token", true),
      makeEnv("setup"),
      createExecutionContext(),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "relay_closed" } });
    expect(calls).toHaveLength(0);
  });

  it("reports the current state at the health endpoint", async () => {
    const response = await worker.fetch(
      request("https://relay.test/health"),
      makeEnv("setup"),
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "shadow-controller-relay", status: "setup" });
  });

  it("requires a WebSocket upgrade when active", async () => {
    const response = await worker.fetch(
      request(`https://relay.test/connect?role=server&serverId=${serverId}`, "token"),
      makeEnv("active"),
      createExecutionContext(),
    );
    expect(response.status).toBe(426);
  });

  it("rejects missing credentials before contacting Firebase", async () => {
    const calls = mockFirebase();
    const result = await authenticateRequest(
      request(`https://relay.test/connect?role=server&serverId=${serverId}`),
      new URL(`https://relay.test/connect?role=server&serverId=${serverId}`),
      makeEnv("active"),
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed device IDs before contacting Firebase", async () => {
    const calls = mockFirebase();
    const result = await authenticateRequest(
      request("https://relay.test/connect?role=client&clientId=not-a-uuid", "test-token"),
      new URL("https://relay.test/connect?role=client&clientId=not-a-uuid"),
      makeEnv("active"),
    );
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("rejects identities without verified Google sign-in", async () => {
    mockFirebase({ verified: false });
    const result = await authenticateRequest(
      request(`https://relay.test/connect?role=server&serverId=${serverId}`, "test-token"),
      new URL(`https://relay.test/connect?role=server&serverId=${serverId}`),
      makeEnv("active"),
    );
    expect(result).toBeNull();

    mockFirebase({ google: false });
    const nonGoogle = await authenticateRequest(
      request(`https://relay.test/connect?role=server&serverId=${serverId}`, "test-token"),
      new URL(`https://relay.test/connect?role=server&serverId=${serverId}`),
      makeEnv("active"),
    );
    expect(nonGoogle).toBeNull();
  });

  it("checks the server pairing against the caller's Firebase account", async () => {
    mockFirebase({ accountServerId: "2d7ff291-57d7-4cf1-875c-50e19661e98f" });
    const result = await authenticateRequest(
      request(`https://relay.test/connect?role=server&serverId=${serverId}`, "test-token"),
      new URL(`https://relay.test/connect?role=server&serverId=${serverId}`),
      makeEnv("active"),
    );
    expect(result).toBeNull();
  });

  it("authorizes a client only when its Firebase device record exists", async () => {
    mockFirebase({ authorizedClient: false });
    const result = await authenticateRequest(
      request(`https://relay.test/connect?role=client&clientId=${clientId}`, "test-token"),
      new URL(`https://relay.test/connect?role=client&clientId=${clientId}`),
      makeEnv("active"),
    );
    expect(result).toBeNull();
  });

  it("returns only the authenticated user's server and enrolled device identity", async () => {
    mockFirebase();
    const result = await authenticateRequest(
      request(`https://relay.test/connect?role=client&clientId=${clientId}`, "test-token"),
      new URL(`https://relay.test/connect?role=client&clientId=${clientId}`),
      makeEnv("active"),
    );
    expect(result).toEqual({ uid, role: "client", serverId, clientId, publicKey });
  });

  it("requires an Ed25519 proof and immediately rejects authorized clients when the server is offline", async () => {
    const key = await enrolledKey();
    mockFirebase({ publicKeyPem: key.pem });
    const response = await worker.fetch(
      request(`https://relay.test/connect?role=client&clientId=${clientId}`, "test-token", true),
      makeEnv("active"),
      createExecutionContext(),
    );
    expect(response.status).toBe(101);
    const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
    expect(socket).toBeDefined();
    socket!.accept();

    const challengeMessage = await receiveJson(socket!);
    expect(challengeMessage.type).toBe("relay.challenge");
    const challenge = String(challengeMessage.challenge);
    const signature = await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, decodeBase64Url(challenge));
    socket!.send(JSON.stringify({ version: 1, type: "auth.proof", challenge, signature: encodeBase64Url(signature) }));

    const ready = await receiveJson(socket!);
    expect(ready).toMatchObject({ type: "relay.ready", serverOnline: false });
    const messageId = crypto.randomUUID();
    const offlineError = receiveJson(socket!);
    socket!.send(JSON.stringify({
      version: 1,
      type: "job.list",
      messageId,
      limit: 10,
    }));
    expect(await offlineError).toMatchObject({
      type: "error",
      replyTo: messageId,
      error: { code: "server_offline" },
    });
    socket!.close();
  });

  it("closes an enrolled client's socket when its Ed25519 proof is invalid", async () => {
    const key = await enrolledKey();
    mockFirebase({ publicKeyPem: key.pem });
    const response = await worker.fetch(
      request(`https://relay.test/connect?role=client&clientId=${clientId}`, "test-token", true),
      makeEnv("active"),
      createExecutionContext(),
    );
    const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
    expect(socket).toBeDefined();
    socket!.accept();
    const challengeMessage = await receiveJson(socket!);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket!.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }), { once: true });
    });
    socket!.send(JSON.stringify({
      version: 1,
      type: "auth.proof",
      challenge: challengeMessage.challenge,
      signature: "AA",
    }));
    expect(await closed).toMatchObject({ code: 4001, reason: "Invalid client key proof" });
  });
});
