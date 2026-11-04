import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

type Section = "Overview" | "Jobs" | "Engines" | "Storage" | "Security";
type Job = { jobId: string; operation: string; state: string; createdAt: string; errorCode?: string | null };
type JobEvent = { eventId: number; eventType: string; occurredAt: string; messageRedacted?: string | null };
type LocalStatus = { coordinator: string; database: string; databasePath?: string | null };
type AuthIdentity = { uid: string; email: string };
type AuthorizedClient = { id: string; displayName: string };

const sections: Section[] = ["Overview", "Jobs", "Engines", "Storage", "Security"];

function App() {
  const [section, setSection] = useState<Section>("Overview");
  const [coordinatorRunning, setCoordinatorRunning] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Checking local Coordinator");
  const [authIdentity, setAuthIdentity] = useState<AuthIdentity | null>(null);
  const [authPending, setAuthPending] = useState(false);
  const [authMessage, setAuthMessage] = useState("");
  const authCancelRef = useRef<(() => void) | null>(null);
  const [serverId, setServerId] = useState<string | null>(null);
  const [pairingStatus, setPairingStatus] = useState<"unknown" | "paired" | "unpaired">("unknown");
  const [pairingPending, setPairingPending] = useState(false);
  const [pairingMessage, setPairingMessage] = useState("");

  useEffect(() => {
    let active = true;
    const refreshStatus = async () => {
      try {
        const status = await invoke<LocalStatus>("get_local_status");
        if (active) {
          setCoordinatorRunning(status.coordinator === "running");
          setStatusMessage(status.coordinator === "running" ? "Independent process" : "Process is stopped");
        }
      } catch {
        if (active) setStatusMessage("Desktop backend unavailable");
      }
    };
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    void invoke<string>("get_local_server_id").then(setServerId).catch(() => setServerId(null));
  }, []);

  useEffect(() => {
    void invoke<AuthIdentity | null>("get_local_auth_status")
      .then(setAuthIdentity)
      .catch((error) => setAuthMessage(String(error)));
  }, []);

  useEffect(() => {
    if (!authIdentity) {
      setPairingStatus("unpaired");
      setPairingMessage("");
      return;
    }
    if (!serverId) return;
    void invoke<boolean>("get_local_pairing_status")
      .then((paired) => setPairingStatus(paired ? "paired" : "unpaired"))
      .catch((error) => {
        setPairingStatus("unpaired");
        setPairingMessage(String(error));
      });
  }, [authIdentity, serverId]);

  async function signIn() {
    setAuthPending(true);
    setAuthMessage("Complete Google sign-in in your browser.");
    let cancelled = false;
    authCancelRef.current = () => { cancelled = true; };
    try {
      const url = await invoke<string>("begin_local_auth");
      if (cancelled) {
        await invoke("cancel_local_auth");
        setAuthMessage("Sign-in cancelled. You can try again.");
        return;
      }
      await openUrl(url);
      for (let attempt = 0; attempt < 300 && !cancelled; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        const identity = await invoke<AuthIdentity | null>("get_local_auth_status");
        if (identity) {
          setAuthIdentity(identity);
          setAuthMessage("Google sign-in complete.");
          return;
        }
      }
      setAuthMessage(cancelled ? "Sign-in cancelled. You can try again." : "Sign-in timed out. Start again when you are ready.");
    } catch (error) {
      setAuthMessage(String(error));
    } finally {
      authCancelRef.current = null;
      setAuthPending(false);
    }
  }

  function cancelSignIn() {
    authCancelRef.current?.();
    void invoke("cancel_local_auth").catch((error) => setAuthMessage(String(error)));
  }

  async function signOut() {
    try {
      await invoke("sign_out_local_auth");
      setAuthIdentity(null);
      setPairingStatus("unpaired");
      setAuthMessage("Signed out.");
    } catch (error) {
      setAuthMessage(String(error));
    }
  }

  async function pairServer() {
    setPairingPending(true);
    setPairingMessage("");
    try {
      await invoke("pair_local_server");
      setPairingStatus("paired");
      setPairingMessage("This server is now paired with your account.");
    } catch (error) {
      setPairingMessage(String(error));
    } finally {
      setPairingPending(false);
    }
  }

  async function unpairServer() {
    if (!window.confirm("Unpair this server? Clients will no longer be able to route work to it.")) return;
    setPairingPending(true);
    setPairingMessage("");
    try {
      await invoke("unpair_local_server");
      setPairingStatus("unpaired");
      setPairingMessage("Server pairing removed.");
    } catch (error) {
      setPairingMessage(String(error));
    } finally {
      setPairingPending(false);
    }
  }

  async function stopCoordinator() {
    try {
      await invoke("stop_local_coordinator");
      setStatusMessage("Stop requested");
    } catch (error) {
      setStatusMessage(String(error));
    }
  }

  async function startCoordinator() {
    try {
      await invoke("start_local_coordinator");
      setStatusMessage("Start requested");
    } catch (error) {
      setStatusMessage(String(error));
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><span /></div>
          <div>
            <strong>Shadow</strong>
            <span>CONTROLLER</span>
          </div>
        </div>

        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {sections.map((item, index) => (
            <button
              className={`nav-item${section === item ? " active" : ""}`}
              key={item}
              onClick={() => setSection(item)}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true">{["◫", "≡", "⌘", "▧", "◇"][index]}</span>
              {item}
              {item === "Jobs" && <span className="nav-count">—</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className={`connection-dot${coordinatorRunning ? " online" : ""}`} />
          <div className="coordinator-indicator">
            <strong>{coordinatorRunning ? "Coordinator running" : "Coordinator offline"}</strong>
            <span>{statusMessage}</span>
            {coordinatorRunning
              ? <button className="text-button" type="button" onClick={() => void stopCoordinator()}>Stop process</button>
              : <button className="text-button" type="button" onClick={() => void startCoordinator()}>Start process</button>}
          </div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">Shadow Controller <span>/</span> {section}</div>
          <div className="account-chip">
            <span className="avatar">{authIdentity?.email.slice(0, 1).toUpperCase() ?? "S"}</span>
            <span>{authIdentity?.email ?? "Account not signed in"}</span>
            {authIdentity
              ? <button className="text-button" type="button" onClick={() => void signOut()}>Sign out</button>
              : <button className="text-button" type="button" disabled={authPending} onClick={() => void signIn()}>{authPending ? "Waiting…" : "Sign in"}</button>}
          </div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">CONTROL CENTER</div>
              <h1>{section}</h1>
              <p className="subtitle">Manage your generation server and follow its work from one place.</p>
            </div>
            <button className="button button-muted" type="button" disabled title="Available after server pairing is implemented">
              <span aria-hidden="true">＋</span> New request
            </button>
          </div>

          {section === "Overview"
            ? <Overview authIdentity={authIdentity} authPending={authPending} authMessage={authMessage} serverId={serverId} pairingStatus={pairingStatus} pairingPending={pairingPending} pairingMessage={pairingMessage} onSignIn={() => void signIn()} onCancelSignIn={cancelSignIn} onPair={() => void pairServer()} onUnpair={() => void unpairServer()} />
            : section === "Jobs" ? <Jobs />
              : section === "Security" ? <Security identity={authIdentity} pairingStatus={pairingStatus} />
                : <SectionPlaceholder section={section} />}
        </div>
      </section>
    </main>
  );
}

function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [message, setMessage] = useState("Jobs are stored locally on this device. No remote server is connected.");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setBusy(true);
    try {
      const rows = await invoke<Job[]>("list_local_jobs", { clientId: "desktop-ui", limit: 50 });
      setJobs(rows);
      setMessage(`${rows.length} local job${rows.length === 1 ? "" : "s"}. The execution worker is not connected yet.`);
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function addQueueEntry() {
    setBusy(true);
    try {
      await invoke("submit_local_job", {
        job: {
          clientId: "desktop-ui",
          requestId: crypto.randomUUID(),
          operation: "narrative.generate",
          payloadVersion: 1,
          payload: { source: "desktop-queue-placeholder" },
        },
      });
      await refresh();
      setMessage("A local queue entry was saved. It will remain queued until an execution worker is implemented.");
    } catch (error) {
      setMessage(String(error));
      setBusy(false);
    }
  }

  async function cancel(jobId: string) {
    setBusy(true);
    try {
      await invoke("cancel_local_job", { jobId });
      await refresh();
    } catch (error) {
      setMessage(String(error));
      setBusy(false);
    }
  }

  async function toggleEvents(jobId: string) {
    if (selectedJob === jobId) {
      setSelectedJob(null);
      setEvents([]);
      return;
    }
    setSelectedJob(jobId);
    try {
      const history = await invoke<JobEvent[]>("list_local_job_events", {
        clientId: "desktop-ui", jobId, limit: 50,
      });
      setEvents(history);
    } catch (error) {
      setMessage(String(error));
    }
  }

  return (
    <section className="panel-card jobs-panel">
      <div className="card-heading">
        <div><h2>Local queue</h2><p>{message}</p></div>
        <div className="jobs-actions">
          <button type="button" className="button button-muted" disabled={busy} onClick={() => void refresh()}>Refresh</button>
          <button type="button" className="button button-primary" disabled={busy} onClick={() => void addQueueEntry()}>＋ Add queue entry</button>
        </div>
      </div>
      {jobs.length === 0 ? <div className="empty-state"><div className="empty-icon">≡</div><strong>No local jobs</strong><span>Entries created here stay on this device and do not invoke a model.</span></div> : (
        <div className="job-list">{jobs.map((job) => <article className="job-row" key={job.jobId}>
          <div><strong>{job.operation}</strong><span>{job.jobId}</span></div>
          <time>{new Date(job.createdAt).toLocaleString()}</time>
          <span className={`job-state ${job.state}`}>{job.state.replace(/_/g, " ")}</span>
          <div className="job-row-actions">
            <button className="text-button" onClick={() => void toggleEvents(job.jobId)}>{selectedJob === job.jobId ? "Hide" : "Events"}</button>
            {job.state === "queued" && <button className="text-button" disabled={busy} onClick={() => void cancel(job.jobId)}>Cancel</button>}
          </div>
          {selectedJob === job.jobId && <div className="job-events">{events.map((event) => <div key={event.eventId}>
            <time>{new Date(event.occurredAt).toLocaleString()}</time><strong>{event.eventType.replace(/\./g, " · ")}</strong><span>{event.messageRedacted}</span>
          </div>)}</div>}
        </article>)}</div>
      )}
    </section>
  );
}

function Security({ identity, pairingStatus }: { identity: AuthIdentity | null; pairingStatus: "unknown" | "paired" | "unpaired" }) {
  const [clients, setClients] = useState<AuthorizedClient[]>([]);
  const [message, setMessage] = useState("Sign in and pair this server to manage authorized clients.");
  const [busyClient, setBusyClient] = useState<string | null>(null);

  async function refreshClients() {
    try {
      const rows = await invoke<AuthorizedClient[]>("list_local_authorized_clients");
      setClients(rows);
      setMessage(rows.length === 0 ? "No clients are authorized." : `${rows.length} authorized client${rows.length === 1 ? "" : "s"}.`);
    } catch (error) {
      setClients([]);
      setMessage(String(error));
    }
  }

  useEffect(() => {
    if (identity && pairingStatus === "paired") void refreshClients();
    else {
      setClients([]);
      setMessage(identity ? "Pair this server before managing authorized clients." : "Sign in with Google to manage authorized clients.");
    }
  }, [identity, pairingStatus]);

  async function revoke(client: AuthorizedClient) {
    if (!window.confirm(`Revoke access for “${client.displayName}”?`)) return;
    setBusyClient(client.id);
    try {
      await invoke("revoke_local_authorized_client", { clientId: client.id });
      await refreshClients();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusyClient(null);
    }
  }

  return (
    <section className="section-placeholder">
      <div className="placeholder-glyph">◇</div>
      <h2>Security</h2>
      <p>{message}</p>
      {identity && <p>Signed in as {identity.email}</p>}
      {clients.length > 0 && <ul className="setup-list">{clients.map((client) => <li key={client.id}>
        <span className="step-icon">⌘</span><div><strong>{client.displayName}</strong><span>{client.id}</span></div>
        <button className="text-button" type="button" disabled={busyClient === client.id} onClick={() => void revoke(client)}>{busyClient === client.id ? "Revoking…" : "Revoke"}</button>
      </li>)}</ul>}
      <p>Client enrollment will be available when the MCP client is implemented.</p>
    </section>
  );
}

function Overview({ authIdentity, authPending, authMessage, serverId, pairingStatus, pairingPending, pairingMessage, onSignIn, onCancelSignIn, onPair, onUnpair }: {
  authIdentity: AuthIdentity | null;
  authPending: boolean;
  authMessage: string;
  serverId: string | null;
  pairingStatus: "unknown" | "paired" | "unpaired";
  pairingPending: boolean;
  pairingMessage: string;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onPair: () => void;
  onUnpair: () => void;
}) {
  return (
    <>
      <section className="welcome-card">
        <div className="welcome-copy">
          <div className="welcome-tag"><span /> INITIAL SETUP</div>
          <h2>Your workspace is ready<br />to be connected.</h2>
          <p>{authIdentity ? `Signed in as ${authIdentity.email}. ${pairingStatus === "paired" ? "This server is paired to your account." : "Pair this server to your account to continue setup."}` : "Sign in and pair a server to start coordinating your local generation tools."}</p>
          {!authIdentity
            ? authPending
              ? <button className="button button-muted" type="button" onClick={onCancelSignIn}>Cancel sign-in</button>
              : <button className="button button-primary" type="button" onClick={onSignIn}><span aria-hidden="true">↗</span> Sign in with Google</button>
            : pairingStatus === "paired"
              ? <button className="button button-primary" type="button" disabled={pairingPending} onClick={onUnpair}>{pairingPending ? "Updating pairing…" : "Unpair this server"}</button>
              : <button className="button button-primary" type="button" disabled={pairingPending || !serverId || pairingMessage.includes("paired with a different server")} onClick={onPair}><span aria-hidden="true">↗</span> {pairingPending ? "Pairing server…" : "Pair this server"}</button>}
          {authMessage && <p className="auth-message" role="status">{authMessage}</p>}
          {pairingMessage && <p className="auth-message" role="status">{pairingMessage}</p>}
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="planet"><div className="planet-core" /><div className="planet-ring" /></div>
          <span className="star star-one">✦</span><span className="star star-two">·</span><span className="star star-three">✧</span>
        </div>
      </section>

      <div className="section-title-row"><div><h2>System status</h2><p>Live status will appear after pairing.</p></div><span className="status-pill"><i /> NOT CONNECTED</span></div>

      <section className="status-grid" aria-label="System status">
        <StatusCard icon="⌘" label="Server" value={pairingStatus === "paired" ? "Paired" : "Not paired"} detail={serverId ? `ID ${serverId}` : "Server identity unavailable"} tone="amber" />
        <StatusCard icon="◉" label="Authentication" value={authIdentity ? "Signed in" : "Not signed in"} detail={authIdentity ? authIdentity.email : "Google sign-in is ready."} tone="blue" />
        <StatusCard icon="⇄" label="Relay" value="Not deployed" detail="Remote connections stay disabled until security gates pass." tone="violet" />
      </section>

      <section className="bottom-grid">
        <div className="panel-card activity-card">
          <div className="card-heading"><div><h2>Recent activity</h2><p>Events from your paired server</p></div><button type="button" className="text-button" disabled>View all <span>→</span></button></div>
          <div className="empty-state"><div className="empty-icon">⌁</div><strong>No activity to show</strong><span>Pair a server to see jobs and system events here.</span></div>
        </div>
        <div className="panel-card setup-card">
          <div className="card-heading"><div><h2>Getting started</h2><p>Three steps to your workspace</p></div></div>
          <ol className="setup-list">
            <li className={authIdentity ? "complete" : "pending"}><span className="step-icon">1</span><div><strong>Sign in with Google</strong><span>Authenticate your account securely</span></div><span className="step-state">{authIdentity ? "DONE" : "PENDING"}</span></li>
            <li className={pairingStatus === "paired" ? "complete" : "pending"}><span className="step-icon">2</span><div><strong>Pair your server</strong><span>{serverId ? `Server identity: ${serverId}` : "Connect this server to your account"}</span></div><span className="step-state">{pairingStatus === "paired" ? "DONE" : "PENDING"}</span></li>
            <li className="pending"><span className="step-icon">3</span><div><strong>Connect your client</strong><span>Authorize Codex to submit work</span></div><span className="step-state">PENDING</span></li>
          </ol>
        </div>
      </section>
      <footer className="footer-note"><span className="secure-icon">◇</span> Your server and generation tools remain under your control.</footer>
    </>
  );
}

function StatusCard({ icon, label, value, detail, tone }: { icon: string; label: string; value: string; detail: string; tone: string }) {
  return <article className="status-card"><div className={`status-icon ${tone}`}>{icon}</div><div className="status-label">{label}</div><strong>{value}</strong><p>{detail}</p></article>;
}

function SectionPlaceholder({ section }: { section: Section }) {
  const descriptions: Record<Section, string> = {
    Overview: "Workspace overview",
    Jobs: "Submitted generation work and its history will appear here when a Coordinator is connected.",
    Engines: "Configure local generation engines on a paired server.",
    Storage: "Configure the shared asset location and inspect verified transfers.",
    Security: "Manage account, server pairing and authorized clients.",
  };
  return <section className="section-placeholder"><div className="placeholder-glyph">{section === "Jobs" ? "≡" : section === "Engines" ? "⌘" : section === "Storage" ? "▧" : "◇"}</div><h2>{section} will appear here</h2><p>{descriptions[section]}</p><span className="coming-soon">IMPLEMENTATION IN PROGRESS</span></section>;
}

export default App;
