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

button.addEventListener("click", async () => {
  button.disabled = true;
  message.textContent = "Waiting for Google sign-in…";
  try {
    const configResponse = await fetch("/config", { cache: "no-store" });
    if (!configResponse.ok) throw new Error("Firebase sign-in is not configured.");
    const app = initializeApp(await configResponse.json());
    const auth = getAuth(app);
    await setPersistence(auth, inMemoryPersistence);
    const result = await signInWithPopup(auth, new GoogleAuthProvider());
    const idToken = await result.user.getIdToken();
    const response = await fetch("/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, idToken, refreshToken: result.user.refreshToken }),
    });
    if (!response.ok) throw new Error(await response.text());
    await signOut(auth);
    message.textContent = "Signed in. Return to the client terminal and close this tab.";
    button.hidden = true;
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : "Sign-in failed.";
    button.disabled = false;
  }
});
