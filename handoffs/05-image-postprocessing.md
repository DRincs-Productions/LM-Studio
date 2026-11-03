# Handoff 05 — Post-produzione immagini e trasparenza

**Stato:** idea architetturale da verificare; componente non implementato.

## Flusso previsto

Dopo che il Disegnatore restituisce un'immagine approvata, il **Coordinatore** può decidere, in base alla richiesta e al tipo di asset, se avviare un **componente opzionale di post-produzione**. Non tutte le immagini devono attraversarlo.

1. Il Coordinatore riceve immagine, requisiti e riferimenti al job.
2. Se occorre una modifica non affidabile nel generatore, apre un job di post-produzione separato e tracciato.
3. **Codex** guida un'applicazione di grafica (programma di tipo **ArtCraft**, da identificare e verificarne il supporto effettivo) attraverso i relativi **strumenti MCP**, per aprire il file ed effettuare operazioni come la rimozione dello sfondo. Non dare per esistenti MCP o comandi specifici prima della verifica.
4. Il risultato modificato viene sottoposto a **review Gemini** come controllo finale proposto; verificare prima la capacità di esaminare correttamente immagini con alpha, bordi e contenuti consentiti. Un errore o rifiuto non costituisce approvazione.
5. Il Coordinatore conserva esito, versioni e riferimenti ai file; restituisce l'asset valido o un errore esplicito, senza sostituire silenziosamente l'originale.

## Primo caso: rimozione dello sfondo

Obiettivo: produrre un file con **canale alpha reale**, non soltanto uno sfondo dipinto di bianco o grigio. Valutare la qualità dei bordi, capelli, elementi sottili, ombre, trasparenze, aloni e perdita di dettagli.

### Preparazione dello sfondo in fase di generazione

Il Coordinatore può aggiungere istruzioni al prompt del Disegnatore per ottenere uno **sfondo uniforme e facilmente separabile**, senza linee di contorno colorate, riflessi contaminanti o bordi artificiali. **Il colore va scelto in funzione della palette del soggetto**, non fissato globalmente:

- **Bianco:** potenzialmente utile per soggetti scuri, ma problematico con capelli, vestiti o riflessi chiari.
- **Grigio neutro:** candidato per alcuni soggetti, ma può confondersi con ombre, metalli o abiti grigi.
- **Marrone:** candidato soltanto quando ben distinto da pelle, capelli, tessuti e altri elementi del soggetto.
- **Verde/rosso saturi:** possono favorire il keying in certi casi ma rischiano contaminazioni cromatiche, bordi evidenti e riflessi; non usarli come default.

Confrontare anche metodi che rimuovono lo sfondo senza richiedere un colore di keying. Evitare istruzioni che cambino i colori canonici del soggetto solo per semplificare lo scontorno.

## Prove e criteri

Testare soggetti chiari/scuri, capelli fini, bordi morbidi, dettagli complessi, semitrasparenze e colori simili allo sfondo. Confrontare input, PNG alpha prodotto e compositing su sfondi chiari/scuri; registrare artefatti, tempo, interventi manuali e giudizio Gemini. Verificare il supporto MCP dell'editor e le sue capacità reali prima di definire l'integrazione.

## Vincoli

Il generatore rimane **sd-cli.exe** finché non venga eventualmente approvata la migrazione descritta nell'handoff 04. La post-produzione è distinta sia dalla generazione sia dal trasporto degli asset via rclone. Tutti i passaggi restano job coordinati e tracciati, con possibilità di fallimento e recupero senza perdere l'originale. Nessuna modifica operativa è già stata eseguita.
