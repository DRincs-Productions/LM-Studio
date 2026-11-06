import { AccountRelay } from "./relay.js";

export { AccountRelay };

export interface Env {
  ACCOUNT_RELAY: DurableObjectNamespace<AccountRelay>;
  FIREBASE_PROJECT_ID: string;
  FIREBASE_API_KEY: string;
  RELAY_STATE: string;
}

interface FirebaseUser {
  localId: string;
  emailVerified?: boolean;
  providerUserInfo?: Array<{ providerId: string }>;
}

interface FirebaseLookup {
  users?: FirebaseUser[];
}

interface FirestoreDocument {
  fields?: Record<string, { stringValue?: string }>;
}

export interface RelayIdentity {
  uid: string;
  role: "server" | "client";
  serverId?: string;
  clientId?: string;
  publicKey?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ service: "shadow-controller-relay", status: env.RELAY_STATE === "active" ? "active" : "setup" });
    }
    if (request.method !== "GET" || url.pathname !== "/connect") {
      return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
    }
    if (env.RELAY_STATE !== "active") {
      return Response.json({ error: { code: "relay_closed", message: "The relay is not accepting connections." } }, { status: 503 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: { code: "invalid_request", message: "A WebSocket upgrade is required." } }, { status: 426 });
    }

    const identity = await authenticateRequest(request, url, env);
    if (!identity) {
      return Response.json({ error: { code: "unauthorized", message: "Firebase identity or device authorization was rejected." } }, { status: 401 });
    }

    const account = env.ACCOUNT_RELAY.getByName(identity.uid);
    const headers = new Headers(request.headers);
    headers.delete("authorization");
    headers.set("x-shadow-relay-identity", JSON.stringify(identity));
    return account.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

export async function authenticateRequest(request: Request, url: URL, env: Env): Promise<RelayIdentity | null> {
  const authorization = request.headers.get("Authorization");
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return null;

  const role = url.searchParams.get("role");
  if (role !== "server" && role !== "client") return null;
  const requestedServerId = role === "server" ? url.searchParams.get("serverId") : null;
  const clientId = role === "client" ? url.searchParams.get("clientId") : null;
  if (role === "server" && (!requestedServerId || !UUID_PATTERN.test(requestedServerId))) return null;
  if (role === "client" && (!clientId || !UUID_PATTERN.test(clientId))) return null;

  const lookupResponse = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(env.FIREBASE_API_KEY)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: match[1] }),
    },
  ).catch(() => null);
  if (!lookupResponse?.ok) return null;
  const lookup = await lookupResponse.json() as FirebaseLookup;
  const user = lookup.users?.[0];
  if (!user?.localId || !user.emailVerified || !user.providerUserInfo?.some((provider) => provider.providerId === "google.com")) {
    return null;
  }

  if (role === "server") {
    const document = await readFirestoreDocument(match[1], `accounts/${encodeURIComponent(user.localId)}`, env);
    if (document?.fields?.serverId?.stringValue !== requestedServerId) return null;
    return { uid: user.localId, role, serverId: requestedServerId! };
  }

  const account = await readFirestoreDocument(match[1], `accounts/${encodeURIComponent(user.localId)}`, env);
  const serverId = account?.fields?.serverId?.stringValue;
  if (!serverId || !UUID_PATTERN.test(serverId)) return null;
  const document = await readFirestoreDocument(
    match[1],
    `accounts/${encodeURIComponent(user.localId)}/authorizedClients/${encodeURIComponent(clientId!)}`,
    env,
  );
  const publicKey = document?.fields?.publicKey?.stringValue;
  if (!publicKey || publicKey.length > 512) return null;
  return { uid: user.localId, role, serverId, clientId: clientId!, publicKey };
}

async function readFirestoreDocument(idToken: string, path: string, env: Env): Promise<FirestoreDocument | null> {
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(env.FIREBASE_PROJECT_ID)}/databases/(default)/documents/${path}`,
    { headers: { Authorization: `Bearer ${idToken}` } },
  ).catch(() => null);
  if (!response?.ok) return null;
  return await response.json() as FirestoreDocument;
}
