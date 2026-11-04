import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  inMemoryPersistence,
  setPersistence,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js";

const state = new URLSearchParams(window.location.search).get("state");
const button = document.getElementById("sign-in");
const message = document.getElementById("message");
let auth = null;

async function prepareAuth() {
  const configResponse = await fetch("/config", { cache: "no-store" });
  if (!configResponse.ok) throw new Error("Firebase sign-in is not configured.");
  const app = initializeApp(await configResponse.json());
  auth = getAuth(app);
  await setPersistence(auth, inMemoryPersistence);
}

message.textContent = "Preparing secure sign-in…";
button.disabled = true;
prepareAuth().then(() => {
  message.textContent = "";
  button.disabled = false;
}).catch((error) => {
  message.textContent = describeError(error);
});

button.addEventListener("click", async () => {
  if (!auth) return;
  button.disabled = true;
  message.textContent = "Waiting for Google sign-in…";
  try {
    const signIn = signInWithPopup(auth, new GoogleAuthProvider());
    const result = await signIn;
    const idToken = await result.user.getIdToken();
    const response = await fetch("/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, idToken, refreshToken: result.user.refreshToken }),
    });
    if (!response.ok) throw new Error(await response.text());
    await signOut(auth);
    message.textContent = "Signed in. Return to Shadow Controller and close this tab.";
    button.hidden = true;
  } catch (error) {
    message.textContent = describeError(error);
    button.disabled = false;
  }
});

function describeError(error) {
  if (!(error instanceof Error)) return "Sign-in failed.";
  const code = typeof error.code === "string" ? ` (${error.code})` : "";
  const original = error.customData?.originalError;
  const detail = original instanceof Error ? original.message : "";
  const safeDetail = detail.replace(/([?&](?:key|token|access_token|id_token)=)[^&\s]+/gi, "$1[redacted]").slice(0, 300);
  return `${error.message}${code}${safeDetail ? ` Details: ${safeDetail}` : ""}`;
}
