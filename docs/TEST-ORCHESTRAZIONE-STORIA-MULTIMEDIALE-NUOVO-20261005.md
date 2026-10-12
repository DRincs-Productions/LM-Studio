# Nuovo test indipendente: storia lunga con immagini e audio

Data: 5 ottobre 2026

## Obiettivo

Verificare un progetto nuovo, senza riutilizzare il test Grand Hotel o i suoi asset. Regia definisce e approva il Project File; dopo l'handoff, Codex deve completare la produzione nel modo più autonomo possibile, senza chiedere decisioni creative durante la fase autorizzata. Claude è escluso.

Regia non deve fissare quantità di immagini o suoni. La pianificazione del numero e dei punti degli asset compete a Codex, sulla base della lunghezza e dei cambiamenti narrativi. La prova deve mostrare più immagini per una storia con più ambienti o momenti e una selezione audio contenuta, limitata ai passaggi che guadagnano davvero da un cue. Codex specifica per ogni cue se è musica o effetto, se è loop, quando parte e quando termina.

## Controlli effettuati

- Image Worker MCP: disponibile. `sd-cli.exe`, modello normale e modello adult presenti; trasferimento configurato verso `imagecloud:/ImageWorker/final`.
- Audio Worker MCP: disponibile. Backend audio.cpp v0.9.0 Vulkan, Stable Audio 3 Medium Q8 e Small SFX Q8 presenti; destinazioni distinte per musica ed effetti via rclone configurate.
- GPU rilevata: NVIDIA RTX A4500; il controllo Audio Worker ha segnalato circa 487 MiB usati su 19.190 MiB.
- PC cloud: l’esecuzione su una macchina separata non è stata provata; la generazione immagini di questa prova è avvenuta sull’host di test. Nessun job remoto sarà dichiarato.
- Progetto precedente `grand_hotel_malinconico_-_check-in_comico_di_alex_20261004_183859_aefe4e.md`: stato `handback_ready`, quindi lasciato intatto e non riutilizzato.

## Blocco trovato nel flusso attuale

Il coordinatore accetta esclusivamente la fase `single_scene_text_image`. Il suo Writer e i validatori impongono una scena da 250–400 parole, un'unica direttiva Visual e il caso specifico della reception/minibar. `finalize_reviewed_scene` genera e trasferisce una sola immagine. Il runner non abilita `audio-worker` nella propria allowlist e rifiuta qualsiasi risultato che non corrisponda alla singola immagine prevista. Perciò l'hardware e i worker sono pronti, ma il flusso di produzione corrente non può ancora eseguire il test richiesto.

Non ho modificato il Project File precedente, il database Bionic, i modelli, la configurazione MCP o i worker durante questa verifica. Nessuna generazione è stata avviata.

## Fase necessaria prima del test completo

Serve un profilo di produzione distinto e compatibile con il progetto esistente, lasciando intatto quello per la singola scena. Il nuovo profilo deve:

1. produrre una storia completa di circa 1.200–1.600 parole con Hemmingway;
2. completare Writer → Reviewer e poi la review finale di Codex con correzioni locali, preservando il testo approvato;
3. far pianificare a Codex immagini in corrispondenza dei cambi di scena o dei momenti visivi significativi, senza quantità prefissate da Regia;
4. far selezionare a Codex pochi cue audio salienti, senza riempire ogni scena di suoni, distinguendo musica/effetti e loop/one-shot;
5. usare Image Worker, Audio Worker e il trasferimento asset esistente; verificare review, hash, percorsi locali e pubblicazioni per ciascun asset;
6. aggiornare il Project File e restituire un handback strutturato, includendo eventuali blocchi anziché fermare il flusso per normali scelte operative già delegabili a Codex.

La fase deve essere idempotente: non ripetere Writer, generazioni o pubblicazioni se un job fallisce dopo aver prodotto effetti parziali. La ripresa deve prima ispezionare gli artefatti esistenti.

## Richiesta iniziale da inviare a Regia

> Iniziamo da zero un progetto indipendente dai test precedenti. Sviluppiamo una storia originale, divertente e coinvolgente ambientata attorno a un vecchio faro portuale che comincia a battere un'ora impossibile durante una notte di marea. I protagonisti sono adulti; puoi inventarne nomi, caratteri e relazioni. Vorrei una storia abbastanza articolata, con più momenti e ambienti distinti, un piccolo mistero comico e un finale soddisfacente. Tieni conto che Codex dovrà poter decidere autonomamente quali immagini e pochi cue audio siano davvero utili dopo aver letto la storia: nel Project File conserva contesto canonico, intenzione narrativa, transizioni visive importanti e suoni o musica significativi, senza stabilire il numero degli asset. Il testo finale sarà in inglese e lungo circa 1.200–1.600 parole; la conversazione con me resta in italiano. Non usare Claude. Prima sviluppiamo e salviamo il Project File completo; non avviare la produzione finché non mi hai presentato il piano e non ho approvato esplicitamente.

## Stato

**Non ancora avviato:** la fase Regia → Project File approvato → handoff non è stata eseguita. Per un test valido Regia deve registrare il nuovo Project File nella propria sessione Bionic e inviare l'handoff; Codex non deve inventare quell'associazione né simulare l'approvazione. Dopo l'handoff, Codex dovrà verificare il profilo di produzione e completare autonomamente la fase autorizzata.
