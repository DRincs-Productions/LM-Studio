# Confronto dei modelli di narrazione

> **Nota sul processo attuale:** questo è un rapporto storico dei test svolti con la pipeline precedente. La pipeline narrativa corrente prepara un `SceneContract` con proposte parallele di Codex e Qwen, merge e validazione a cura di Codex, scrittura, revisione narrativa e controllo finale di Codex. Il Writer non può cambiare il canone. Per i confronti isolati aggiornati e per i risultati Hemmingway–Cydonia, consultare [CONFRONTO-MODELLI-NARRAZIONE.md](CONFRONTO-MODELLI-NARRAZIONE.md).

Ultimo aggiornamento: 25 ottobre 2026
Ambiente: Windows, LM Studio CLI. La GUI non è stata usata.

## Protocollo

Ogni modello ha ricevuto un campione base e un test completo separato con Writer → Narrative Reviewer → correzioni Writer → revisione finale Codex. Il brief ha usato per tutti la stessa **fascia di 250–400 parole narrative**, senza un obiettivo numerico preciso. Parametri Writer uniformi: temperatura 0,78, repeat penalty 1,02, contesto 8192. Il Reviewer è il Qwen3 8B Narrative Reviewer configurato per Project Worker.

Il test è narrativo: non ha avviato Image Worker, trasferimenti o produzione di asset. La revisione Codex finale è stata fatta contro il Project File completo. Il prompt iniziale del benchmark usava un estratto canonico ridotto, che ometteva il fatto che Alex è il protagonista maschile; Codex ha verificato e corretto questo punto alla revisione finale. Questa limitazione è riportata per non attribuire al Writer errori su un fatto non incluso nel suo estratto.

## Confronto

| Modello | GGUF / dichiarazione del publisher | Prova base | Test completo e correzione Writer | Reviewer e Codex | Valutazione |
|---|---|---:|---|---|---|
| **Qwen3.5 27B Writer v2 Uncensored Heretic** | 27B, Q4_K_M, 17,48 GB. Publisher lo definisce “uncensored/heretic”; non è una verifica indipendente. | **235 parole**, sotto soglia | Prima scena: **189 parole**. Dopo tre correzioni Writer: sempre 189 parole, testo identico alla bozza iniziale. | Reviewer ha dato PASS anche quando la scena era sotto il minimo e ha descritto il conteggio come conforme. Codex ha corretto localmente genere e formato; resta a 191 parole, quindi **non approvato**. | Non adatto a questo brief nelle prove fatte. Non ha espanso né corretto il testo nonostante feedback ripetuto. |
| **Mistral Small 3.2 24B Instruct** | 24B, Q4_K_M, 14,33 GB. Modello Instruct standard, non presentato come decensurato. | **151 parole**, sotto soglia | Prima scena: **160 parole**; prima correzione: 165; versioni successive: **120 parole**. Tre correzioni tentate, con modifiche effettive nelle prime due ma risultato finale più corto. | Reviewer ha dato PASS pur restando sotto soglia. Codex ha rimosso il cognome inventato, corretto il genere e chiarito nel dialogo che non era un’offerta personale. Il campione Codex resta a **123 parole**, quindi **non approvato**. | Prosa leggibile e formato riparabile, ma non raggiunge la fascia e introduce dettagli/persona non canonici. Non consigliato come Writer per questo workflow. |
| **Hemmingway 1 Abliterated Extreme** | 27B, Q4_K_M, 16,55 GB. Publisher lo definisce “abliterated/uncensored”; non è una verifica indipendente. | **292 parole**, nella fascia | Prima scena completa: 299 parole; dopo la prima correzione: 302; il Writer ha poi ripetuto la versione. Tre correzioni tentate, una ha migliorato il payoff comico. | Reviewer finale: PASS con prove testuali valide. Codex ha corretto i pronomi rispetto al Project File e rimosso un personaggio incidentale: **281 parole**, nella fascia, edit entro il budget locale. Il gate automatico corrente segnala però un falso negativo sul chiarimento del minibar. | **Miglior candidato dei tre** in questo test: lunghezza centrata, tono giocoso, chiarimento esplicito e formato pulito dopo Codex. Il ciclo non passa ancora il gate automatico senza correggere il falso negativo. |

Le lunghezze sono contate sul solo corpo narrativo, senza il Visual o il riepilogo italiano. I risultati sono campioni singoli; sono utili per scegliere il prossimo esperimento, non per affermare una superiorità statistica.

## Scelta corrente

Per questo workflow scegliamo **Hemmingway** come Writer operativo. Qwen e Mistral restano installati e i campioni precedenti sono conservati: la scelta è attuale e reversibile, non elimina gli altri candidati.

Il test completo successivo è riuscito: Hemmingway ha prodotto una scena nella fascia richiesta, il Narrative Reviewer ha dato PASS al primo ciclo e Codex ha completato il controllo finale con una modifica locale alla sola direttiva Visual per rendere espliciti età e ruolo canonici di Alex. La prosa e i dialoghi narrativi sono rimasti invariati.

La pipeline ha poi generato un’immagine quadrata 1024×1024. Il tentativo 2 ha ottenuto 88 punti e `MAJOR_ERROR: NO`; l’immagine è stata finalizzata, pubblicata e trasferita con SHA256 verificato. Il resoconto completo è in `confronto-modelli-narrazione/hemmingway/production-result.json`.
## Esito sul ciclo Reviewer → Codex

- Il limite di lunghezza deve essere verificato meccanicamente; il PASS del Reviewer da solo non è sufficiente. Qwen e Mistral hanno ottenuto PASS pur essendo sotto il minimo.
- Le correzioni del Writer vanno confrontate con la versione precedente. Qwen ha ripetuto la stessa bozza in tutti e tre i tentativi; Mistral ha corretto inizialmente ma poi ha accorciato; Hemmingway ha migliorato il payoff una volta e poi ha ripetuto il testo.
- Il chiarimento del minibar deve essere controllato semanticamente o con più formulazioni ammesse. Nelle prime prove la frase di Hemmingway “They are not a personal offer. They are not a romantic offer” causava un falso negativo del precheck. Il controllo è stato corretto e la prova completa successiva ha verificato il chiarimento, incluso quando era distribuito su battute adiacenti.
- Il brief per il modello e il Reviewer deve includere il Project File canonico completo. Nel benchmark l’estratto iniziale ometteva che Alex è maschio; Codex lo ha ripreso dal file canonico alla revisione finale.

Non sono stati modificati il Project File, la sessione Regia, il database Bionic o i settaggi permanenti dei modelli. A fine test `lms ps` non mostrava modelli caricati e il server LM Studio risultava fermo.

## Campioni e tracciabilità

Manifest con hash, eventi, metriche, cicli Reviewer e decisione Codex: [manifest.json](confronto-modelli-narrazione/manifest.json).

### Qwen

- [Prova base](confronto-modelli-narrazione/qwen-writer/base.md)
- [Bozza completa iniziale](confronto-modelli-narrazione/qwen-writer/full-writer-1.md)
- [Terza correzione Writer](confronto-modelli-narrazione/qwen-writer/writer-revision-3.md)
- [PASS finale del Reviewer](confronto-modelli-narrazione/qwen-writer/reviewer-3.md)
- [Revisione Codex e motivi del mancato via libera](confronto-modelli-narrazione/qwen-writer/codex-review.md)
- [Bozza corretta localmente da Codex, ancora troppo corta](confronto-modelli-narrazione/qwen-writer/codex-final-draft.md)

### Mistral

- [Prova base](confronto-modelli-narrazione/mistral-small/base.md)
- [Bozza completa iniziale](confronto-modelli-narrazione/mistral-small/full-writer-1.md)
- [Terza correzione Writer](confronto-modelli-narrazione/mistral-small/writer-revision-3.md)
- [PASS finale del Reviewer](confronto-modelli-narrazione/mistral-small/reviewer-3.md)
- [Revisione Codex e motivi del mancato via libera](confronto-modelli-narrazione/mistral-small/codex-review.md)
- [Bozza corretta localmente da Codex, ancora troppo corta](confronto-modelli-narrazione/mistral-small/codex-final-draft.md)

### Hemmingway

- [Prova base](confronto-modelli-narrazione/hemmingway/base.md)
- [Bozza completa iniziale](confronto-modelli-narrazione/hemmingway/full-writer-1.md)
- [Correzione Writer](confronto-modelli-narrazione/hemmingway/writer-revision-1.md)
- [PASS finale del Reviewer](confronto-modelli-narrazione/hemmingway/reviewer-3.md)
- [Scena finale corretta da Codex](confronto-modelli-narrazione/hemmingway/codex-final.md)
- [Revisione Codex e gate automatico rimasto](confronto-modelli-narrazione/hemmingway/codex-review.md)

Schede dei modelli: [Qwen Writer](https://huggingface.co/llmfan46/Qwen3.5-27B-Writer-V2-uncensored-heretic-GGUF), [Hemmingway](https://huggingface.co/JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF), [Mistral Small 3.2](https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506).

I campioni precedenti sono stati spostati, per conservarli e lasciare pulita la cartella dei test, in [archivio-confronto-precedente](archivio-confronto-precedente/).

## Test completo con asset (4 ottobre 2026)

- **Writer:** Hemmingway 1 Abliterated Extreme; gli altri modelli sono stati mantenuti.
- **Reviewer:** PASS in un ciclo; Codex final review: passed.
- **Narrativa:** [scena finale](confronto-modelli-narrazione/hemmingway/production-final.md), 351 parole narrative, Visual iniziale, nessun suono o musica.
- **Immagine:** quadrata 1024×1024; score 88, `MAJOR_ERROR: NO`, tentativo 2.
- **Asset trasferito:** `C:\AI\assets\8cabd04f-763a-47a7-b36b-9e464efc9a87\adc6d3f1-de20-4e38-9e47-adf5216e630c\8cabd04f-763a-47a7-b36b-9e464efc9a87_adc6d3f1-de20-4e38-9e47-adf5216e630c_hotel_reception.png`; SHA256 uguale al file pubblicato.
- **Esclusioni rispettate:** Claude, suoni/musica e generazione su un PC cloud separato esclusi; Image Worker eseguito sull'host di test.
- **Tracciabilità:** [risultato completo](confronto-modelli-narrazione/hemmingway/production-result.json), [revisione Reviewer](confronto-modelli-narrazione/hemmingway/production-reviewer.md), [revisione Codex](confronto-modelli-narrazione/hemmingway/production-codex-review.json).

## Confronto componente Hemmingway–Cydonia (25 ottobre 2026)

Nuovo confronto isolato con tre coppie di fixture identiche per caso (normale, hot consensuale tra adulti, violenza cruenta fittizia). **Hemmingway è il vincitore comparativo** con confidenza moderata-bassa: due casi a suo favore e un pareggio, soprattutto per maggiore aderenza ai beat e risposta alle correzioni. Nessuno dei due ha rispettato tutti i vincoli. Cydonia è però molto più rapido: 11:51 complessivi di generazione contro 23:15 di Hemmingway, includendo draft e correzione simulata. Tempi e limiti del confronto, valutazioni cieche e sei manifest sono nel [rapporto dettagliato](../production-tests/components/hemmingway-cydonia-20261025-2f1c02ed/assessment.md).
