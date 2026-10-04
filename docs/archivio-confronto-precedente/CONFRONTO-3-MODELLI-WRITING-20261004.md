# Confronto dei modelli di scrittura (Qwen, Mistral e Hemmingway)

Data: 4 ottobre 2026. I modelli sono stati controllati con LM Studio CLI; la GUI non è stata usata.

## Confronto

| Modello | Dimensione / quantizzazione | Decensurato? | Indicizzato e utilizzabile in LM Studio? | Lunghezza e limiti nel test | Qualità narrativa e direttive |
|---|---|---|---|---|---|
| **Qwen3.5 27B Writer v2 Uncensored Heretic** | 27B; Q4_K_M; **17,48 GB (16,28 GiB)** | **Sì, dichiarato decensurato** dal publisher. La sua scheda riporta 8 rifiuti su 100 nel test dell’autore: non significa restrizioni zero. | **Sì.** Presente in `lms ls`; cinque generazioni completate. | Corpo narrativo: **131–193 parole** nelle cinque prove; tutte sotto il minimo di 250. Il chiarimento che esclude l’offerta personale è mancato in quattro campioni su cinque. | Ha prodotto alcune battute utilizzabili, ma risultati incostanti: un campione contiene una battuta offensiva e fuori tono; uno ripete l’equivoco invece di risolverlo con chiarezza. Tutti e cinque hanno un difetto di presentazione nelle indicazioni d’azione. Non pronto per produrre senza revisione sostanziale. |
| **Mistral Small 3.2 24B Instruct** | 24B; Q4_K_M; **14,33 GB (13,35 GiB)** | **Non risulta decensurato.** È il modello standard “Instruct”; non lo considero adatto al requisito senza filtri. | **Sì.** Presente in `lms ls`; tre generazioni completate. | Corpo narrativo: **146–198 parole**; tutte sotto il minimo di 250. Nessuno dei tre campioni ha escluso chiaramente a voce che si trattasse di un’offerta personale. | Prosa più pulita e leggibile del Writer nei campioni; **zero difetti di presentazione** in tutte e tre le prove. Però continua a mancare requisiti narrativi, e in alcuni campioni aggiunge dettagli non canonici o mantiene l’ambiguità romantica dopo il chiarimento. È un buon confronto di formattazione, non un sostituto consigliato. |
| **Hemmingway 1 Abliterated Extreme** | 27B; Q4_K_M; **16,55 GB (15,41 GiB)** | **Sì, dichiarato “uncensored/abliterated”** dal publisher; affermazione del publisher, non verifica indipendente. | **Sì.** Ora compare in `lms ls` e la generazione CLI è riuscita. | Con il prompt Writer e scaffold abbinato: **290 parole narrative**, nel limite 250–400. Non ha chiarito esplicitamente nel dialogo che il minibar non era un’offerta personale/romantica. | Formato pulito, nessun difetto di presentazione automatico. La scena è leggibile e segue i beat, ma lascia l’ambiguità proprio nel punto che il brief chiedeva di risolvere a voce. Quindi non supera ancora i controlli di contenuto. |

Le etichette “decensurato” e “uncensored” descrivono le dichiarazioni dei rispettivi publisher. Non garantiscono che un modello segua ogni direttiva né che non rifiuti mai una richiesta.

## Prove effettuate

Ho eseguito cinque generazioni Qwen, tre Mistral e una Hemmingway sul brief di scena. La prova Hemmingway è abbinata alla prova `writer-scaffold`: stesso task e system prompt, temperatura 0,78 e repeat penalty 1,02. Per Mistral ho anche provato la temperatura 0,15 raccomandata dalla sua scheda. Si tratta di campioni singoli, non di un benchmark statistico.

**Hemmingway è ora indicizzato e caricabile tramite CLI.** Nella prova abbinata ha raggiunto 290 parole narrative e non ha difetti di presentazione rilevati, ma non ha superato i controlli sostanziali: la receptionist non dice chiaramente che si riferiva al minibar e che non era un invito personale. Anche gli altri campioni continuano a mostrare problemi di lunghezza o di contenuto. Nessun candidato ha superato tutti i controlli del brief.

## Prova Hemmingway

Il GGUF completo da **16.547.400.032 byte** è ora riconosciuto da LM Studio CLI con il nome `Hemmingway1 Extreme` e identificatore `JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF/Hemmingway1-Extreme-Q4_K_M.gguf`. Il campione è salvato in `production-tests\writer-model-comparison\hemmingway-scaffold.md`; i dettagli e gli hash sono nel manifest. Ha prodotto 290 parole narrative e zero difetti automatici di presentazione, ma fallisce entrambi i controlli sul chiarimento esplicito a voce. `lms ps` conferma che il modello è stato scaricato dalla memoria dopo la generazione; il server locale risulta fermo. Non è stato usato né modificato alcun database di produzione.

## Riferimenti e risultati locali

- [Scheda Qwen3.5 Writer del publisher](https://huggingface.co/llmfan46/Qwen3.5-27B-Writer-V2-uncensored-heretic-GGUF)
- [Scheda Hemmingway del publisher](https://huggingface.co/JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF)
- [Scheda ufficiale Mistral Small 3.2](https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506)
- [Manifest con risultati e controlli automatici](C:/Users/Shadow/.lmstudio/production-tests/writer-model-comparison/benchmark-results.json)
- [Rapporto completo sul Writer](C:/Users/Shadow/.lmstudio/RISULTATI-NARRATIVE-WRITER-20261004.md)
