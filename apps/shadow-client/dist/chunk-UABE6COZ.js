// src/auth.ts
import { Entry } from "@napi-rs/keyring";
import { generateKeyPairSync, randomUUID } from "crypto";
import { hostname } from "os";
import { spawn } from "child_process";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
var API_KEY = "AIzaSyCO-OtHIxbarCVRGh3qLDeNhUT2ArrngUY";
var PROJECT_ID = "shadow-controller-20261103";
var FIRESTORE_DOCUMENTS_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
var KEYRING_SERVICE = "com.drincs.shadowcontroller.client";
var KEYRING_ACCOUNT = "firebase-session";
var ASSET_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "../assets");
var AUTH_PAGE = await readFile(join(ASSET_DIRECTORY, "auth-browser.html"), "utf8");
var AUTH_SCRIPT = await readFile(join(ASSET_DIRECTORY, "auth-browser.js"), "utf8");
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
  const documentUrl = `${FIRESTORE_DOCUMENTS_URL}/accounts/${credential.uid}/authorizedClients/${credential.clientId}`;
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
          name: documentUrl,
          fields: {
            displayName: { stringValue: credential.displayName },
            publicKey: { stringValue: credential.publicKey }
          }
        },
        currentDocument: { exists: false }
      }]
    })
  });
  if (!registration.ok) throw new Error("Firebase rejected client enrollment. Check the Firestore database and security rules.");
  credential = { ...credential, registered: true };
  saveCredential(credential);
  return credential;
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
  const firebaseConfig = {
    apiKey: API_KEY,
    authDomain: "shadow-controller-20261103.firebaseapp.com",
    projectId: PROJECT_ID,
    appId: "1:561681360090:web:2af6f0a94083fbd85b31e3",
    messagingSenderId: "561681360090"
  };
  let server;
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      server = createServer((request, response) => {
        void handleAuthRequest(request, response, {
          state,
          pageUrl: AUTH_PAGE,
          script: AUTH_SCRIPT,
          firebaseConfig,
          origin: `http://localhost:${(server?.address()).port}`
        }).then((callback) => {
          if (callback) resolve(callback);
        }).catch(reject);
      });
      server.once("error", reject);
      server.listen(0, "localhost", () => {
        const address = server?.address();
        if (!address || typeof address === "string") return reject(new Error("Could not start the local sign-in listener."));
        timeout = setTimeout(() => reject(new Error("Google sign-in timed out.")), 5 * 60 * 1e3);
        openSystemBrowser(`http://localhost:${address.port}/auth?state=${state}`).catch(reject);
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
  }
}
async function handleAuthRequest(request, response, context) {
  const requestUrl = new URL(request.url ?? "/", context.origin);
  if (request.method === "GET" && requestUrl.pathname === "/auth" && requestUrl.searchParams.get("state") === context.state) {
    sendText(response, 200, context.pageUrl, "text/html; charset=utf-8");
    return null;
  }
  if (request.method === "GET" && requestUrl.pathname === "/auth-browser.js") {
    sendText(response, 200, context.script, "text/javascript; charset=utf-8");
    return null;
  }
  if (request.method === "GET" && requestUrl.pathname === "/config") {
    sendText(response, 200, JSON.stringify(context.firebaseConfig), "application/json");
    return null;
  }
  if (request.method !== "POST" || requestUrl.pathname !== "/complete") {
    sendText(response, 404, "Not found.", "text/plain; charset=utf-8");
    return null;
  }
  if (request.headers.origin !== context.origin) {
    sendText(response, 403, "Invalid sign-in origin.", "text/plain; charset=utf-8");
    return null;
  }
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    sendText(response, 415, "Invalid sign-in request.", "text/plain; charset=utf-8");
    return null;
  }
  const body = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 8192) {
      sendText(response, 413, "Sign-in response is too large.", "text/plain; charset=utf-8");
      return null;
    }
    body.push(buffer);
  }
  let callback;
  try {
    callback = JSON.parse(Buffer.concat(body).toString("utf8"));
  } catch {
    sendText(response, 400, "Invalid sign-in response.", "text/plain; charset=utf-8");
    return null;
  }
  if (callback.state !== context.state || typeof callback.idToken !== "string" || typeof callback.refreshToken !== "string") {
    sendText(response, 403, "Sign-in state did not match.", "text/plain; charset=utf-8");
    return null;
  }
  sendText(response, 200, "Sign-in received. Return to the client terminal.", "text/plain; charset=utf-8");
  return callback;
}
function sendText(response, status, body, contentType) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'self' https://www.gstatic.com; style-src 'unsafe-inline'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com; frame-src https://*.firebaseapp.com https://accounts.google.com https://*.google.com; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  });
  response.end(body);
}
async function openSystemBrowser(url) {
  const command = process.platform === "win32" ? "cmd.exe" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
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
  login,
  enrollClient,
  logout,
  getClientIdToken,
  clientStatus
};
