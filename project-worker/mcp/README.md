# Project Worker MCP

Project Worker espone i ruoli e l’orchestrazione del progetto narrativo tramite MCP. Regia e Coordinatore governano il progetto; il Writer genera la prosa richiesta; il Narrative Reviewer valuta la scena e può chiedere correzioni localizzate. Il Writer non modifica direttamente Project File o canone.

## Processo narrativo

1. Codex e Qwen producono proposte di piano in parallelo.
2. Codex fonde le proposte in un `SceneContract` e ne valida schema e punto di vista. Se il contratto resta invalido dopo l’unica correzione consentita, il flusso si arresta prima della scrittura.
3. Il Writer riceve contratto e contesto canonico pertinente e scrive la scena.
4. Il Narrative Reviewer restituisce un esito e, se necessario, richieste di revisione circoscritte.
5. Dopo le correzioni, Codex verifica vincoli, canone e continuità. Le modifiche canoniche richiedono autorizzazione; la prosa non le applica automaticamente.

Planner e controlli di vincolo non sostituiscono il giudizio stilistico del Reviewer. Un fatto ignoto resta non definito e non autorizza il Writer a inventarlo. Per i dettagli dell’architettura e dello stato corrente, vedere il [README principale](../../README.md) e il [confronto dei modelli di narrazione](../../docs/CONFRONTO-MODELLI-NARRAZIONE.md).

## Comandi

Eseguire i comandi da questa directory:

```powershell
npm test
npm run test:planner
npm run test:component -- --role writer --writer-profile <profile> --writer-case normal
npm run test:component -- --role writer --writer-profile <profile> --writer-case hot
npm run test:component -- --role writer --writer-profile <profile> --writer-case violent
```

I test Writer isolati richiedono tre run indipendenti (`normal`, `hot`, `violent`), ciascuno con fixture, Project File, seed, run ID e cartella di output nuovi. Il runner usa risposte di revisione simulate; non avvia il Narrative Reviewer reale o la produzione. Nei confronti tra modelli si mantiene identica la fixture corrispondente per rendere comparabile ciascuna coppia. Si valutano richiesta, canone, continuità, tono ed endpoint, senza usare conteggio parole o rifinitura stilistica come criteri di superamento.

Il test Planner è isolato: registra le proposte, il merge e la validazione del contratto senza invocare Writer, asset o pubblicazione. Ogni run produce manifest e prove in `production-tests/components`; preservare run parziali e non rilanciare automaticamente chiamate dall’esito incerto. Le regole complete sono in [AGENTS.md](../../AGENTS.md).
