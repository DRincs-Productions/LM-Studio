import { Entry } from "@napi-rs/keyring";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const API_KEY = "AIzaSyCO-OtHIxbarCVRGh3qLDeNhUT2ArrngUY";
const PROJECT_ID = "shadow-controller-20261103";
const FIRESTORE_DOCUMENTS_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const AUTH_ORIGIN = `https://${PROJECT_ID}.firebaseapp.com`;
const KEYRING_SERVICE = "com.drincs.shadowcontroller.client";
const KEYRING_ACCOUNT = "firebase-session";

export interface ClientCredential {
  uid: string;
  email: string;
  clientId: string;
  displayName: string;
  refreshToken: string;
  privateKey: string;
  publicKey: string;
  registered: boolean;
}

interface FirebaseRefreshResponse {
  id_token: string;
  refresh_token: string;
  user_id: string;
}

interface FirebaseUserLookup {
  users?: Array<{
    localId: string;
    email?: string;
    emailVerified: boolean;
    providerUserInfo?: Array<{ providerId: string }>;
  }>;
}

interface LoginCallback {
  state: string;
  port: number;
  idToken: string;
  refreshToken: string;
}

interface FirestoreDocument {
  fields?: Record<string, { stringValue?: string }>;
}

function keyringEntry(): Entry {
  return new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT);
}

export function readCredential(): ClientCredential | null {
  const serialized = keyringEntry().getPassword();
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized) as ClientCredential;
    if (!value.uid || !value.clientId || !value.refreshToken || !value.privateKey || !value.publicKey) {
      throw new Error("Missing required credential fields");
    }
    return value;
  } catch {
    throw new Error("The saved client credential is invalid. Remove it from the operating system credential store.");
  }
}

function saveCredential(credential: ClientCredential): void {
  keyringEntry().setPassword(JSON.stringify(credential));
}

export async function login(): Promise<ClientCredential> {
  if (readCredential()) throw new Error("A client account is already signed in. Run `shadow-client logout` first.");
  const callback = await browserLogin();
  const user = await verifyGoogleIdentity(callback.idToken);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const clientId = randomUUID();
  const credential: ClientCredential = {
    uid: user.uid,
    email: user.email,
    clientId,
    displayName: hostname().slice(0, 100) || "Shadow client",
    refreshToken: callback.refreshToken,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    registered: false,
  };
  saveCredential(credential);
  return enrollClient();
}

export async function enrollClient(): Promise<ClientCredential> {
  let credential = readCredential();
  if (!credential) throw new Error("Sign in first by running `shadow-client login`.");
  const refreshed = await refreshToken(credential.refreshToken);
  if (refreshed.user_id !== credential.uid) throw new Error("Firebase refreshed credentials for a different account.");
  credential = { ...credential, refreshToken: refreshed.refresh_token };
  saveCredential(credential);

  const documentUrl = `${FIRESTORE_DOCUMENTS_URL}/accounts/${credential.uid}/authorizedClients/${credential.clientId}`;
  const existing = await fetch(documentUrl, { headers: { Authorization: `Bearer ${refreshed.id_token}` } });
  if (existing.ok) {
    const document = await existing.json() as FirestoreDocument;
    const registeredKey = document.fields?.publicKey?.stringValue;
    if (registeredKey !== credential.publicKey) throw new Error("The client ID is already registered with a different public key.");
    credential = { ...credential, registered: true };
    saveCredential(credential);
    return credential;
  }
  if (existing.status !== 404) throw new Error("Firebase could not check the client registration.");

  const registration = await fetch(`${FIRESTORE_DOCUMENTS_URL}:commit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refreshed.id_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      writes: [{
        update: {
          name: documentUrl,
          fields: {
            displayName: { stringValue: credential.displayName },
            publicKey: { stringValue: credential.publicKey },
          },
        },
        currentDocument: { exists: false },
      }],
    }),
  });
  if (!registration.ok) throw new Error("Firebase rejected client enrollment. Check the Firestore database and security rules.");
  credential = { ...credential, registered: true };
  saveCredential(credential);
  return credential;
}

export async function logout(): Promise<void> {
  const credential = readCredential();
  if (!credential) return;
  const refreshed = await refreshToken(credential.refreshToken);
  if (refreshed.user_id !== credential.uid) throw new Error("Firebase refreshed credentials for a different account.");
  const response = await fetch(`${FIRESTORE_DOCUMENTS_URL}/accounts/${credential.uid}/authorizedClients/${credential.clientId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${refreshed.id_token}` },
  });
  if (!response.ok && response.status !== 404) throw new Error("Firebase could not revoke this client. Its credential remains saved locally.");
  keyringEntry().deletePassword();
}

export async function getClientIdToken(): Promise<string> {
  const credential = readCredential();
  if (!credential) throw new Error("Sign in first by running `shadow-client login`.");
  if (!credential.registered) throw new Error("Client enrollment is incomplete. Run `shadow-client register`.");
  const refreshed = await refreshToken(credential.refreshToken);
  if (refreshed.user_id !== credential.uid) throw new Error("Firebase refreshed credentials for a different account.");
  saveCredential({ ...credential, refreshToken: refreshed.refresh_token });
  return refreshed.id_token;
}

export async function clientStatus(): Promise<ClientCredential | null> {
  return readCredential();
}

async function refreshToken(refreshToken: string): Promise<FirebaseRefreshResponse> {
  const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  });
  if (!response.ok) throw new Error("Firebase sign-in expired or was revoked. Run `shadow-client login` again.");
  return await response.json() as FirebaseRefreshResponse;
}

async function verifyGoogleIdentity(idToken: string): Promise<{ uid: string; email: string }> {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) throw new Error("Firebase rejected the Google sign-in.");
  const lookup = await response.json() as FirebaseUserLookup;
  const user = lookup.users?.[0];
  if (!user?.email || !user.emailVerified || !user.providerUserInfo?.some((provider) => provider.providerId === "google.com")) {
    throw new Error("A Google account with a verified email is required.");
  }
  return { uid: user.localId, email: user.email };
}

async function browserLogin(): Promise<LoginCallback> {
  const state = randomUUID();
  let server: Server | undefined;
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await new Promise<LoginCallback>((resolve, reject) => {
      server = createServer((request, response) => {
        void handleLoginCallback(request, response, state, (server?.address() as { port: number } | null)?.port)
          .then((callback) => {
            if (callback) resolve(callback);
          })
          .catch(reject);
      });
      server.once("error", reject);
      server.listen(0, "localhost", () => {
        const address = server?.address();
        if (!address || typeof address === "string") return reject(new Error("Could not start the local sign-in listener."));
        timeout = setTimeout(() => reject(new Error("Google sign-in timed out.")), 5 * 60 * 1000);
        const loginUrl = new URL(`${AUTH_ORIGIN}/auth`);
        loginUrl.searchParams.set("port", String(address.port));
        loginUrl.searchParams.set("login_session", state);
        openSystemBrowser(loginUrl.toString()).catch(reject);
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
}

async function handleLoginCallback(
  request: IncomingMessage,
  response: ServerResponse,
  expectedState: string,
  expectedPort: number | undefined,
): Promise<LoginCallback | null> {
  if (request.url !== "/complete" || request.headers.origin !== AUTH_ORIGIN || expectedPort === undefined) {
    sendCallbackResponse(response, 403, "Invalid sign-in origin.");
    return null;
  }
  if (request.method === "OPTIONS") {
    sendCallbackResponse(response, 204, "");
    return null;
  }
  if (request.method !== "POST") {
    sendCallbackResponse(response, 405, "Method not allowed.");
    return null;
  }
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    sendCallbackResponse(response, 415, "Invalid sign-in request.");
    return null;
  }
  const body: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 8192) {
      sendCallbackResponse(response, 413, "Sign-in response is too large.");
      return null;
    }
    body.push(buffer);
  }
  let callback: LoginCallback;
  try {
    callback = JSON.parse(Buffer.concat(body).toString("utf8")) as LoginCallback;
  } catch {
    sendCallbackResponse(response, 400, "Invalid sign-in response.");
    return null;
  }
  if (callback.state !== expectedState || callback.port !== expectedPort
    || typeof callback.idToken !== "string" || typeof callback.refreshToken !== "string") {
    sendCallbackResponse(response, 403, "Sign-in session did not match.");
    return null;
  }
  sendCallbackResponse(response, 200, "Sign-in received. Return to the client terminal.");
  return callback;
}

function sendCallbackResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": AUTH_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "300",
    "Vary": "Origin",
  });
  response.end(body);
}

async function openSystemBrowser(url: string): Promise<void> {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
