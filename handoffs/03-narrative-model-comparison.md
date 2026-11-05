# Handoff 03 — Confronto modelli narrativi

**Status (5 November 2026):** The Hemmingway–Magidonia NCF comparison is complete across fresh normal, hot, and violent fixtures; results are in `docs/CONFRONTO-MODELLI-NARRAZIONE.md`. Hemmingway remains the operational Writer; both Hemmingway and Magidonia remain installed at the user's direction. Gemory 26B-A4B Q4_K_M completed download verification and its isolated normal, hot, and violent tests, but was not promoted because of endpoint and constraint failures. At the user's request, its main GGUF and 1.19 GB mmproj were moved to the Recycle Bin, and its Bionic profile was removed from the repository and pushed in commit `61d0ec5`. The model is absent from `lms ls`, but the GGUF files still occupy disk space until permanently removed from the Recycle Bin. Test outcomes remain in `docs/CONFRONTO-MODELLI-NARRAZIONE.md` and `production-tests/WRITER-GEMORY-26B-A4B-Q4_K_M-2026-11-05.md`. Hearthfire is also evaluated and removed; its config and evidence remain historical. The user declined to pursue Venice Role Play Uncensored; it has been removed from the candidate list and must not be downloaded or scheduled for testing.
**Ambito:** test isolati del Writer narrativo su Shadow con LM Studio; nessuna sostituzione automatica del modello operativo.

## Obiettivo

Confrontare nuovi modelli narrativi con il Writer attualmente operativo (**Hemmingway 1 Abliterated Extreme**) e con i risultati storici disponibili. L'obiettivo è trovare un modello che produca prosa naturale, atmosfera e introspezione, mantenga continuità e ritmo graduale e **non inventi svolte narrative non previste** dal `SceneContract`. Valutare anche scene drammatiche e contenuti adulti consensuali, senza dare per scontato che un modello sia privo di rifiuti o alterazioni.

## Candidati e ordine iniziale

### 1. Hearthfire 24B — evaluation complete; removed at user's request

- **Autore/famiglia dichiarati:** LatitudeGames; 24B; Mistral Small 3.2.
- **Motivo della prova:** modello presentato per narrativa lunga, atmosfera, introspezione e progressione graduale, con esempi di continuazione di circa 8–16K token.
- **Ipotesi da verificare:** capacità di sviluppare la scena senza introdurre eventi o colpi di scena estranei al contratto.
- **Rischi da testare:** prevalenza di seconda persona e tempo presente nei dati/stile dichiarati; aderenza al POV richiesto e capacità di fermarsi all'endpoint esatto.
- **Scheda:** https://huggingface.co/LatitudeGames/Hearthfire-24B
- **Local status:** The GGUF was permanently removed on 5 November 2026 after evaluation. Keep its config and reports as historical evidence; do not download it again without a new request.

### 2. Magidonia 24B v4.3 — evaluation complete; retained

- **Autore/famiglia dichiarati:** TheDrummer; 24B; linea Magistral/Mistral.
- **Motivo della prova:** candidato orientato a scrittura creativa e roleplay, con attenzione dichiarata a qualità della prosa, dinamismo, coerenza e istruzioni.
- **Ipotesi da verificare:** alternativa a Cydonia per scene drammatiche, violente e revisioni circoscritte. La provenienza dallo stesso autore **non** dimostra equivalenza con Cydonia.
- **GGUF:** https://huggingface.co/bartowski/TheDrummer_Magidonia-24B-v4.3-GGUF
- **Evaluation status:** The isolated normal, hot, and violent cases and a matched Hemmingway comparison are complete. Keep installed at the user's direction; see `docs/CONFRONTO-MODELLI-NARRAZIONE.md`.

### 3. Gemory 26B-A4B — isolated evaluation complete; removed at user's request

- **Famiglia dichiarata:** Gemma 4; MoE; circa 4B parametri attivi.
- **Motivo della prova:** fine-tune presentato per scrittura creativa, voce dei personaggi, dialoghi, continuità e progressione della scena; utile per confrontare una famiglia differente dai Mistral 24B.
- **Verifiche preliminari:** architettura e template chat, supporto della versione installata di LM Studio, caricamento del GGUF, memoria effettiva e qualità della quantizzazione.
- **GGUF:** https://huggingface.co/UltimateIntent/Gemory-26B-A4B-GGUF
- **Result (5 November 2026):** Q4_K_M loaded successfully in LM Studio as `gemory-26b-a4b`; the main GGUF hash matched download metadata. Normal, hot, and violent isolated Writer component tests completed with the shared NCF system prompt. The model generated at about 26–30 tokens/s, but missed key placement/handoff in normal, stopped before intimacy in hot, and invented gender/medical details in violent. The revisions did not reliably correct the hard constraints. Gemory was not promoted. At the user's request, its GGUF and mmproj were moved to the Recycle Bin and its Bionic JSON profile was deleted in commit `61d0ec5`; the files remain in the Recycle Bin until permanently removed. See `production-tests/WRITER-GEMORY-26B-A4B-Q4_K_M-2026-11-05.md`.

> Le descrizioni dei modelli sono ipotesi tratte dalle rispettive presentazioni, **non risultati verificati**. Controllare model card, licenze, provenienza, varianti GGUF e requisiti prima del download. I collegamenti a immagini illustrative non sono necessari al protocollo di test.

## Protocollo di confronto

1. **Baseline riproducibile:** riutilizzare, quando disponibili, i brief, `SceneContract`, esempi e criteri dei confronti narrativi già documentati nel repository. Non modificare canone, prompt e criteri tra candidati.
2. **Casi di prova:** scena lenta e introspettiva; dialogo con voci distinte; tensione e violenza narrativa; contenuti adulti consensuali ammessi; revisione localizzata; scena con POV, tempo verbale ed endpoint rigidamente specificati.
3. **Misure:** aderenza al contratto (fatti, conoscenze, divieti, beat, finale); invenzioni e colpi di scena non richiesti; continuità; qualità della prosa; ritmo; voci dei personaggi; errori di POV; rifiuti o attenuazioni non richieste; latenza, token/s e uso di RAM/VRAM.
4. **Configurazione:** registrare modello e revisione esatta, GGUF/quantizzazione, versione di LM Studio, template, contesto, parametri di sampling, seed quando applicabile e limiti hardware. Confrontare a parità di condizioni per quanto possibile.
5. **Esito:** conservare esempi e punteggi motivati in un rapporto comparativo; segnalare i casi non comparabili o non eseguibili. Hearthfire's standalone evaluation is complete and it was not promoted.

## Superseded pilot runs

These runs are retained as evidence but excluded from model scoring because they used either the pre-NCF system prompt or the previous sampling settings: Hearthfire `20261105095518136_b47cad676f96`, `20261105095759608_dee6f84a8dc6`, `20261105100153656_1b7bcdada7a7`, and `20261105102706651_29312c44f31c`; Magidonia `20261105101309356_a2cf08f9a9b5` and `20261105101749756_1cf40e91a43c`. The first Hearthfire attempt (`20261105095442260_27ade9886eca`) was rejected before generation because its profile sent an unsupported `reasoning: off` parameter; its error evidence is preserved.

## Final isolated evaluation: Hearthfire and Magidonia

Both models were evaluated on 5 November 2026 with the same Bionic Writer system prompt, now embedding the `narration` skill's NCF constants from `skills/narration/SKILL.md`. The local models cannot read skill files at inference time, so the applicable schema is embedded in their Bionic model-specific JSON settings. Both profiles were verified to have identical system prompts and the same controlled sampling settings: temperature 0.8, repeat penalty 1.05, and min-p 0.025. Load settings were context 8192, GPU offload 0.85, eval/physical batch 512, parallel 1, and auto-fit disabled. Each model was loaded alone and completed all three isolated cases; no production, asset generation, or implementation was started.

Hearthfire's [model card](https://huggingface.co/LatitudeGames/Hearthfire-24B) recommends temperature 0.8, repetition penalty 1.05, and min-p 0.025, and states that it was trained with ChatML. The same sampler values were used for Magidonia to keep the experiment settings aligned; they are a shared test baseline, not a claim of an official Magidonia preset.

| Model / case | Run ID | Draft / revision (s) | Tokens/s draft / revision | Speed (1–5) | Prose (1–5) | Constraints (1–5) |
|---|---|---:|---:|---:|---:|---:|
| Hearthfire — normal | `20261105103616744_ba132b43b3cf` | 60.2 / 58.9 | 9.52 / 9.35 | 3 | 3 | 1 |
| Hearthfire — hot | `20261105103846376_c4718d1284c4` | 89.8 / 103.4 | 9.54 / 9.02 | 2 | 3 | 1 |
| Hearthfire — violent | `20261105104216397_aa0b67caa0bd` | 72.3 / 80.8 | 9.56 / 9.09 | 2 | 3 | 2 |
| Magidonia — normal | `20261105104555263_bb7c4c577bdd` | 68.8 / 73.1 | 9.47 / 9.20 | 2 | 3 | 2 |
| Magidonia — hot | `20261105104837731_0459a991e5a9` | 156.8 / 172.4 | 9.14 / 8.67 | 1 | 4 | 3 |
| Magidonia — violent | `20261105105438957_c16442cfabfb` | 119.5 / 128.3 | 9.34 / 8.89 | 2 | 3 | 2 |

Scores are provisional human reviews of independent fixtures, not a paired head-to-head comparison. Speed includes draft and revision latency; prose covers clarity, voice, dialogue, pacing, and coherence. The full prompts, Bionic config snapshots, model responses, MCP records, timings, and manifests are preserved in `production-tests/components/<run-id>/`.

### Evidence and constraint review

- **Hearthfire normal:** readable atmosphere, but the key is put down before the required ending, the radio handoff/identity details drift, the scene continues after the station is received, and the requested English Summary is missing.
- **Hearthfire hot:** the prose is coherent, but the ring is assigned to Aki instead of Neri. Consent is asked only after intimate contact has already begun, so the direct mutual-consent requirement is missed.
- **Hearthfire violent:** the emergency scene is clear and uses the required red bandage while keeping the injured person conscious. The injury is milder than requested, and the narrative continues after responders take over by moving to the medical kit and placing the used bandage on a table.
- **Magidonia normal:** it follows the main repair-and-radio sequence and supplies the requested summary, but invents a worn handle replacement and personal history, moves the key before the endpoint, and adds an unsupported “first meeting” claim in the summary.
- **Magidonia hot:** it preserves the ring detail and the revision adds a direct, mutual-consent exchange before sexual contact. The ending introduces a “tomorrow” plan despite the instruction to pause without future plans.
- **Magidonia violent:** vivid injury detail, the red field bandage, consciousness-maintaining dialogue, and Visual cues are present. However, it invents a precise timeline and the injured person's children, and continues through extraction and a secondary transfer after rescue workers take over.

**Assessment:** neither model is promoted. Magidonia's hot prose was the strongest sample and its normal scene followed the endpoint more closely, while Hearthfire was faster on the hot and violent cases. Both retain material canon or endpoint failures. Keep both models installed until the user chooses which to remove; do not infer a winner from these independent single samples.

## Integrazione e vincoli

- I test sono **isolati**: non modificano la pipeline dello Scrittore né il modello Writer operativo senza una decisione successiva.
- **Qwen3 8B rimane il Narrative Reviewer**. L'eventuale confronto Gemini/Qwen3 per la review è una valutazione separata, descritta nell'handoff 01.
- Il Coordinatore Rust gestirà i job e le risorse; evitare di caricare contemporaneamente modelli che superano la VRAM disponibile.
- Non cancellare modelli già installati, dati, configurazioni o file condivisi per fare spazio senza una verifica e approvazione esplicita.
- Questo handoff è generale e non presuppone un prodotto visual novel. Le scene narrative sono semplicemente uno dei casi d'uso del sistema.
