# Confronto dei modelli di narrazione

Ultimo aggiornamento: 4 ottobre 2026  
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

## Cosa sceglierei

**Sceglierei Hemmingway per il prossimo test Writer → Reviewer → Codex.** È l’unico che ha raggiunto la fascia sia nella prova base sia nel test completo, e nel campione finale ha gestito il malinteso con una battuta coerente. Il Reviewer ha fornito evidenze testuali corrette e Codex ha potuto fare correzioni locali senza riscrivere la scena.

Il blocco attuale è nell’automazione del controllo, non nella battuta generata: la scena dice che le bevande e gli snack sono nel minibar e che non si tratta di un’offerta personale o romantica, ma il controllo lessicale cerca principalmente formulazioni del tipo “I mean the minibar”. Per questo resta una segnalazione deterministica anche dopo il PASS del Reviewer e la verifica di Codex. Prima di usare Hemmingway nel workflow produttivo, quel gate va reso capace di riconoscere chiarimenti equivalenti senza accettare ambiguità reali.

Qwen e Mistral non li sceglierei come Writer per questa scena: i loro output finali restano ben sotto 250 parole, quindi raggiungere il requisito richiederebbe un’espansione sostanziale che Codex non dovrebbe improvvisare.

## Esito sul ciclo Reviewer → Codex

- Il limite di lunghezza deve essere verificato meccanicamente; il PASS del Reviewer da solo non è sufficiente. Qwen e Mistral hanno ottenuto PASS pur essendo sotto il minimo.
- Le correzioni del Writer vanno confrontate con la versione precedente. Qwen ha ripetuto la stessa bozza in tutti e tre i tentativi; Mistral ha corretto inizialmente ma poi ha accorciato; Hemmingway ha migliorato il payoff una volta e poi ha ripetuto il testo.
- Il chiarimento del minibar deve essere controllato semanticamente o con più formulazioni ammesse. La frase di Hemmingway “They are not a personal offer. They are not a romantic offer” è esplicita, ma il precheck corrente continua a segnalarla.
- Il brief per il modello e il Reviewer deve includere il Project File canonico completo. Nel benchmark l’estratto iniziale ometteva che Alex è maschio; Codex lo ha ripreso dal file canonico alla revisione finale.

Non sono stati modificati il Project File, la sessione Regia, il database Bionic o i settaggi permanenti dei modelli. A fine test `lms ps` non mostrava modelli caricati e il server LM Studio risultava fermo.

## Campioni e tracciabilità

Manifest con hash, eventi, metriche, cicli Reviewer e decisione Codex: [manifest.json](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/manifest.json).

### Qwen

- [Prova base](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/qwen-writer/base.md)
- [Bozza completa iniziale](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/qwen-writer/full-writer-1.md)
- [Terza correzione Writer](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/qwen-writer/writer-revision-3.md)
- [PASS finale del Reviewer](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/qwen-writer/reviewer-3.md)
- [Revisione Codex e motivi del mancato via libera](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/qwen-writer/codex-review.md)
- [Bozza corretta localmente da Codex, ancora troppo corta](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/qwen-writer/codex-final-draft.md)

### Mistral

- [Prova base](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/mistral-small/base.md)
- [Bozza completa iniziale](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/mistral-small/full-writer-1.md)
- [Terza correzione Writer](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/mistral-small/writer-revision-3.md)
- [PASS finale del Reviewer](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/mistral-small/reviewer-3.md)
- [Revisione Codex e motivi del mancato via libera](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/mistral-small/codex-review.md)
- [Bozza corretta localmente da Codex, ancora troppo corta](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/mistral-small/codex-final-draft.md)

### Hemmingway

- [Prova base](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/hemmingway/base.md)
- [Bozza completa iniziale](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/hemmingway/full-writer-1.md)
- [Correzione Writer](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/hemmingway/writer-revision-1.md)
- [PASS finale del Reviewer](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/hemmingway/reviewer-3.md)
- [Scena finale corretta da Codex](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/hemmingway/codex-final.md)
- [Revisione Codex e gate automatico rimasto](C:/Users/Shadow/.lmstudio/docs/confronto-modelli-narrazione/hemmingway/codex-review.md)

Schede dei modelli: [Qwen Writer](https://huggingface.co/llmfan46/Qwen3.5-27B-Writer-V2-uncensored-heretic-GGUF), [Hemmingway](https://huggingface.co/JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF), [Mistral Small 3.2](https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506).

I campioni precedenti sono stati spostati, per conservarli e lasciare pulita la cartella dei test, in [archivio-confronto-precedente](C:/Users/Shadow/.lmstudio/docs/archivio-confronto-precedente/).
