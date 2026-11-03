# Handoff 06 — Valutazione Gemini per la revisione audio

**Stato:** valutazione futura, nessuna sostituzione implementata.

## Flusso di riferimento

Il **Coordinatore Rust** gestisce le richieste, le code, l'eventuale riutilizzo di asset già approvati e il trasferimento dei risultati via rclone. Quando serve un nuovo audio, invia la richiesta direttamente a **Seleziona modello** nel Progettista sonoro. Il generatore attuale resta **audio.cpp v0.9.0 Vulkan** con **Stable Audio 3 Medium Q8** per la musica e **Stable Audio 3 Small SFX Q8** per gli effetti.

La review operativa resta **Qwen2.5 Omni 7B** per l'ascolto percettivo e **Codex** per la valutazione finale, con i controlli tecnici, la soglia di almeno 80/100, nessun errore grave e massimo tre generazioni per cue. L'audio approvato ritorna al Coordinatore; il Progettista sonoro **non pubblica tramite rclone**.

## Ipotesi da verificare: Gemini come reviewer audio

Gemini potrebbe sostituire, interamente o parzialmente, il percorso Qwen2.5 Omni + Codex. La disponibilità di funzioni di comprensione audio **non garantisce** che la specifica versione Gemini CLI o API scelta supporti tutti i formati, la durata e la qualità di valutazione necessari.

### Verifiche preliminari

- Accertare con una prova reale che Gemini CLI/API accetti i WAV generati, con dimensioni, durata, canali e frequenze di campionamento previsti. Documentare se occorre un passaggio di upload o conversione.
- Verificare autenticazione, quote, costi, disponibilità e restrizioni applicabili ai contenuti.
- Valutare se Gemini può produrre evidenze percettive strutturate e un giudizio motivato senza inventare caratteristiche non presenti nel file.
- Stabilire se il punteggio finale debba restare affidato a Codex o possa essere attribuito a Gemini con una rubrica riproducibile.

### Test comparativi

Usare gli stessi cue e file per Qwen2.5 Omni + Codex e Gemini, includendo musica, effetti sonori, audio breve e lungo, loop con giunzioni corrette o difettose, clipping, silenzio, rumore, artefatti, aderenza al prompt e casi con contenuti consentiti ma sensibili.

Registrare accuratezza nell'identificare problemi, falsi positivi/negativi, coerenza dei giudizi, qualità del JSON o output strutturato, tempo, consumo di risorse, costi, rifiuti ed errori. Verificare specificamente la capacità di valutare **la continuità del loop**, usando una preview ripetuta quando necessario: una singola riproduzione non è sufficiente.

## Regole di adozione

Non modificare la pipeline operativa finché i test non siano documentati e approvati. Un errore, una risposta incompleta o un rifiuto del reviewer non devono mai essere trattati come approvazione. Conservare i controlli tecnici deterministici anche in caso di passaggio a Gemini. Non cancellare i modelli o i componenti Qwen/Codex senza verificare le dipendenze condivise.

Questo handoff descrive un piano, non funzionalità già realizzate.
