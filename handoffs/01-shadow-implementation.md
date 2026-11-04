# Handoff 01 — Implementazione server Tauri/React, Firebase e Coordinatore Rust su Shadow

**Stato:** specifica consolidata, da implementare e verificare. **Responsabile:** Codex sul PC di sviluppo Shadow. **Prima attività obbligatoria:** verificare e configurare Firebase nel rispetto dei piani gratuiti, prima di abilitare qualsiasi comunicazione remota. Questo documento sostituisce le precedenti ipotesi sullo Shadow Controller e sull'automazione del launcher.

## Obiettivo e fonti di verità

Realizzare un'estensione **generale** delle capacità generative di Codex: l'utente conversa esclusivamente con Codex CLI sul PC fisico; un client MCP Node.js/TypeScript invia richieste al **Coordinatore Rust persistente** su Shadow (o altro host) attraverso un relay Cloudflare WebSocket; il Coordinatore esegue e monitora i job tramite LM Studio, CLI e generatori locali. La GUI **Tauri + React** serve a configurare e monitorare il server, non è il motore della coda.

- **README.md** del branch corrente è la fonte di verità per ruoli e flussi di **Scrittore, Disegnatore e Progettista sonoro**, modelli operativi, installazione e gestione asset. Leggerlo prima di implementare gli adapter e non ricopiare diagrammi obsoleti.
- **AGENTS.md** contiene procedure storiche di test, alcune ancora riferite a Regia/Bionic/Programmatore: non reinterpretarle come architettura obiettivo e **non modificarlo senza autorizzazione esplicita**.
- Gli handoff [04](04-image-generator-and-reviewer-evaluation.md), [05](05-image-postprocessing.md) e [06](06-audio-review-gemini-evaluation.md) descrivono **valutazioni future**, non sostituzioni già approvate. Il confronto di modelli narrativi resta separato nell'handoff 03.
- **Handoff 02** riguarda la validazione dal PC fisico; il suo testo storico sul launcher Shadow non prevale su questo handoff e dovrà essere aggiornato prima di eseguirlo.

## Decisioni definitive (confermate dall'utente)

| Ambito | Decisione |
|---|---|
| Scaffolding | Avviare il progetto con **`npm create tauri-app@latest`**, scegliendo **React** (frontend) e **Rust** (backend Tauri); fissare versioni e comandi realmente usati. |
| Server | Applicazione Tauri multipiattaforma con **Coordinatore Rust persistente**, indipendente dalla finestra GUI; avvio automatico **dopo il login dell'utente** (su Shadow inizialmente Windows). Non avviare il servizio prima di avere la sessione utente necessaria alle eventuali GUI dei motori. |
| Client | Codex CLI + MCP Node.js/TypeScript, compilato con **tsup**, eseguito da sorgente sul PC di sviluppo; distribuzione npm prevista per il client fisico. Node.js e Codex CLI presenti su entrambi i lati dove richiesto. |
| Identità | **Firebase Authentication con Google**, **un server associato a ogni account**, più client autorizzati; **prima fase di lavoro**, non posticipata. Firebase non sostituisce SQLite. |
| Rete | **Cloudflare Workers Free + Durable Object + WebSocket (WSS)**. Shadow apre la connessione **in uscita**; niente porte in ingresso o automazione del launcher Shadow. |
| Protocollo | **Messaggi JSON applicativi versionati sopra WebSocket**; MCP rimane l'interfaccia locale tra Codex e il client Node.js. Non incapsulare automaticamente tutto MCP nel relay. |
| Server offline | **Rifiutare subito le nuove richieste** con errore strutturato e recuperabile; **nessuna mailbox offline** e nessuna promessa di consegna differita. |
| Retry | **Solo manuali**, richiesti esplicitamente da Codex/utente; mai rigenerare automaticamente dopo errore, timeout o riavvio. Riconnessione di trasporto e risincronizzazione dello stato non sono retry di un job. |
| Scheduling | **FIFO**, senza livelli di priorità. Serializzare i job di generazione inizialmente; eventuale parallelismo solo se preserva l'ordine di ammissione e i limiti delle risorse. |
| Database | **SQLite locale al Coordinatore**, fonte autorevole di richieste, job, eventi, tentativi, errori e asset; non usare Cloudflare o OneDrive come coda di esecuzione. |
| File | **rclone CLI** installato e configurato su client e server; **non usare rclone-sdk né rclone RC**. Provider configurabile, cartella condivisa accessibile a entrambe le macchine, anche con nomi di remote differenti. |
| Costi | **Solo servizi e piani gratuiti**: niente upgrade automatici, servizi che richiedono pagamento, abilitazione di billing o carta di credito senza confronto preventivo con l'utente. Se una funzione gratuita non è disponibile, fermarsi e chiedere. |
| Distribution | Dedicated tag-triggered GitHub Actions workflows: `lib-v<version>` publishes the MCP npm package; `server-v<version>` publishes Tauri installers in a GitHub Release; `relay-v<version>` deploys only the relay after F1/F4 pass. Independent component versions; Codex may create as many releases/prereleases as needed under the procedure in `AGENTS.md`. |
| Server updates | The installable server checks the public GitHub Releases feed at startup. If a newer applicable server release exists, it automatically downloads and installs that version. It must not request elevation or install anything when no update exists. Ask for administrator permission only when the selected installer genuinely requires it. Verify release signatures and integrity before installation, and retain rollback/recovery. |
| Ruoli obsoleti | **Regia, Bionic come interfaccia, Programmatore e automazione UI del launcher Shadow non fanno parte dell'architettura obiettivo**. Non cancellare software/modelli/file storici senza inventario e autorizzazione. |

## Regola vincolante per Codex: chiedere chiarimenti

**Codex deve fermarsi e fare una domanda concreta all'utente**, senza scegliere arbitrariamente, quando:
- la configurazione Firebase/Cloudflare richiede billing, carta di credito, una risorsa non disponibile nel piano Free o una quota non verificabile;
- manca un dato di sicurezza o autorizzazione (progetto Firebase, credenziali, pairing, revoca, redirect OAuth, permessi del plugin, accesso al remote);
- una scelta di protocollo, schema, distribuzione o recupero modifica i comportamenti approvati;
- un'operazione potrebbe eliminare file, disinstallare software, sovrascrivere configurazioni, esporre un endpoint o alterare altri Worker Cloudflare;
- un test fallisce o non può essere verificato nell'ambiente reale.

Non inventare valori, non considerare un test superato senza evidenze e non aggirare i blocchi. Presentare **problema, alternative compatibili con Free, raccomandazione e conseguenze**; attendere risposta prima di procedere su decisioni sostanziali. Operazioni non distruttive già specificate possono proseguire autonomamente.

## Fase 1 — Firebase: identità e associazione (prima di tutto)

**Implementation status (2026-11-04):** Firebase project `shadow-controller-20261103` is active without billing, with the `Shadow Controller Desktop` web app registered and Google Sign-In enabled. The desktop implements system-browser authentication, OS credential storage, a persistent server identity, and create-only account-to-server pairing with owner-controlled unpairing. The Security screen can list and revoke authorized clients. A Node client package now supports system-browser sign-in, OS credential storage, Ed25519 client identity creation, Firestore enrollment and local logout/revocation. The Standard Firestore database is in the user-approved `europe-west3` region, has deletion protection enabled, and has restrictive Firestore rules deployed. Google sign-in and server pairing were verified in the Windows desktop with CI debug build `83cd768` (run `41848759899`). The first pairing attempt exposed an incorrect REST document resource path; after changing it to `projects/.../documents/...`, the server paired successfully and the UI confirmed the paired state. Relay-side JWT and account/server/client authorization and security verification remain open. The relay remains closed.

1. **Verificare** tramite documentazione ufficiale e strumenti disponibili i requisiti e i limiti attuali dei piani gratuiti di **Firebase Authentication (Google)**, eventuale **Firestore** per l'associazione account/server, e **Cloudflare Workers/DO**. Distinguere piano gratuito da servizio che richiede comunque billing; non presumere che Firestore, Google login, Durable Objects o quote siano disponibili senza verifica.
2. Sul PC di sviluppo **usare il plugin Firebase per Codex se presente e collegato**. Se non è disponibile, chiedere all'utente di collegarlo oppure concordare il percorso alternativo; non dichiarare che il plugin è già attivo. Richiedere il progetto/account da usare e le autorizzazioni necessarie.
3. Progettare e implementare **Google sign-in**, identificativo utente stabile, associazione transazionale **1 uid → 1 server**, più client autorizzati, sostituzione/revoca del server, autorizzazione per ogni comando e isolamento tra utenti. Non usare il nome del remote rclone come identità.
4. Definire un flusso utilizzabile da **Codex CLI/headless** (browser/device pairing o altro supportato concretamente), rinnovo dei token, credenziali server custodite nel keychain/credential store del sistema, gestione revoche e scadenze. **Non salvare refresh token o segreti nel repository, SQLite in chiaro o log**.
5. Verificare lato ingresso firme JWT, issuer, audience, expiry, uid e associazione server/client; una firma valida da sola non autorizza il comando. Il server verifica ulteriormente le autorizzazioni. Sessioni scadute impediscono nuovi comandi ma non terminano job già avviati.
6. Realizzare test per login, pairing unico, client multipli, revoca, token scaduti/contraffatti e rifiuto di richieste non autenticate. **Fail closed** finché l'integrazione non è verificata.

**Gate F1:** niente deploy del relay operativo o apertura di comandi remoti prima di autenticazione/autorizzazione testate. Se il piano Free non consente il progetto proposto, **chiedere all'utente** un'alternativa gratuita: non passare silenziosamente a un piano a pagamento. È lecito predisporre struttura e test locali senza esporre servizi.

## Fase 2 — Struttura Tauri + React e lifecycle

**Automatic server updates:** The installable server checks public GitHub Releases at startup and compares the newest applicable `server-v<version>` release against its installed version. It installs only when a newer release exists. No update means no download, installer launch, elevation prompt, or interruption to startup. Request administrator permission only after confirming an update exists and only when the selected installer actually requires elevation. Validate signed update metadata and artifacts before installation, retain a recoverable previous version, and report check/download/install failures without preventing normal startup. Select and document the stable/prerelease channel and verify per-platform installer and permission behavior before enabling this feature. Do not treat this requirement as implemented until these checks pass.

**Implementation status (2026-11-03):** The React + Tauri v2 shell was scaffolded at `apps/shadow-controller` with `npm create tauri-app@latest -- apps/shadow-controller --manager npm --template react-ts --identifier com.drincs.shadowcontroller --yes`. The frontend production build passes. A separate headless Coordinator mode now uses a single-instance lock, token-matched stop request and Windows login-autostart registration; the GUI starts it and reports its state. The process opens the persistent SQLite store and performs restart recovery, but does not dispatch production jobs yet. The desktop has a system-browser Firebase sign-in and account/server-pairing flow with OS credential-store integration; live sign-in and pairing have not been verified. CI compiles the Windows Tauri application and runs runtime lock/stop unit tests. Rust is not installed on this development machine, so native startup, GUI-close survival, login autostart, controlled stop and sign-in remain unverified on a real Windows session. Firebase server pairing is configured but not interactively verified; remote access remains closed.


- The initial **React + Rust Tauri scaffold is complete** at `apps/shadow-controller`; use that existing app and preserve its package identity. Record actual toolchain versions and scaffold output in implementation notes. Keep a maintainable split between the React GUI, Tauri commands, standalone Rust Coordinator/core, engine adapters, database module and separate TypeScript MCP client. Do not force unverified directory names or merge process responsibilities.
- Separare **processo persistente** del Coordinatore e **finestra Tauri**: chiudere la finestra non deve interrompere i job; la GUI deve potersi riconnettere e mostrare stato, login/pairing, coda, errori e log redatti. Definire e testare single-instance, arresto controllato e riavvio.
- Avvio automatico **dopo login Windows**, con meccanismo compatibile con la sessione utente; progettare equivalenti Linux/macOS solo dopo verifica. Non assumere che un servizio Windows in sessione 0 possa usare GUI dei motori.
- Non terminare processi non posseduti. LM Studio è on-demand; rilevare disponibilità reale del modello/endpoint e i vincoli GPU/VRAM. CLI esterne avviate con argomenti validati, timeout, directory controllate e log senza segreti.
- Build/installer su CI; la release non richiede toolchain Rust, Wrangler o Tauri SDK all'utente finale.
- Installed server update flow: check public GitHub Releases at startup, compare the latest applicable `server-v<version>` with the installed version, and download/install only when a newer update exists. Do not prompt for administrator permission before confirming an update exists; request elevation only if the selected installer requires it. Require signed update metadata/artifacts, verify integrity before applying, preserve recovery to the previous version, and allow normal startup if the update check fails. Define stable/prerelease selection and verify each platform's installer/elevation behavior before release.

**Gate F2:** build Tauri/React, avvio/arresto GUI indipendente dal Coordinatore, login Windows e ripartenza verificati sul sistema disponibile; gli altri OS restano esplicitamente non verificati finché testati.

## Fase 3 — SQLite, contratto dei job e scheduler FIFO

**Implementation status (2026-11-03):** The SQLite schema, idempotent acceptance, state transitions, restart interruption handling and atomic FIFO claim (maximum one active job) are implemented in `apps/shadow-controller/coordinator`. A one-shot `run_next` hook accepts a host-provided executor and records success/failure/cancellation and result manifests; tests use controlled in-memory executors only. The separate Windows process now opens this store and runs restart recovery, but does not yet consume queued jobs. GitHub Actions passes core/runtime unit tests and Windows Tauri `cargo check`. Production executors, timeout, resource gating, cancellation from a real process, artifact persistence and explicit retry remain open.

Implementare uno **schema migrabile** (versioni di schema e migrazioni testate) con almeno:

| Entità | Campi/relazioni minimi |
|---|---|
| `requests` | `request_id` fornito dal client e univoco nell'ambito del client/account, `uid`, `client_id`, `operation`, `payload_version`, `payload_hash`, `created_at`, `job_id` univoco |
| `jobs` | `job_id` generato dal server, `request_id`, `state`, `fifo_sequence` monotona, `engine`, `created_at`, `started_at`, `finished_at`, `timeout_at`, `error_code`, `result_manifest` |
| `job_events` | id evento monotono, `job_id`, timestamp UTC, tipo, stato precedente/nuovo, messaggio redatto |
| `job_attempts` | `job_id`, numero tentativo, causa/approvazione esplicita, timestamp, esito e riferimenti a processi/output |
| `artifacts` | `artifact_id`, `job_id`, percorso relativo normalizzato, dimensione, SHA-256, percorso cache e stato di trasferimento |

**Stati canonici proposti per la prima implementazione:** `queued`, `running`, `succeeded`, `failed`, `cancel_requested`, `cancelled`, `interrupted`. Definire transizioni valide in codice e testarle: `queued → running → succeeded/failed`; annullamento da `queued` o `running` con esito verificato; dopo crash un `running` non verificabile diventa **`interrupted`**, non viene riavviato automaticamente.

**Idempotenza:** stessa coppia `client_id/request_id` con payload identico restituisce lo **stesso job** e risultato; payload diverso con stessa chiave → errore `idempotency_conflict`. Assegnazione ID e inserimento atomici. La ri-trasmissione del messaggio di submit dopo disconnessione **non è un nuovo tentativo di generazione**.

**FIFO:** `fifo_sequence` assegnata in transazione all'accettazione, esecuzione in ordine; inizialmente un job attivo alla volta. Job non eseguibile per risorse insufficienti resta in attesa con diagnostica, senza sorpassi automatici; annullamento manuale o decisione dell'utente se blocca la coda. Nessun campo di priorità operativa, aging o scheduler a classi.

**Retry manuale:** un fallimento resta visibile. Una nuova esecuzione richiede comando esplicito, verifica degli output già prodotti e registrazione di nuovo tentativo/nuovo job secondo contratto documentato. **Nessun retry automatico** per errori di rete, motore, timeout, riavvio o risorse. In caso di stato incerto chiedere all'utente prima di rigenerare.

**Gate F3:** test transazioni, doppio submit, concorrenza, ordine FIFO, crash/restart, annullamento, timeout, integrità DB, manifest e retry esplicito.

## Fase 4 — Cloudflare Worker + Durable Object WSS

**Implementation status (2026-11-04):** `apps/shadow-relay` contains a fail-closed Worker and SQLite-backed Durable Object. The Worker verifies Firebase Google identities and checks the current account/server pairing as well as the authorized-client Firestore record before routing by UID. Client sockets prove possession of their enrolled Ed25519 key; each request is routed only to the currently associated server identity. Correlated server replies are forwarded only to the originating authorized client connection and must match its account and client identity. The Durable Object uses the WebSocket Hibernation API, caps frame size and pending requests, allows only the documented message types, rejects offline servers immediately and does not queue work. `npm run build` and `wrangler deploy --dry-run` pass locally. The Tauri Coordinator contains an outbound WSS supervisor with keychain-backed Firebase credentials, heartbeat, bounded reconnect backoff and SQLite handlers for remote submit/status/list/cancel. Windows Tauri `cargo check` and debug executable builds passed in GitHub Actions for commits `f5db94c` and `4363a44` (run `41797439330`). Remote submissions persist in `queued` state only; production execution, manual retry and asset handlers remain unavailable. The relay is not deployed, and live authentication, isolation and security checks remain unverified. Keep `RELAY_STATE=setup`; do not deploy until F1/F4 gates pass.

- Usare il Worker **`shadow-mcp-relay`** già creato come target; il bootstrap esistente espone solo `GET /health` in stato setup e risponde 503 altrove. **Non è un relay operativo**. Non toccare gli altri Worker dell'account.
- Versionare in repository Worker, Durable Object, configurazione Wrangler, migrazioni e test. Il server Shadow apre **WSS in uscita**, si autentica, mantiene heartbeat e si riconnette con backoff. Il client si autentica separatamente; il relay inoltra solo al server associato e online.
- **Nessuna coda offline nel Durable Object**: se il server non è online/autorizzato, `server_offline` immediato. Se cade durante l'esecuzione, non ripetere automaticamente il job; client consulta lo stato tramite `requestId` alla riconnessione.
- Usare WebSocket Hibernation quando applicabile e **verificare** costi, limiti, durata, billing e comportamento effettivo del piano Free. Proteggere da replay, flooding, payload eccessivi, socket zombie e messaggi di altri utenti.
- CI: development branch pushes and pull requests run lint/typecheck/test/build **without deployment**. A pushed `relay-v<version>` tag selects the dedicated relay deployment workflow, using least-privilege GitHub Secrets. Deployment remains fail-closed until F1 and F4 pass. The tag is the release trigger; `workflow_dispatch` is not the primary release mechanism. See the release procedure and standing release authorization in `AGENTS.md`.

**Gate F4:** connessione autenticata, server offline rifiutato, reconnect, richiesta duplicata, isolamento utenti, test di sicurezza e prova su Worker/DO realmente disponibili nel piano Free.

## Contratto applicativo JSON v1 sopra WebSocket

Il **client MCP** espone a Codex operazioni di submit, status, list, cancel, richiesta di retry manuale, elenco e recupero asset. La forma finale dei nomi dei tool e dei payload deve essere definita e testata prima di pubblicare la libreria.

**Envelope v1 minimo** (esempio illustrativo, non una risposta di produzione):

```json
{
  "version": 1,
  "type": "job.submit",
  "messageId": "uuid",
  "requestId": "stable-client-request-id",
  "clientId": "paired-client-id",
  "payload": {
    "operation": "image.generate",
    "params": {}
  }
}
```

- Il server assegna `jobId` e restituisce `job.accepted` con `requestId`, `jobId`, `state`; eventi successivi `job.progress`, `job.completed`, `job.failed`, `job.cancelled`. `job.status` e `job.list` interrogano **SQLite**, non lo stato effimero del socket.
- Ogni messaggio contiene `version`, `type`, `messageId` e identificatori pertinenti; errori strutturati con `code`, `message` non sensibile, `retryable` inteso come **possibilità di richiesta manuale**, non retry automatico. Codici minimi: `unauthorized`, `forbidden`, `server_offline`, `invalid_payload`, `unsupported_version`, `idempotency_conflict`, `job_not_found`, `job_not_cancellable`, `resource_unavailable`, `artifact_unavailable`, `internal_error`.
- Stabilire dimensione massima dei messaggi, validazione schema, heartbeat, scadenza delle richieste, correlazione `messageId`, ordine degli eventi e riconnessione; **chiedere all'utente** se una scelta modifica semantica o affidabilità approvate.
- Il relay non riceve file binari grandi; invia solo metadati, riferimenti e manifest. Il server non esegue comandi shell arbitrari ricevuti via MCP; usa operazioni allowlist con parametri validati.
- Una disconnessione dopo submit può rendere ignota la risposta: interrogare per `requestId` prima di proporre una nuova generazione. Non considerare `server_offline` una conferma di annullamento di un job già accettato.

## Fase 5 — Client MCP e integrazione Codex

**Implementation status (2026-11-04):** `apps/shadow-client` contains a Node.js MCP stdio server with Google sign-in, secure local credentials, Firestore client enrollment/revocation, an authenticated WebSocket relay client and tools for submit/status/list/cancel/manual retry/asset metadata. The client and relay compile and package locally. The Coordinator has an outbound WebSocket adapter and request handlers for queue submit/status/list/cancel; retry and asset operations still return explicit unavailable errors. Windows Tauri `cargo check` and debug executable builds pass in GitHub Actions. Relay deployment, live authentication and package publication have not been verified.

- Node.js/TypeScript, MCP SDK ufficiale, **stdio** verso Codex, build con **tsup** e export npm verificati. Registrazione da sorgente sul PC Shadow durante lo sviluppo; il PC fisico potrà usare il pacchetto pubblicato solo dopo test e approvazione.
- Login Google/associazione client coerenti con F1; endpoint e remote rclone configurabili senza segreti nel codice. Tool per submit/status/list/cancel/manual retry/asset; errori diagnostici comprensibili a Codex.
- Test con client multipli e riavvio Codex: `requestId` stabile, recupero job tramite `requestId` o `jobId`, nessuna doppia esecuzione. L'interfaccia resta generale, non legata a Project File o gioco.
- Codex deve riferire chiaramente quando Shadow è offline e **chiedere se ritentare**, senza inviare automaticamente richieste appena torna online.

**Gate F5:** smoke test MCP stdio, package exports, connessione autenticata, offline immediato, stato dopo riavvio client, cancellazione e retry solo esplicito.

## Fase 6 — Adapter di produzione e file

Seguire **il README corrente** come riferimento per la logica di produzione:
- **Scrittore:** Planner Codex e proposta parallela Gemini → merge `SceneContract` Codex → **Hemmingway 1 Abliterated Extreme** → **Qwen3 8B** reviewer narrativo (massimo tre cicli di revisione) → controllo finale Codex → Coordinatore. Gemini reviewer è solo un confronto futuro, non un cambio approvato.
- **Disegnatore:** Coordinatore seleziona stile/contenuto; **`sd-cli.exe`** con **Krea2 Turbo** (standard non anime), **Krea2 Anime v2.0** (anime anche adulto), **RedCraft v3.0** (adulto non anime). **Codex** revisiona, poi restituisce il risultato al Coordinatore; rclone non è una fase del Disegnatore. **InvokeAI**, reviewer Gemini e post-produzione sono sperimentazioni separate negli handoff 04/05.
- **Progettista sonoro:** **audio.cpp v0.9.0 Vulkan**, **Stable Audio 3 Medium Q8** (musica) e **Stable Audio 3 Small SFX Q8** (SFX); controllo tecnico, anteprima loop se pertinente, ascolto **Qwen2.5 Omni 7B** e valutazione finale **Codex**; soglia e limite tentativi come nel README. Gemini reviewer audio è una valutazione dell'handoff 06, non operativo.
- **Responsabilità trasversali:** il Coordinatore possiede job, scheduling, disponibilità GPU/VRAM, recupero asset approvati, manifest, trasferimento rclone e stato; i generatori **non pubblicano direttamente**. Gli eventuali cicli interni di correzione previsti dal README sono **fasi dello stesso job**, non retry automatici di job falliti; registrarli esplicitamente e non ripartire da zero dopo crash.
- Codex CLI and Gemini CLI on the server where configured; use the user's connected Gemini CLI account with model selection set to Auto (`gemini --model auto` if needed). Do not request an API key, pin a specific model or incur API charges unless the user changes this preference. Gemini online may have limits or refusals and must not be assumed permanently available. Do not change the production generators or reviewers without testing and the user's decision.

**File tramite rclone CLI:** installare e configurare separatamente su entrambi i PC, verificare `rclone version`, `rclone config`, `rclone listremotes`. Usare la stessa cartella condivisa dell'app su OneDrive o altro backend supportato; nomi remote locali diversi sono ammessi. Niente rclone-sdk, daemon RC o sincronizzazione indiscriminata. Trasferimenti espliciti, manifest con SHA-256, verifica download. Pulizia all'avvio dei **soli file app-owned più vecchi di 7 giorni**, e recupero di spazio prima di upload fino a **dimensione richiesta + 500 MiB** liberi, solo entro la cartella temporanea dell'app; se non possibile, errore sicuro. Cache server per ripubblicare se il file remoto è sparito; se manca anche la copia locale, `artifact_unavailable`. Nessuna cancellazione di file estranei.

**Gate F6:** test di ogni adapter, evidenze modello/output/review, hash asset, recupero file, limiti di spazio e pulizia confinata; nessuna affermazione di integrazione end-to-end prima di prova reale.

## Fase 7 — CI, installer, validazione e consegna

1. GitHub Actions tag workflows now exist as `.github/workflows/release-lib.yml`, `release-server.yml` and `release-relay.yml`. Each workflow filters its own tag prefix and checks that the tag version matches the relevant manifests. The library uses npm `next` for prereleases and `latest` for stable versions; the server workflow builds Windows, Linux and macOS installers and creates a GitHub Release. The installable server must check public GitHub Releases on startup and install a newer applicable release only after verifying its signed metadata and artifacts; request administrator elevation only when required by the actual installer. No-update startup must not prompt for elevation. Preserve recovery to the previous working version and keep normal startup available if the update check fails. Define stable/prerelease selection and validate platform behavior before enabling automatic updates. The relay workflow requires `RELAY_RELEASE_ENABLED=true` and Cloudflare credentials, and deploys with `RELAY_STATE=active`; do not enable this gate until F1/F4 pass. Add `NPM_TOKEN`, `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets before their first corresponding releases. Follow `AGENTS.md` for versioning, explicit tag pushes, connected `@github` CI inspection and verification of actual published outputs. Never store tokens in source.
2. Workflow Cloudflare separato, deploy manuale controllato fino ad autorizzazione; test reali Workers Free/DO, autenticazione e isolamento.
3. Verifica end-to-end **su Shadow**: Firebase Google login e pairing, server auto-start, WSS, job FIFO, LM Studio e almeno un adapter reale, SQLite dopo crash, errore offline, retry solo manuale, trasferimento rclone con hash. Registrare i limiti e i costi osservati (nessuna promessa di quota gratuita non verificata).
4. Preparare **handoff 02** per i test dal PC fisico, aggiornandone prima i riferimenti obsoleti al launcher Shadow/LM Link. Non dichiarare test distribuiti completati nella fase 1.

**Criteri di uscita:** per ogni gate F1–F6 registrare commit SHA, versioni, comandi esatti, test superati/falliti, log redatti, limitazioni, decisioni richieste all'utente e prossimi passi. **Non eliminare programmi, modelli, profili o configurazioni esistenti senza inventario delle dipendenze e approvazione esplicita.** Non modificare AGENTS.md senza richiesta esplicita.

## Non obiettivi e note di migrazione

Non realizzare un controller per avviare o cliccare la GUI del launcher Shadow, né un relay Codex→Regia/Bionic, né un Programmatore dedicato. Non usare LM Link come trasporto primario, non rendere opzionale il server persistente, non installare rclone-sdk, non aggiungere una mailbox offline o retry automatici, non introdurre priorità nella coda. Le precedenti ipotesi sono **superate** da questo documento. Le informazioni storiche sui test rimangono nei rapporti esistenti, non costituiscono requisiti nuovi.
