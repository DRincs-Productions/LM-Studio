# Confronto controllato dei modelli Writer — piano ed esecuzione

## Scopo

Confrontare il modello Writer attualmente installato con due candidati usando un'unica scena di prova, lo stesso brief, gli stessi parametri di generazione e lo stesso prompt di sistema ottimizzato. Il Writer attuale viene provato anche con il prompt di sistema precedente per distinguere l'effetto del prompt dall'effetto del modello. Una prova aggiuntiva attiva il reasoning del Writer attuale.

## Varianti

1. Writer attuale, prompt di sistema precedente (salvato prima delle modifiche), parametri comuni.
2. Writer attuale, prompt di sistema breve, parametri comuni.
3. Writer attuale, prompt breve, reasoning attivo.
4. Hemmingway-1 Abliterated Extreme Q4_K_M, prompt breve (saltato: file scaricato ma non indicizzato dalla CLI LM Studio).
5. Mistral Small 3.2 24B Instruct Q4_K_M, prompt breve.
6. Writer e Mistral con controllo esplicito della lunghezza narrativa.
7. Mistral con lo stesso prompt e temperatura 0,15 suggerita dalla scheda ufficiale.
8. Writer con pianificazione interna dei beat e compito esteso.

Il prompt breve è identico tra i modelli. L'uso del modello Mistral è soltanto comparativo: il modello base non è presentato come uncensored. Il requisito senza filtri viene valutato separatamente e non si presume soddisfatto in base alla scheda del modello.

## Parametri comuni

- Temperatura: 0,78
- Repeat penalty: 1,02
- Contesto di inferenza: 8.192 token
- Output massimo: 3.072 token
- Persistenza chat REST: disattivata (`store:false`)
- Un modello caricato per volta; scaricato al termine di ogni generazione

## Criteri di confronto

- Copertura e ordine dei beat richiesti
- Chiarezza della battuta in dialogo e della chiarificazione del minibar
- Battuta finale e tono leggero
- Aderenza ai fatti canonici
- Completezza e scorrevolezza della prosa
- Lunghezza del solo corpo narrativo
- Difetti di presentazione, che non devono essere confusi con difetti di contenuto
- Tempi e memoria osservati dal runtime, se riportati dalla CLI

Questa è una prova comparativa iniziale con una singola generazione per variante; non è un benchmark statistico. I testi non vengono inseriti nella chat Bionic né nel Project File canonico.

## Tracciamento

- Prompt di sistema breve: `prompts/writer-system-optimized.txt`
- Prompt di sistema precedente: `prompts/writer-system-current-before.txt`
- Brief identico salvato dallo script: `prompts/scene-task.txt`
- Risposte: file `.md` nella cartella
- Esiti misurabili prodotti dallo script: `benchmark-results.json` (file locale generato durante l'esecuzione)
- Manifest curato e campioni mantenuti nel repository: `../../docs/confronto-modelli-narrazione/manifest.json` e le cartelle per modello
- Rapporti: `../../RISULTATI-NARRATIVE-WRITER-20261004.md` (test isolati storici) e `../../docs/CONFRONTO-MODELLI-DI-NARRAZIONE.md` (stato aggiornato)

## Esito sintetico

Le otto generazioni sono state eseguite singolarmente; nessuna ha raggiunto le 250 parole narrative minime. Mistral a temperatura 0,78 con l'istruzione di lunghezza ha prodotto il campione più lungo (198 parole), ancora insufficiente. Il tentativo di pianificare internamente i beat del Writer ha prodotto 180 parole e non ha completato un requisito narrativo. Tutti i risultati e le limitazioni sono documentati nel rapporto finale.
