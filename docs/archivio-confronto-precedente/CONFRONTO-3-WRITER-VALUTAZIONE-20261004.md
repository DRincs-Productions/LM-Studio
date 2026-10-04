# Confronto dei tre modelli Writer

Data: 4 ottobre 2026  
Ambiente: LM Studio CLI su Windows; GUI non utilizzata.  
Criterio prioritario: qualità del contenuto e aderenza alle direttive del brief. La correzione automatica del formato è più semplice che riparare una scena che ha mancato un beat narrativo.

## Tabella comparativa

| Criterio | Qwen3.5 27B Writer v2 Uncensored Heretic | Mistral Small 3.2 24B Instruct | Hemmingway 1 Abliterated Extreme |
|---|---|---|---|
| **File / quantizzazione** | Q4_K_M; 17,48 GB (16,28 GiB) | Q4_K_M; 14,33 GB (13,35 GiB) | Q4_K_M; 16,55 GB (15,41 GiB) |
| **Stato LM Studio CLI** | Indicizzato, 5 generazioni completate | Indicizzato, 3 generazioni completate | Ora indicizzato; generazione completata |
| **Etichetta “senza filtri”** | Publisher: “uncensored/heretic”; la scheda riporta il proprio test di rifiuti, non una garanzia di zero rifiuti | Modello Instruct standard; non è presentato come decensurato | Publisher: “abliterated/uncensored”; è una dichiarazione del publisher |
| **Lunghezza della narrazione** | 131–193 parole nei 5 campioni; nessuno raggiunge 250 | 146–198 parole nei 3 campioni; nessuno raggiunge 250 | 290 parole nel campione abbinato; dentro il limite 250–400 |
| **Rispetto del beat chiave** | Il chiarimento esplicito che non è un invito personale manca in 4 campioni su 5 | Manca in tutti e 3 i campioni | Manca nel campione provato; il riepilogo italiano lo dice, ma non vale come chiarimento nel dialogo |
| **Formato** | Tutti e 5 i campioni hanno almeno un difetto di presentazione (direzioni d’azione nei dialoghi/etichette) | Nessun difetto automatico di presentazione nei 3 campioni | Nessun difetto automatico di presentazione nel campione |
| **Qualità narrativa osservata** | Alcune battute funzionano, ma qualità e tono sono discontinui; un campione contiene una battuta fuori tono e offensiva | Prosa in genere leggibile e pulita, ma tende ad aggiungere dettagli non richiesti e non chiude il malinteso come richiesto | Scena scorrevole, tono leggero e lunghezza adeguata; però il payoff lascia irrisolto il punto narrativo centrale |
| **Velocità osservata** | Circa 6,8–7,7 token/s nei campioni registrati | Circa 8,4–9,4 token/s | Circa 6,75 token/s |
| **Esito per questo brief** | Non pronto senza una forte revisione Writer/Reviewer | Buon formato, ma insufficiente per contenuto e requisito “senza filtri” | Miglior base grezza dei tre per lunghezza e formato, ma richiede comunque correzione sostanziale del beat chiave |

Le generazioni non sono un benchmark statistico: Qwen ha più campioni, Mistral ne ha tre e Hemmingway uno. Per la riga Hemmingway la prova usa lo stesso task scaffold, system prompt, temperatura 0,78 e repeat penalty 1,02 della prova `writer-scaffold` di Qwen. I risultati automatici misurano requisiti specifici del brief; la valutazione di qualità narrativa è una lettura qualitativa dei campioni.

## Quale sceglierei

**Per il prossimo test sceglierei Hemmingway come Writer principale.** In questo campione è l’unico che ha raggiunto la lunghezza prevista mantenendo una presentazione pulita. Non lo promuoverei ancora a Writer affidabile: ha mancato proprio una direttiva narrativa esplicita, quindi il Reviewer deve bloccare quel difetto e chiedere una correzione locale.

**Mistral è il migliore per la pulizia formale**, ma non lo sceglierei come Writer predefinito del progetto: ha mancato il chiarimento sostanziale in tutte le prove e non è presentato come decensurato. Codex può sistemare il formato; non dovrebbe dover inventare o riscrivere il beat mancante.

**Qwen resta il candidato con etichetta decensurata più chiara insieme a Hemmingway**, ma nei campioni è il più discontinuo: testi troppo brevi, difetti di formato e almeno un passaggio fuori tono. Lo terrei come alternativa da confrontare con un prompt e un Reviewer mirati, non come prima scelta sulla base dei risultati attuali.

La mia graduatoria provvisoria per questo workflow è quindi:

1. **Hemmingway — da provare per primo**, subordinato a un Writer → Reviewer che corregga il contenuto senza riscrivere la scena.
2. **Qwen Writer — alternativa se il requisito di decensura pesa più della pulizia attuale**, ma serve una revisione più consistente.
3. **Mistral — utile per prosa e formattazione, meno adatto al requisito “senza filtri” e ai beat di questo brief.**

La differenza di un singolo campione non basta a concludere che Hemmingway sia in assoluto il migliore. Il prossimo confronto utile è un ciclo identico Writer → Reviewer per Hemmingway e Qwen, controllando che Reviewer rilevi il beat mancante e che Writer lo corregga conservando le battute già valide. Il limite di Codex dovrebbe restare una rifinitura localizzata finale, non una riscrittura della scena.

## Campioni e tracciabilità

- [Manifest dei test, prompt hash e statistiche CLI](C:/Users/Shadow/.lmstudio/production-tests/writer-model-comparison/benchmark-results.json)
- [Campione Hemmingway](C:/Users/Shadow/.lmstudio/production-tests/writer-model-comparison/hemmingway-scaffold.md)
- [Campione Qwen abbinato](C:/Users/Shadow/.lmstudio/production-tests/writer-model-comparison/writer-scaffold.md)
- [Campione Mistral più lungo](C:/Users/Shadow/.lmstudio/production-tests/writer-model-comparison/mistral-lengthguard.md)
- [Scheda Qwen del publisher](https://huggingface.co/llmfan46/Qwen3.5-27B-Writer-V2-uncensored-heretic-GGUF)
- [Scheda Hemmingway del publisher](https://huggingface.co/JohnDi/Hemmingway-1-Abliterated-Extreme-GGUF)
- [Scheda ufficiale Mistral](https://huggingface.co/mistralai/Mistral-Small-3.2-24B-Instruct-2506)
