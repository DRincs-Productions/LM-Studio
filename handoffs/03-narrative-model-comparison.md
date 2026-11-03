# Handoff 03 — Confronto modelli narrativi

**Stato:** piano di valutazione, non implementato.  
**Ambito:** test isolati del Writer narrativo su Shadow con LM Studio; nessuna sostituzione automatica del modello operativo.

## Obiettivo

Confrontare nuovi modelli narrativi con il Writer attualmente operativo (**Hemmingway 1 Abliterated Extreme**) e con i risultati storici disponibili. L'obiettivo è trovare un modello che produca prosa naturale, atmosfera e introspezione, mantenga continuità e ritmo graduale e **non inventi svolte narrative non previste** dal `SceneContract`. Valutare anche scene drammatiche e contenuti adulti consensuali, senza dare per scontato che un modello sia privo di rifiuti o alterazioni.

## Candidati e ordine iniziale

### 1. Hearthfire 24B — primo da provare

- **Autore/famiglia dichiarati:** LatitudeGames; 24B; Mistral Small 3.2.
- **Motivo della prova:** modello presentato per narrativa lunga, atmosfera, introspezione e progressione graduale, con esempi di continuazione di circa 8–16K token.
- **Ipotesi da verificare:** capacità di sviluppare la scena senza introdurre eventi o colpi di scena estranei al contratto.
- **Rischi da testare:** prevalenza di seconda persona e tempo presente nei dati/stile dichiarati; aderenza al POV richiesto e capacità di fermarsi all'endpoint esatto.
- **Scheda:** https://huggingface.co/LatitudeGames/Hearthfire-24B

### 2. Magidonia 24B v4.3

- **Autore/famiglia dichiarati:** TheDrummer; 24B; linea Magistral/Mistral.
- **Motivo della prova:** candidato orientato a scrittura creativa e roleplay, con attenzione dichiarata a qualità della prosa, dinamismo, coerenza e istruzioni.
- **Ipotesi da verificare:** alternativa a Cydonia per scene drammatiche, violente e revisioni circoscritte. La provenienza dallo stesso autore **non** dimostra equivalenza con Cydonia.
- **GGUF:** https://huggingface.co/bartowski/TheDrummer_Magidonia-24B-v4.3-GGUF

### 3. Venice Role Play Uncensored 24B

- **Autore/famiglia dichiarati:** Dolphin / Venice; 24B.
- **Motivo della prova:** modello orientato a roleplay e avventure narrative, presentato con buone capacità di seguire istruzioni; documentazione da verificare su continued pretraining e fine-tuning.
- **Ipotesi da verificare:** gestione di scene adulte consensuali e cruente mantenendo il rispetto del `SceneContract`. Il nome “Uncensored” **non garantisce** assenza di rifiuti né qualità editoriale.
- **GGUF:** https://huggingface.co/dphn/Venice-Role-Play-Uncensored-GGUF

### 4. Gemory 26B-A4B

- **Famiglia dichiarata:** Gemma 4; MoE; circa 4B parametri attivi.
- **Motivo della prova:** fine-tune presentato per scrittura creativa, voce dei personaggi, dialoghi, continuità e progressione della scena; utile per confrontare una famiglia differente dai Mistral 24B.
- **Verifiche preliminari:** architettura e template chat, supporto della versione installata di LM Studio, caricamento del GGUF, memoria effettiva e qualità della quantizzazione.
- **GGUF:** https://huggingface.co/UltimateIntent/Gemory-26B-A4B-GGUF

> Le descrizioni dei modelli sono ipotesi tratte dalle rispettive presentazioni, **non risultati verificati**. Controllare model card, licenze, provenienza, varianti GGUF e requisiti prima del download. I collegamenti a immagini illustrative non sono necessari al protocollo di test.

## Protocollo di confronto

1. **Baseline riproducibile:** riutilizzare, quando disponibili, i brief, `SceneContract`, esempi e criteri dei confronti narrativi già documentati nel repository. Non modificare canone, prompt e criteri tra candidati.
2. **Casi di prova:** scena lenta e introspettiva; dialogo con voci distinte; tensione e violenza narrativa; contenuti adulti consensuali ammessi; revisione localizzata; scena con POV, tempo verbale ed endpoint rigidamente specificati.
3. **Misure:** aderenza al contratto (fatti, conoscenze, divieti, beat, finale); invenzioni e colpi di scena non richiesti; continuità; qualità della prosa; ritmo; voci dei personaggi; errori di POV; rifiuti o attenuazioni non richieste; latenza, token/s e uso di RAM/VRAM.
4. **Configurazione:** registrare modello e revisione esatta, GGUF/quantizzazione, versione di LM Studio, template, contesto, parametri di sampling, seed quando applicabile e limiti hardware. Confrontare a parità di condizioni per quanto possibile.
5. **Esito:** conservare esempi e punteggi motivati in un rapporto comparativo; segnalare i casi non comparabili o non eseguibili. **Hearthfire è il primo test**, non il vincitore designato.

## Integrazione e vincoli

- I test sono **isolati**: non modificano la pipeline dello Scrittore né il modello Writer operativo senza una decisione successiva.
- **Qwen3 8B rimane il Narrative Reviewer**. L'eventuale confronto Gemini/Qwen3 per la review è una valutazione separata, descritta nell'handoff 01.
- Il Coordinatore Rust gestirà i job e le risorse; evitare di caricare contemporaneamente modelli che superano la VRAM disponibile.
- Non cancellare modelli già installati, dati, configurazioni o file condivisi per fare spazio senza una verifica e approvazione esplicita.
- Questo handoff è generale e non presuppone un prodotto visual novel. Le scene narrative sono semplicemente uno dei casi d'uso del sistema.
