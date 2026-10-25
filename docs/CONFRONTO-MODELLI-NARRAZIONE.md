# Confronto dei modelli di narrazione

Questo documento raccoglie i confronti **isolati** dei modelli Writer. Il flusso narrativo di produzione è distinto: Codex e Qwen preparano proposte di piano, Codex le consolida in un `SceneContract` validato, il Writer redige la scena, il Narrative Reviewer valuta e richiede eventuali correzioni circoscritte, quindi Codex esegue il controllo finale di canone e continuità. Solo Codex può approvare modifiche canoniche; il testo generato non aggiorna da solo lo stato della storia.

Nei test isolati il runner usa una richiesta di revisione simulata e controllata, per misurare il comportamento del modello senza avviare il Reviewer reale o la produzione. Ogni categoria (`normal`, `hot`, `violent`) usa fixture e run indipendenti. I criteri sono aderenza alla richiesta, canone, continuità, tono ed endpoint; lunghezza e rifinitura stilistica non sono criteri di superamento.

Questo documento riassume i test isolati eseguiti sui tre modelli Writer: **Hemmingway 1 Abliterated Extreme**, **MS3.2 PaintedFantasy v4.1 24B** e **Cydonia 24B v4.3**. Sono stati testati in tre categorie: narrazione normale, scena hot consensuale tra adulti e scena cruenta fittizia. Non sono stati usati conteggio parole o rifinitura stilistica come criteri.

## Risultato sintetico

| Modello | Punti emersi | Problemi ricorrenti | Esito |
|---|---|---|---|
| **Hemmingway 1 Abliterated Extreme** | Più coerente nella scena cruenta; nel test hot iniziale ha mantenuto l’anello rimosso prima del contatto e ha chiuso vicino all’endpoint richiesto. | Nei casi normali ha alterato dettagli canonici o continuato dopo il finale; le revisioni simulate non sempre correggono i vincoli e talvolta introducono incoerenze. | È il modello predefinito per ora, con affidabilità limitata. |
| **MS3.2 PaintedFantasy v4.1 24B** | Ha seguito meglio la richiesta di consenso verbale nel test hot. | Ha mancato vincoli dell’anello e dell’endpoint; nel caso cruento ha aggiunto una seconda ferita e testo oltre la presa in carico. | Non è un sostituto generale di Hemmingway. I pesi sono stati rimossi, la configurazione è conservata per un’eventuale reinstallazione. |
| **Cydonia 24B v4.3** | Ha recepito meglio alcune correzioni esplicite, come il dettaglio del quadrante e il consenso hot nella revisione. | Invenzioni o cambi di cronologia nel normale; ordine errato tra contatto e rimozione dell’anello nel draft hot; duplicazioni e personaggi/dettagli non richiesti nel caso cruento. | Candidato alternativo; non ci sono prove sufficienti per promuoverlo. |

## Conclusione

Nessun modello ha rispettato tutti i vincoli in ogni categoria. I problemi più stabili sono la conservazione del canone e il rispetto dell’endpoint; cambiare modello da solo non li elimina. Le revisioni usate in questi component test sono richieste simulate e controllate, non valutazioni del Narrative Reviewer reale: in alcuni casi hanno corretto un dettaglio, in altri hanno introdotto nuovi problemi.

**Scelta attuale: Hemmingway resta il Writer predefinito.** Cydonia rimane installato come alternativa da valutare; PaintedFantasy è stato rimosso dal disco ma la sua configurazione resta disponibile. I risultati sono preliminari: una prova per modello e categoria non basta per misurare la variabilità tra generazioni.

## Rapporti e prove

- [Confronto controllato Hemmingway–PaintedFantasy](../production-tests/WRITER-COMPARISON-2026-10-25.md): stessa batteria di categorie; scenari separati per run.
- [Confronto controllato Hemmingway–Cydonia](../production-tests/WRITER-COMPARISON-CYDONIA-HEMMINGWAY-2026-10-25.md): stesso brief all’interno di ogni coppia di modelli.
- [Test PaintedFantasy del 25 ottobre](../production-tests/WRITER-2026-10-25.md), sezione nel README e manifest collegati per run.
- I run individuali, i prompt e le valutazioni sono conservati in `production-tests/components/` e nelle cartelle collegate ai rapporti.
