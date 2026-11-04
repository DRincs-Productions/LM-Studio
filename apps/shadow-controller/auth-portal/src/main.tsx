import React from "react";
import { createRoot } from "react-dom/client";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  inMemoryPersistence,
  setPersistence,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import "./style.css";

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyCO-OtHIxbarCVRGh3qLDeNhUT2ArrngUY",
  authDomain: "shadow-controller-20261103.firebaseapp.com",
  projectId: "shadow-controller-20261103",
  appId: "1:561681360090:web:2af6f0a94083fbd85b31e3",
  messagingSenderId: "561681360090",
};
const params = new URLSearchParams(window.location.search);
const session = params.get("login_session") ?? "";
const portValue = Number(params.get("port"));
const validSession = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(session)
  && Number.isInteger(portValue) && portValue > 0 && portValue <= 65535;
const auth = getAuth(initializeApp(FIREBASE_CONFIG));
const authReady = setPersistence(auth, inMemoryPersistence);

function App() {
  const [credential, setCredential] = React.useState<{ idToken: string; refreshToken: string } | null>(null);
  const [message, setMessage] = React.useState(validSession ? "" : "This sign-in link is invalid or has expired. Return to Shadow Controller and try again.");
  const [busy, setBusy] = React.useState(false);
  const [complete, setComplete] = React.useState(false);
  const [ready, setReady] = React.useState(false);

  React.useEffect(() => {
    authReady.then(() => setReady(true)).catch((error) => setMessage(describeError(error)));
  }, []);

  async function signIn() {
    if (!validSession || !ready) return;
    setBusy(true);
    setMessage("Waiting for Google sign-in…");
    try {
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      const idToken = await result.user.getIdToken();
      if (!result.user.refreshToken) throw new Error("Firebase did not provide a refresh credential.");
      setCredential({ idToken, refreshToken: result.user.refreshToken });
      setMessage("Google sign-in succeeded. Return to the desktop app to complete sign-in.");
      await signOut(auth);
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  async function returnToDesktop() {
    if (!credential || !validSession) return;
    setBusy(true);
    setMessage("Connecting to Shadow Controller… If your browser asks, allow this page to connect to your local app.");
    try {
      const response = await fetch(`http://localhost:${portValue}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: session, port: portValue, ...credential }),
        // Chrome's Local Network Access permission applies to public HTTPS pages calling localhost.
        targetAddressSpace: "loopback",
      } as RequestInit & { targetAddressSpace: "loopback" });
      if (!response.ok) throw new Error(await response.text());
      setComplete(true);
      setCredential(null);
      setMessage("Sign-in complete. You can close this tab and return to Shadow Controller.");
      window.history.replaceState(null, "", "/auth/complete");
    } catch (error) {
      setMessage(`Could not connect to the desktop app. Keep this page open and try again. ${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return <main className="card">
    <div className="eyebrow">SHADOW CONTROLLER</div>
    <h1>Sign in to Shadow Controller</h1>
    <p>Sign in securely with Google, then return your session to the desktop app.</p>
    {!credential && !complete && <button type="button" onClick={signIn} disabled={!validSession || !ready || busy}>
      {busy ? "Waiting for Google…" : ready ? "Continue with Google" : "Preparing secure sign-in…"}
    </button>}
    {credential && !complete && <button type="button" onClick={returnToDesktop} disabled={busy}>
      {busy ? "Connecting…" : "Return to Shadow Controller"}
    </button>}
    <p className="message" role="status" aria-live="polite">{message}</p>
    <p className="privacy">Your sign-in is verified by Firebase and the desktop app. Credentials stay in memory for this sign-in and are not saved in browser storage.</p>
  </main>;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
    const customData = "customData" in error && typeof error.customData === "object" && error.customData !== null
      ? error.customData as Record<string, unknown>
      : {};
    const originalError = customData.originalError;
    const originalMessage = originalError instanceof Error
      ? `${originalError.name}: ${originalError.message}`
      : typeof originalError === "object" && originalError !== null && "message" in originalError
        && typeof originalError.message === "string"
        ? originalError.message
        : typeof originalError === "string" ? originalError : "";
    const detail = sanitizeErrorDetail(originalMessage);
    return `${error.message}${code}${detail ? ` Details: ${detail}` : ""}`;
  }
  return "Sign-in failed. Please try again.";
}

function sanitizeErrorDetail(value: string): string {
  return value
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted API key]")
    .replace(/([?&](?:key|token|access_token|id_token|refresh_token|client_secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted email]")
    .slice(0, 240);
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
