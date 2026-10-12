# Risultati: Writer, prompt narrativo e confronto modelli

Data: 4 ottobre 2026
Ambiente: PC Windows dell’utente, LM Studio CLI; nessuna interazione con la GUI.

Questo rapporto conserva i risultati dei test isolati svolti prima del successivo test produttivo completo. Per la scelta corrente e l’esito aggiornato fare riferimento a [Confronto dei modelli di narrazione](docs/CONFRONTO-MODELLI-DI-NARRAZIONE.md).

## Esito

Il prompt Writer è stato accorciato e reso più focalizzato sul contenuto, la fedeltà al brief e le revisioni localizzate. Ho confrontato il Writer attuale con il vecchio prompt, una variante con ragionamento attivo e Mistral Small 3.2 con prompt equivalenti. Ho poi aggiunto un controllo esplicito della lunghezza e ripetuto le prove.

**Nessuna generazione ha raggiunto il minimo narrativo di 250 parole.** Il miglior risultato è Mistral a temperatura 0,78 con istruzione sulla lunghezza: 198 parole narrative. Il prompt più deciso non ha risolto il problema; la prova Mistral a 0,15 ne ha prodotte 146. Il Writer attuale ne ha prodotte 131 con il prompt originale e 138 con il prompt aggiornato e ragionamento disattivato.

Quindi il Writer non è ancora affidabile per questo brief. Mistral ha presentato meno difetti di formattazione nei campioni, ma non soddisfa il requisito di contenuto e non è un sostituto verificato per il requisito “senza filtri”. Non ho avviato una produzione sul Project File.

## Confronto controllato

Brief identico, stessa scena e stesso prompt ottimizzato per i confronti diretti; contesto 8192 e generazioni eseguite in sequenza, scaricando ogni modello al termine.

| Prova | Parole narrative | Controlli contenuto non superati | Difetti di presentazione | Osservazione |
|---|---:|---|---:|---|
| Writer, prompt precedente | 131 | Minimo 250 | 1 | Fraintendimento presente, scena troppo breve |
| Writer, prompt compatto | 193 | Minimo 250 | 1 | Più vicino al brief, ma resta corto e il dialogo è disomogeneo |
| Writer, prompt compatto + thinking | 165 | Minimo 250 | 1 | Il ragionamento ha consumato token senza completare la scena |
| Mistral, prompt compatto, temperatura 0,78 | 170 | Minimo 250; chiarimento non esclude esplicitamente l’offerta personale | 0 | Formato pulito, contenuto incompleto |
| Writer, prompt con controllo lunghezza | 138 | Minimo 250; chiarimento non esclude esplicitamente l’offerta personale | 1 | Aggiunge una battuta fuori tono |
| Mistral, controllo lunghezza, temperatura 0,78 | 198 | Minimo 250; chiarimento non esclude esplicitamente l’offerta personale | 0 | Miglior lunghezza tra i campioni, ma non sufficiente |
| Mistral, controllo lunghezza, temperatura 0,15 | 146 | Minimo 250; chiarimento non esclude esplicitamente l’offerta personale | 0 | Nessun miglioramento a bassa temperatura |
| Writer, piano interno dei beat + istruzione estesa | 180 | Minimo 250; chiarimento non esclude esplicitamente l’offerta personale | 1 | La pianificazione non ha risolto il problema; resta sotto soglia e ripete la chiarificazione |

Sono campioni singoli, quindi indicano tendenze e non una misura statistica. Tutti i risultati, gli hash dei prompt e gli eventi di caricamento/scaricamento sono nel manifest del confronto.

## Modelli scaricati e disponibilità

- **Mistral Small 3.2 24B Instruct Q4_K_M** è stato importato e compare in `lms ls`. La stima CLI è 13,35 GiB; le generazioni sono riuscite e il modello è stato scaricato al termine. La scheda ufficiale lo presenta come modello Instruct e suggerisce temperature basse, ad esempio 0,15; ho provato sia 0,78 per il confronto controllato sia 0,15 come controllo finale. [Scheda ufficiale](https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506)
- **Hemmingway 1 Abliterated Extreme Q4_K_M** è stato scaricato (16.547.400.032 byte) e ora è indicizzato e caricabile tramite LM Studio CLI. Ho completato una generazione controllata; l’esito è descritto nell’aggiornamento in fondo. Il repository lo descrive come uncensored; è una dichiarazione dell’autore del modello, non una verifica indipendente. [Repository del GGUF](https://huggingface.co/JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF)

I due file occupano complessivamente circa 28,8 GiB; dopo il download risultavano circa 31,2 GiB liberi sull’unità C:.

Mistral è stato usato come confronto di capacità di seguire istruzioni, non come raccomandazione per il requisito di un modello senza filtri. Hemmingway è stato aggiunto al confronto appena il catalogo CLI lo ha riconosciuto.

## Modifiche applicate

### Writer e Reviewer

- System prompt Writer ridotto da **7.254 a 1.858 caratteri**. Ora chiarisce gerarchia canon/brief, scrittura di scena, tema adulto richiesto, revisione conservativa, controllo interno della lunghezza e pianificazione silenziosa dei beat. La lunghezza richiesta resta un requisito del contenuto, non un difetto di formattazione.
- Writer: temperatura **0,78**, repeat penalty **1,02**, ragionamento disattivato. La produzione continua a caricare il Writer con contesto **8192**.
- Reviewer: prompt orientato esclusivamente ai problemi sostanziali del contenuto; temperatura **0,6**, top-K **20**, repeat penalty **1,05**, min-P **0**. I difetti di presentazione sono lasciati a Codex.
- La verifica meccanica ora richiede che la receptionist chiarisca anche a voce che non è un’offerta personale/romantica. Prima poteva passare un chiarimento che citava solo il minibar.
- Le revisioni Writer di una bozza sotto 250 parole hanno ora margine additivo sufficiente per raggiungere la soglia, mantenendo il blocco sulle sostituzioni integrali della scena. Codex conserva il proprio limite separato di intervento finale.

### Impostazioni degli altri modelli

Ho letto tutte e cinque le configurazioni concrete presenti. La configurazione di Image Controller resta intatta anche se il relativo modello è stato rimosso. Ho lasciato intatta anche la configurazione Qwen3.5 9B, il cui ruolo non è definito in questo test.

| Modello/configurazione | Valori rilevati |
|---|---|
| Qwen3.5 27B Writer | temperatura 0,78; repeat penalty 1,02; thinking off; prompt Writer aggiornato |
| Qwen3 8B Narrative Reviewer | temperatura 0,6; top-K 20; repeat penalty 1,05; min-P 0; prompt Reviewer contenuto-only |
| Mistral Small 3.2 24B candidato | temperatura 0,15; repeat penalty 1,02; prompt Writer; impostazione thinking omessa perché l’API LM Studio la rifiuta per questo modello |
| Qwen3.5 9B | temperatura 0,8; top-K 20; prompt esistente da 14.894 caratteri; lasciato invariato |
| Qwen3 8B Image Controller | temperatura 0,15; top-K 20; top-P 0,9; min-P 0; thinking off; configurazione conservata |

## File e verifiche

Codice e impostazioni aggiornati:

- `project-worker\mcp\orchestration\production.mjs`
- `project-worker\mcp\tools.mjs` e `project-worker\mcp\orchestration\runner.mjs` (modifiche del lavoro precedente incluse)
- `apps\bionic\.internal\user-concrete-model-default-config\...Writer...json`
- configurazione candidata Mistral nello stesso albero `user-concrete-model-default-config`
- `apps\bionic\.internal\ng-mcp.json`: revisione orchestration **20**

Backup delle impostazioni e dei worker: `worker-backups\narrative-quality-20261004-142155`. I file originali non sono stati sovrascritti senza backup.

Verifiche effettuate:

- cinque test mirati superati, inclusa la verifica che Writer possa aggiungere il contenuto mancante senza riscrivere l’intera scena;
- controlli sintattici Node superati per i file modificati;
- prove CLI dei modelli terminate: `lms ps` non mostra modelli caricati e `lms server status` indica il server locale fermo;
- la revisione MCP 20 è stata registrata; è comparso un nuovo processo Project Worker dopo l’aggiornamento della revisione;
- nessuna scrittura diretta a `ng-sessions.sqlite` e nessuna modifica alla sessione Regia o al Project File di produzione. L’importazione supportata di Mistral ha aggiunto il modello al catalogo LM Studio.

Risultati e campioni del confronto aggiornato:

- riepilogo aggiornato: [Confronto dei modelli di narrazione](docs/CONFRONTO-MODELLI-DI-NARRAZIONE.md)
- manifest, hash dei prompt, cicli Writer/Reviewer e verifiche Codex: [manifest del confronto](docs/confronto-modelli-narrazione/manifest.json)
- campioni base, revisioni Writer, review Reviewer e output Codex: [cartella dei campioni](docs/confronto-modelli-narrazione/)

## Limiti e prossimo passo

La modifica al prompt da sola non rende ancora il Writer affidabile: in ogni campione ha prodotto meno di 250 parole e in alcune prove ha mancato anche un chiarimento richiesto. La correzione al ciclo Writer/Reviewer consente ora una vera espansione locale e blocca una sostituzione completa, ma non ho eseguito un nuovo job di produzione end-to-end; le revisioni live e il comportamento Reviewer restano da verificare con un job di prova autorizzato.

Il prossimo test utile è un singolo ciclo Writer → Reviewer con lo stesso brief e le nuove impostazioni, controllando che il Reviewer chieda l’esplicita esclusione dell’offerta personale e che Writer espanda il testo conservando le battute valide. Hemmingway è ora indicizzato e testato via CLI; il risultato aggiornato è riportato sotto.

## Aggiornamento Hemmingway — 4 ottobre 2026

LM Studio CLI ora riconosce `Hemmingway1 Extreme` (27B, Q4_K_M; file GGUF da 16.547.400.032 byte). Ho eseguito la stessa prova abbinata usata per `writer-scaffold`, senza usare la GUI. Il campione ha **290 parole narrative**, rispetta l’intervallo 250–400 e non presenta difetti di presentazione rilevati dal controllo automatico. Tuttavia, la receptionist non esplicita nel dialogo che intendeva il minibar e che non era un’offerta personale/romantica: il campione fallisce entrambi i controlli sostanziali di contenuto. L’Italian Summary lo riassume, ma non sostituisce la battuta richiesta.

Conclusione: Hemmingway ha raggiunto meglio degli altri candidati la lunghezza richiesta in questo singolo campione, ma non è ancora affidabile sul contenuto chiave del brief. La dicitura “Abliterated/uncensored” è una dichiarazione del publisher e non prova da sola né assenza di filtri né aderenza alle direttive. Il modello è stato scaricato dalla memoria al termine; `lms ps` era vuoto e `lms server status` indicava il server fermo.

Campione Hemmingway della prova base: [base.md](docs/confronto-modelli-narrazione/hemmingway/base.md). Il manifest aggiornato con le prove complete è [manifest.json](docs/confronto-modelli-narrazione/manifest.json); il vecchio file `benchmark-results.json` non è conservato separatamente.
