import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type Section = "Overview" | "Jobs" | "Engines" | "Storage" | "Security";
type Job = { jobId: string; operation: string; state: string; createdAt: string; errorCode?: string | null };

const sections: Section[] = ["Overview", "Jobs", "Engines", "Storage", "Security"];

function App() {
  const [section, setSection] = useState<Section>("Overview");

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
          <div className="connection-dot" />
          <div><strong>Coordinator offline</strong><span>Waiting for server connection</span></div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">Shadow Controller <span>/</span> {section}</div>
          <div className="account-chip"><span className="avatar">S</span><span>Account not signed in</span><span className="chevron">⌄</span></div>
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

          {section === "Overview" ? <Overview /> : section === "Jobs" ? <Jobs /> : <SectionPlaceholder section={section} />}
        </div>
      </section>
    </main>
  );
}

function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
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
          {job.state === "queued" && <button className="text-button" disabled={busy} onClick={() => void cancel(job.jobId)}>Cancel</button>}
        </article>)}</div>
      )}
    </section>
  );
}

function Overview() {
  return (
    <>
      <section className="welcome-card">
        <div className="welcome-copy">
          <div className="welcome-tag"><span /> INITIAL SETUP</div>
          <h2>Your workspace is ready<br />to be connected.</h2>
          <p>Sign in and pair a server to start coordinating your local generation tools.</p>
          <button className="button button-primary" type="button" disabled title="Google sign-in and pairing are not configured yet">
            <span aria-hidden="true">↗</span> Connect an account
          </button>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="planet"><div className="planet-core" /><div className="planet-ring" /></div>
          <span className="star star-one">✦</span><span className="star star-two">·</span><span className="star star-three">✧</span>
        </div>
      </section>

      <div className="section-title-row"><div><h2>System status</h2><p>Live status will appear after pairing.</p></div><span className="status-pill"><i /> NOT CONNECTED</span></div>

      <section className="status-grid" aria-label="System status">
        <StatusCard icon="⌘" label="Coordinator" value="Not connected" detail="The server has not paired with this account." tone="amber" />
        <StatusCard icon="◉" label="Authentication" value="Setup pending" detail="Google sign-in and authorization are not active yet." tone="blue" />
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
            <li className="pending"><span className="step-icon">1</span><div><strong>Sign in with Google</strong><span>Authenticate your account securely</span></div><span className="step-state">PENDING</span></li>
            <li className="pending"><span className="step-icon">2</span><div><strong>Pair your server</strong><span>Connect Shadow to this account</span></div><span className="step-state">PENDING</span></li>
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
