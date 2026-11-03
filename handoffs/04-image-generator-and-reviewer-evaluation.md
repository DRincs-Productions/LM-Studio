# Handoff 04 — Valutazione InvokeAI e reviewer Gemini

**Stato:** proposta di test; nessuna migrazione implementata.

## Architettura attuale e obiettivo

Il Coordinatore Rust riceve una richiesta che include stile e contenuto (standard, anime, adulto) e la inoltra direttamente alla selezione del modello del Disegnatore. Il generatore operativo rimane **sd-cli.exe**. Dopo la generazione, **Codex** è il reviewer attuale; se l'immagine è approvata, il risultato torna direttamente al Coordinatore, senza un nodo di pubblicazione rclone nel Disegnatore. Il Coordinatore decide separatamente se e quando trasferire gli asset.

## Esperimento A — InvokeAI al posto di sd-cli.exe

Valutare una futura migrazione a **InvokeAI**, mantenendo invariata l'interfaccia del job verso il Coordinatore e il comportamento dei modelli.

Verificare prima di scegliere: supporto effettivo ai checkpoint Krea2 Turbo, Krea2 Anime e RedCraft e relativi encoder/VAE; caricamento e gestione delle LoRA; impostazioni seed, passi, CFG, risoluzione e formati; automazione tramite API/CLI e gestione dei job; installazione Windows Shadow, VRAM, RAM, velocità, stabilità e ripresa dopo errore; disponibilità dei log, metadati e file; licenze e costi. **Non assumere compatibilità dei modelli senza una prova reale.**

Protocollo: riprodurre un set di prompt, seed e parametri con entrambi i backend quando possibile; confrontare output, qualità, performance, errori e risorse; documentare le differenze di pipeline. Conservare **sd-cli.exe** come fallback fino a test soddisfacenti. Nessuna disinstallazione o migrazione automatica.

## Esperimento B — Gemini come reviewer del Disegnatore

Confrontare **Gemini** con **Codex** sulle stesse immagini e rubriche: fedeltà al prompt, anatomia, composizione, stile, artefatti, errori gravi, punteggio e motivazione. Includere casi standard, anime e adulti consentiti; misurare anche eventuali rifiuti, attenuazioni, falsi positivi, costi, limiti di quota e latenza. La soglia attuale di accettazione rimane quella prevista dalla pipeline, senza dichiarare i risultati comparabili finché la rubrica non è allineata.

Gemini è **solo un candidato**. Codex resta il reviewer operativo finché il confronto non dimostra che la sostituzione è appropriata. Un rifiuto o un errore di review non deve equivalere ad approvazione.

## Criterio decisionale

Redigere un rapporto con versioni esatte, esempi, parametri, risultati e regressioni; adottare InvokeAI o Gemini solo dopo una decisione esplicita. Non cambiare AGENTS.md né cancellare componenti condivisi.
