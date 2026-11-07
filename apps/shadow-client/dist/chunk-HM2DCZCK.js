// src/auth.ts
import { Entry } from "@napi-rs/keyring";
import { generateKeyPairSync, randomUUID } from "crypto";
import { hostname } from "os";
import { spawn } from "child_process";
import { createServer } from "http";
var API_KEY = "AIzaSyCO-OtHIxbarCVRGh3qLDeNhUT2ArrngUY";
var PROJECT_ID = "shadow-controller-20261103";
var FIRESTORE_DOCUMENTS_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
var FIRESTORE_DOCUMENTS_RESOURCE = `projects/${PROJECT_ID}/databases/(default)/documents`;
var AUTH_ORIGIN = `https://${PROJECT_ID}.firebaseapp.com`;
var KEYRING_SERVICE = "com.drincs.shadowcontroller.client";
var KEYRING_ACCOUNT = "firebase-session";
function keyringEntry() {
  return new Entry(KEYRING_SERVICE, KEYRING_ACCOUNT);
}
function readCredential() {
  const serialized = keyringEntry().getPassword();
  if (!serialized) return null;
  try {
    const value = JSON.parse(serialized);
    if (!value.uid || !value.clientId || !value.refreshToken || !value.privateKey || !value.publicKey) {
      throw new Error("Missing required credential fields");
    }
    return value;
  } catch {
    throw new Error("The saved client credential is invalid. Remove it from the operating system credential store.");
  }
}
function saveCredential(credential) {
  keyringEntry().setPassword(JSON.stringify(credential));
}
async function login() {
  if (readCredential()) throw new Error("A client account is already signed in. Run `shadow-client logout` first.");
  const callback = await browserLogin();
  const user = await verifyGoogleIdentity(callback.idToken);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const clientId = randomUUID();
  const credential = {
    uid: user.uid,
    email: user.email,
    clientId,
    displayName: hostname().slice(0, 100) || "Shadow client",
    refreshToken: callback.refreshToken,
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    registered: false
  };
  saveCredential(credential);
  return enrollClient();
}
async function enrollClient() {
  let credential = readCredential();
  if (!credential) throw new Error("Sign in first by running `shadow-client login`.");
  const refreshed = await refreshToken(credential.refreshToken);
  if (refreshed.user_id !== credential.uid) throw new Error("Firebase refreshed credentials for a different account.");
  credential = { ...credential, refreshToken: refreshed.refresh_token };
  saveCredential(credential);
  const documentPath = `accounts/${credential.uid}/authorizedClients/${credential.clientId}`;
  const documentUrl = `${FIRESTORE_DOCUMENTS_URL}/${documentPath}`;
  const documentName = `${FIRESTORE_DOCUMENTS_RESOURCE}/${documentPath}`;
  const existing = await fetch(documentUrl, { headers: { Authorization: `Bearer ${refreshed.id_token}` } });
  if (existing.ok) {
    const document = await existing.json();
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
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      writes: [{
        update: {
          name: documentName,
          fields: {
            displayName: { stringValue: credential.displayName },
            publicKey: { stringValue: credential.publicKey }
          }
        },
        currentDocument: { exists: false }
      }]
    })
  });
  if (!registration.ok) throw await firebaseResponseError("Firebase rejected client enrollment", registration);
  credential = { ...credential, registered: true };
  saveCredential(credential);
  return credential;
}
async function firebaseResponseError(context, response) {
  let detail = "";
  try {
    const body = await response.json();
    const status = typeof body.error?.status === "string" ? body.error.status : "";
    const message = typeof body.error?.message === "string" ? body.error.message : "";
    detail = [status, message].filter(Boolean).join(": ");
  } catch {
  }
  return new Error(`${context} (HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}).`);
}
async function logout() {
  const credential = readCredential();
  if (!credential) return;
  const refreshed = await refreshToken(credential.refreshToken);
  if (refreshed.user_id !== credential.uid) throw new Error("Firebase refreshed credentials for a different account.");
  const response = await fetch(`${FIRESTORE_DOCUMENTS_URL}/accounts/${credential.uid}/authorizedClients/${credential.clientId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${refreshed.id_token}` }
  });
  if (!response.ok && response.status !== 404) throw new Error("Firebase could not revoke this client. Its credential remains saved locally.");
  keyringEntry().deletePassword();
}
async function getClientIdToken() {
  const credential = readCredential();
  if (!credential) throw new Error("Sign in first by running `shadow-client login`.");
  if (!credential.registered) throw new Error("Client enrollment is incomplete. Run `shadow-client register`.");
  const refreshed = await refreshToken(credential.refreshToken);
  if (refreshed.user_id !== credential.uid) throw new Error("Firebase refreshed credentials for a different account.");
  saveCredential({ ...credential, refreshToken: refreshed.refresh_token });
  return refreshed.id_token;
}
async function clientStatus() {
  return readCredential();
}
async function refreshToken(refreshToken2) {
  const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken2 })
  });
  if (!response.ok) throw new Error("Firebase sign-in expired or was revoked. Run `shadow-client login` again.");
  return await response.json();
}
async function verifyGoogleIdentity(idToken) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken })
  });
  if (!response.ok) throw new Error("Firebase rejected the Google sign-in.");
  const lookup = await response.json();
  const user = lookup.users?.[0];
  if (!user?.email || !user.emailVerified || !user.providerUserInfo?.some((provider) => provider.providerId === "google.com")) {
    throw new Error("A Google account with a verified email is required.");
  }
  return { uid: user.localId, email: user.email };
}
async function browserLogin() {
  const state = randomUUID();
  let server;
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      server = createServer((request, response) => {
        void handleLoginCallback(request, response, state, server?.address()?.port).then((callback) => {
          if (callback) resolve(callback);
        }).catch(reject);
      });
      server.once("error", reject);
      server.listen(0, "localhost", () => {
        const address = server?.address();
        if (!address || typeof address === "string") return reject(new Error("Could not start the local sign-in listener."));
        timeout = setTimeout(() => reject(new Error("Google sign-in timed out.")), 5 * 60 * 1e3);
        const loginUrl = new URL(`${AUTH_ORIGIN}/auth`);
        loginUrl.searchParams.set("port", String(address.port));
        loginUrl.searchParams.set("login_session", state);
        openSystemBrowser(loginUrl.toString()).catch(reject);
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
  }
}
async function handleLoginCallback(request, response, expectedState, expectedPort) {
  if (request.url !== "/complete" || request.headers.origin !== AUTH_ORIGIN || expectedPort === void 0) {
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
  const body = [];
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
  let callback;
  try {
    callback = JSON.parse(Buffer.concat(body).toString("utf8"));
  } catch {
    sendCallbackResponse(response, 400, "Invalid sign-in response.");
    return null;
  }
  if (callback.state !== expectedState || callback.port !== expectedPort || typeof callback.idToken !== "string" || typeof callback.refreshToken !== "string") {
    sendCallbackResponse(response, 403, "Sign-in session did not match.");
    return null;
  }
  sendCallbackResponse(response, 200, "Sign-in received. Return to the client terminal.");
  return callback;
}
function sendCallbackResponse(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": AUTH_ORIGIN,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "300",
    "Vary": "Origin"
  });
  response.end(body);
}
async function openSystemBrowser(url) {
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export {
  readCredential,
  login,
  enrollClient,
  logout,
  getClientIdToken,
  clientStatus
};
