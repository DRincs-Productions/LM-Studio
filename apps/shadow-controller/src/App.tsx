import { useState } from "react";
import "./App.css";

type Section = "Overview" | "Jobs" | "Engines" | "Storage" | "Security";

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

          {section === "Overview" ? <Overview /> : <SectionPlaceholder section={section} />}
        </div>
      </section>
    </main>
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
