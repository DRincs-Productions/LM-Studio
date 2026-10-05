# Progetto Audio Worker — requisiti e architettura proposta

Aggiornato: 4 ottobre 2026. Audio Worker MCP implementato e registrato in Codex; questo stato operativo aggiorna la proposta iniziale descritta sotto. I modelli ACE-Step 1.5 XL SFT, Stable Audio 3 Medium e Stable Audio 3 Small SFX sono stati scaricati.

## Stato verificato

- Esistono `image-worker`, `asset-worker` e Audio Worker MCP in `C:\Users\Shadow\.lmstudio`.
- `C:\Users\Shadow\.lmstudio\audio\mcp` contiene il server MCP e gli strumenti audio. Nessun audio di prova è stato lasciato nella cartella degli asset.
- I pesi ACE-Step XL SFT sono presenti ma il suo runtime non è installato. Stable Audio 3 TFLite CPU è installato con Medium e Small SFX; è stata generata e verificata una prova audio.
- Image Worker usa `C:\AI\image-worker\models` per i modelli e `C:\Users\Shadow\.lmstudio\image-worker\work` per il lavoro locale; gli asset finali sono in `C:\AI\image-worker\output\final` e sono trasferiti in `C:\AI\assets\<PROJECT_ID>\...`.
- Asset Worker immagini è rimasto invariato; Audio Worker ha una pubblicazione dedicata e allowlistata per musica ed effetti.
- Il remote rclone `imagecloud:` è un OneDrive Personal. La radice conteneva `ImageWorker`; sono stati creati `AudioWorker/SoundEffects/final` e `AudioWorker/Music/final` su OneDrive.
- La GPU è NVIDIA RTX A4500 con 20 GB. Alla verifica del 4 ottobre 2026 `lms ps` non ha trovato modelli caricati; `nvidia-smi` mostrava 599 MiB occupati dal sistema e circa 19,6 GiB liberi. L’Audio Worker dovrà comunque rispettare l’esclusività VRAM e non caricare nulla mentre Regia occupa memoria.

## Decisioni di responsabilità

1. **Regia decide il significato creativo.** Nella narrazione usa `Sound:` per un effetto/ambiente e `Music:` per la musica. Specifica quale sensazione o evento deve comunicare.
2. **Codex prepara la scheda tecnica dell’asset.** Traduce l’intento in una richiesta Audio Worker collegata a scena, luogo, personaggi e asset canonici. Propone one-shot o loop in base all’uso previsto; se il comportamento non è chiaro, torna da Regia invece di inventarlo.
3. **Claude riceve il comportamento già esplicito.** Il handoff d’implementazione deve riportare `category`, `loop`, motivazione, trigger, condizioni di stop, durata prevista, eventuali loop point e path/hash del file. Claude non deve dedurre il loop dalla lunghezza del WAV o dal nome del file.
4. **Audio Worker genera e verifica il file.** Non sceglie autonomamente se il contenuto è musica o effetto e non decide la semantica narrativa.

## Contratto per ogni cue audio

Un manifest JSON operativo affianca il Project File canonico e contiene, per ogni cue:

- ID stabile, project ID, scene ID, categoria `sound_effect` / `music` e descrizione dell’intento;
- `loop: true|false`, motivazione, trigger e condizioni di avvio/arresto;
- durata desiderata; per un loop, loop-start/end e verifica della transizione;
- asset di riferimento esistenti per ID, path e SHA256, con modalità di riuso (`variation`, `audio_to_audio`, `inpaint`, `continuation` o solo riferimento stilistico);
- modello/versione e prompt effettivo;
- esito del controllo tecnico e d’ascolto, stato di approvazione, path finale e hash locale/remoto;
- licenza del modello e note di attribuzione quando necessarie.

Il Project File resta la fonte canonica del mondo narrativo; il manifest è il registro operativo degli audio, non una copia della lore.

## Struttura proposta

**Worker e modelli locali**

- MCP Audio Worker: `C:\Users\Shadow\.lmstudio\audio\mcp` (riusa la cartella audio vuota già presente)
- modelli/runtime e cache: `C:\AI\audio-worker\models` e `C:\Users\Shadow\.lmstudio\audio\worker\work`

**Asset locali per progetto**

- `C:\AI\assets\<PROJECT_ID>\Audio\SoundEffects\...`
- `C:\AI\assets\<PROJECT_ID>\Audio\Music\...`
- manifest vicino agli asset: `C:\AI\assets\<PROJECT_ID>\Audio\audio-manifest.json`

**OneDrive via remote già configurato**

- `imagecloud:AudioWorker/SoundEffects/final/<PROJECT_ID>/...`
- `imagecloud:AudioWorker/Music/final/<PROJECT_ID>/...`

Il publish deve verificare presenza e hash sul remoto. Nessuna cancellazione remota automatica. I due rami SoundEffects e Music restano distinti sia localmente sia su OneDrive; quello esistente `ImageWorker/final` non si modifica.

## Qualità e workflow

Per ogni cue: preparazione del brief usando Project File e asset già accettati → generazione di più candidati → ascolto/review semantica → controlli tecnici → correzione mirata → approvazione → finalizzazione e publish. Non basta un punteggio automatico per dichiarare un audio buono.

Controlli tecnici minimi: file decodificabile, durata/formato/canali conformi al brief, silenzio o clipping indesiderati, picchi anomali, hash e corrispondenza tra preview e file finale.

- **One-shot:** attacco leggibile, coda naturale, niente ripetizione artificiale.
- **Loop:** il Worker deve creare o individuare punti di loop, rendere la giunzione continua e verificare più ripetizioni consecutive. Un crossfade automatico è ammesso solo se non rovina transienti o ritmo; loop points e risultato devono essere ascoltabili e riportati nel manifest.
- **Musica:** valutare mood, strumentazione, dinamica, coerenza con la scena, ripetizioni, variazioni e se il loop resta naturale.
- **Sound effect/ambiente:** valutare corrispondenza all’evento, chiarezza, spazio, coda e assenza di elementi musicali o vocali non richiesti.

Conservare un master WAV non compresso; produrre un formato compresso di gioco solo quando il runtime/engine di destinazione è definito. Normalizzare o limitare i livelli solo secondo uno standard di mix concordato, evitando di schiacciare dinamicamente i singoli cue.

## Selezione dei modelli orientata alla qualità

Non conviene imporre un unico generatore: scegliere per ogni cue in base alla resa e al fatto che sia musica/effetto e loop/one-shot.

| Caso | Modello candidato | Valutazione e stato |
|---|---|---|
| Musica e composizioni | **ACE-Step 1.5 XL SFT** | Prima scelta locale da provare: variante XL a 4B con controllo CFG; la scheda del modello la classifica come “Very High” qualità. Scaricato in `C:\AI\audio-worker\models\ACE-Step\acestep-v15-xl-sft` (18,58 GiB). Il requisito dichiarato è ≥16 GB con CPU offload; l’A4500 ha 20 GB, quindi configurare offload per mantenere margine e misurare l’uso effettivo. Licenza MIT. Non è un modello SFX dedicato e il risultato va confrontato all’ascolto. [Scheda ufficiale XL SFT](https://huggingface.co/ACE-Step/acestep-v15-xl-sft), [installazione e compatibilità GPU](https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/INSTALL.md). |
| Musica, editing e SFX locali | **Stable Audio 3 Medium** | Candidato locale versatile da confrontare con ACE-Step per qualità; gestisce musica, stems/strumenti, SFX, audio-to-audio e inpainting/continuazione. Scaricato in `C:\AI\audio-worker\models\Stable-Audio-3\medium` (9,73 GiB). **Non crea automaticamente un loop garantito**: nessun loop point viene restituito. [Modelli e capacità](https://github.com/Stability-AI/stable-audio-3), [model card Medium](https://huggingface.co/stabilityai/stable-audio-3-medium), [nota ufficiale sulla preparazione dei loop](https://stability.ai/explainers/adaptive-procedural-game-soundtrack-ai-what-it-is-and-where-the-model-fits). |
| Effetti e atmosfere locali | **Stable Audio 3 Small SFX** | Modello specializzato SFX, scaricato in `C:\AI\audio-worker\models\Stable-Audio-3\small-sfx` (3,25 GiB). È un candidato di confronto, ma non va scelto sopra Medium senza prova d’ascolto. [Model card Small SFX](https://huggingface.co/stabilityai/stable-audio-3-small-sfx), [compatibilità ufficiale](https://github.com/Stability-AI/stable-audio-3/blob/main/docs/guides/prompting.md). |
| Effetti con loop esplicito | **ElevenLabs Sound Effects v2** | Riferimento esterno specializzato: API espone `loop=true` e dichiara generazione seamless per gli effetti. Non è locale né scaricabile; richiede credenziali e costi per API. Lo includerei solo se test d’ascolto giustifica servizio e costo. [API ufficiale](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert). |
| Musica in loop | **ACE-Step/Stable Audio + preparazione del loop**, confronto eventuale **LoopGen** | Nessuna delle due scelte locali promette giunte musicali pulite per ogni output. LoopGen è ricerca/inferenza basata su MAGNeT (MIT), non un checkpoint autonomo che copre l’intero Audio Worker; mantenerlo sperimentale fino a quando l’integrazione e la qualità siano dimostrate. [Paper LoopGen](https://arxiv.org/abs/2504.04466), [codice ufficiale](https://github.com/gladia-research-group/loopgen). |

La selezione locale iniziale dunque è **ACE-Step XL SFT per musica + Stable Audio 3 Medium per confronto multiuso + Small SFX come sfidante per effetti**. Small SFX non viene scartato solo per essere più piccolo; lo si mantiene se il suo ascolto risulta migliore in uno specifico tipo di cue. ElevenLabs resta un’opzione API, non una dipendenza decisa. Non sono stati scaricati altri modelli e non ci sono modelli audio scartati da rimuovere.

L’utente ha approvato le condizioni dei repository Stable Audio e l’accesso Hugging Face è stato usato localmente per i download. Il token non è stato copiato nel progetto né esposto nei log del riepilogo.

**Loop:** un loop è una specifica di produzione e verifica, non un attributo che si deduce dal nome, dalla durata o dal modello scelto. Claude riceverà sempre `loop`, motivazione, trigger/stop, loop points e risultato dell’ascolto ripetuto. Rifiutare o rigenerare i loop con giunzioni percepibili; non spacciare crossfade o zero-crossing da soli per prova di continuità musicale.

Le schede Stable Audio richiedono inoltre l’accettazione dell’accordo Stability e dei Gemma Terms per il componente T5Gemma. L’account deve sbloccare i repository prima del download. Per uso commerciale controllare la Stability AI Community License e la soglia/condizioni applicabili; la licenza non è una raccomandazione a distribuire senza verificare il caso d’uso. [Termini del repository Medium](https://huggingface.co/stabilityai/stable-audio-3-medium), [licenza Stability AI](https://stability.ai/license).

## Aggiornamento operativo: backend audio.cpp — 4 ottobre 2026

Su richiesta dell’utente il runtime di generazione del Worker è stato spostato a **audio.cpp**, mantenendo gli stessi tool MCP, il formato dei manifest, l’archiviazione locale e i due rami OneDrive. L’Image Worker usa `sd-cli.exe`; l’Audio Worker ora richiama `audiocpp_cli.exe` tramite un backend nativo, senza passare dalla UI di LM Studio.

- Runtime installato: audio.cpp **v0.9.0**, pacchetto Windows x64 Vulkan, in `C:\Users\Shadow\.lmstudio\audio\audio.cpp\v0.9.0-vulkan`.
- GPU rilevata dal backend: NVIDIA RTX A4500 (Vulkan). Il test backend elenca anche la CPU AMD EPYC 7543P.
- Modello musica: Stable Audio 3 Medium Q8 GGUF, 3.58 GB, in `C:\AI\audio-worker\models\audio.cpp\Stable-Audio-3-Medium`.
- Modello effetti: Stable Audio 3 Small SFX Q8 GGUF, 1.68 GB, in `C:\AI\audio-worker\models\audio.cpp\Stable-Audio-3-Small-SFX`.
- I modelli e il runtime TFLite/ACE-Step già presenti non sono stati rimossi; sono conservati finché non sarà verificato l’intero ciclo con audio.cpp e ascoltato il risultato.
- Il server MCP aggiornato controlla che CLI e modello richiesto esistano, lancia `--task gen --family stable_audio --backend vulkan`, passa durata/seed/steps, abilita `stable_audio.mem_saver=true` e poi usa gli strumenti esistenti per controllo WAV, manifest, anteprima, finalizzazione e pubblicazione.

### Prova e cue del test Grand Hotel

- Il CLI ha rilevato la RTX A4500 e ha caricato con successo Small SFX Q8. Una prova tecnica isolata di 8 secondi è riuscita in circa 17 secondi; il file è stato archiviato tra i vecchi test temporanei.
- Il server MCP aggiornato ha generato il candidato **SFX-01** (campanello, 4 s): WAV stereo PCM 16-bit, 44.1 kHz, nessun clipping; SHA-256 `e63ce5c20db30bd6cc29e04e782d2fa956515e1af317a5c873ead7978473d5d7`.
- Il server MCP aggiornato ha generato il candidato **MUSIC-01** (musica lounge, 30 s): WAV stereo PCM 16-bit, 44.1 kHz, nessun clipping; SHA-256 `19c0a4ea19bd8382229e3ba3984ffa048822f63fc206d7b67068b80a32b1ac60`.
- È stata creata un’anteprima di quattro ripetizioni (120 s) per ascoltare la giunzione: `C:\Users\Shadow\.lmstudio\audio\worker\work\loop-previews\MUSIC-01-grand-hotel-lobby-2026-10-04T21-25-35-206Z-loop-preview-1791149158782.wav`.
- Le metriche diagnostiche del brano mostrano una differenza tra i bordi (RMS primi 100 ms `0.1808135`, ultimi 100 ms `0.0000538`); questo può rendere percepibile la giunzione. L’anteprima va ascoltata e il loop non è ancora approvato. Nessuno dei due candidati è stato finalizzato o caricato su OneDrive.
- I file audio candidati e i manifest si trovano nei rispettivi job sotto `C:\Users\Shadow\.lmstudio\audio\worker\work\jobs\9b1b33e8-f40c-464a-bf7c-07fbcba71282\grand-hotel-check-in`.

### Pulizia di C:\AI

Il codice del Worker e i file temporanei sono stati spostati fuori da `C:\AI`; la cartella conserva i modelli, gli asset finali, il Project File e i relativi dati persistenti.

- Audio Worker MCP: `C:\Users\Shadow\.lmstudio\audio\mcp`; runtime TFLite/ACE-Step e staging: `C:\Users\Shadow\.lmstudio\audio\worker`; audio.cpp: `C:\Users\Shadow\.lmstudio\audio\audio.cpp`.
- Modelli audio, inclusi i nuovi GGUF: `C:\AI\audio-worker\models`.
- Image Worker MCP: `C:\Users\Shadow\.lmstudio\image-worker\mcp`; binari e staging: `C:\Users\Shadow\.lmstudio\image-worker\bin` e `...\work`.
- Modelli immagini e immagini finali restano in `C:\AI\image-worker\models` e `...\output\final`; asset di progetto in `C:\AI\assets`; Project File in `C:\AI\bionic\projects`.
- I candidati temporanei audio del progetto sono stati trasferiti insieme allo staging e i loro manifest aggiornati ai nuovi percorsi. I vecchi campioni di test/trasferimento e i precedenti file temporanei dell’Image Worker sono archiviati, senza cancellazione, in `C:\Users\Shadow\.lmstudio\archive\ai-cleanup-20261004`.
- Copie di ripristino dei tre server/tool Python precedenti alla rilocazione sono in `...\archive\ai-cleanup-20261004\server-backups`. Il server Audio Worker attivo nella sessione Codex è stato arrestato durante l’aggiornamento: la configurazione ora punta a `node.exe` e al nuovo `server.mjs`; Codex deve riaprire la sessione per avviare i server MCP aggiornati.
- Verifiche post-spostamento: processo audio MCP avviato direttamente ha confermato CLI, due GGUF, runtime TFLite precedente, rclone e RTX A4500; `inspect_audio` ha riletto entrambi i WAV dai nuovi percorsi. Processo Image Worker avviato direttamente ha confermato `sd-cli.exe`, entrambi i checkpoint, le cartelle di staging e il remote `imagecloud:`. `sd-cli.exe --help`, controlli di sintassi JavaScript e parsing Python sono riusciti. La configurazione globale Audio Worker è stata ricreata e `codex mcp get audio-worker` la mostra attiva; l’host Codex di questa sessione conserva però il trasporto MCP precedente, quindi il riavvio di Codex è necessario per riagganciare i tool.

### Riferimenti upstream

- [Repository audio.cpp](https://github.com/0xShug0/audio.cpp), [release v0.9.0](https://github.com/0xShug0/audio.cpp/releases/tag/v0.9.0)
- [Guida Stable Audio di audio.cpp](https://github.com/0xShug0/audio.cpp/blob/main/docs/models/stable_audio.md), [pacchetti GGUF](https://huggingface.co/audio-cpp/audio.cpp-gguf)

## Passi di implementazione proposti

1. Installare runtime d’inferenza compatibili con Windows per Stable Audio 3 e ACE-Step; configurare CPU offload per ACE-Step XL sulla A4500.
2. Verificare che ciascun checkpoint si carichi; misurare VRAM e tempo senza avviare contemporaneamente Regia.
3. Benchmark cieco con brief identici: musica one-shot/loop, effetto one-shot/loop e riuso di una reference canonica; ascoltare i loop ripetuti e annotare qualità, aderenza, artefatti, VRAM e tempo.
4. Solo dopo il benchmark, fissare modello/runtime per ciascun tipo di cue, durata e formati.
3. Implementare MCP Audio Worker separato dall’Image Worker; riusare Project Worker per contesto/proprietà e asset IDs, senza collegare modelli audio a LM Studio se non necessario.
4. Estendere Asset Worker con operazioni audio esplicitamente allowlistate o creare un transfer helper limitato ai due rami AudioWorker; mantenere immutata la policy immagini.
5. Aggiungere le chiamate autorizzate alla pipeline Codex e passare ad eventuale Claude un Audio Manifest validato.
6. Testare separatamente generazione, loop, riuso di asset, trasferimento OneDrive e ripresa dopo errore; solo poi un test end-to-end.

## Limiti aperti

- Il runtime ACE-Step XL non è installato; Stable Audio TFLite è stato avviato e ha prodotto un campione di prova.
- La qualità dei loop va misurata e ascoltata: la documentazione del generatore non garantisce da sola loop senza giunzioni.
- Formato compresso, loudness target e mix finale dipendono dal runtime audio del gioco, non ancora scelto.
- La configurazione MCP di Bionic e vari file del repository `.lmstudio` contengono modifiche locali già presenti; ogni futura integrazione dovrà applicare una patch mirata che le preservi.



## Implementazione Worker MCP — aggiornamento 4 ottobre 2026

Questa sezione aggiorna lo stato operativo descritto sopra: il progetto è passato dalla proposta all’implementazione iniziale del Worker.

### Componenti creati e registrati

- MCP Audio Worker: `C:\Users\Shadow\.lmstudio\audio\mcp\server.mjs`, dipendenze locali e `audio_tools.py`.
- Runtime Stable Audio 3 TFLite CPU conservato in `C:\Users\Shadow\.lmstudio\audio\worker\runtime\stable-audio-3\optimized\tflite`; disponibili i backend `stable_audio_medium` (DiT Medium fp32 + codec SAME-L) e `stable_audio_small_sfx` (DiT Small SFX fp32 + codec SAME-S).
- Cartella output candidati: `C:\Users\Shadow\.lmstudio\audio\worker\work\jobs\<PROJECT_ID>\<SCENE_ID>\<CUE_ID>`; anteprime loop in `C:\Users\Shadow\.lmstudio\audio\worker\work\loop-previews`.
- Asset finali: `C:\AI\assets\<PROJECT_ID>\Audio\SoundEffects` e `...\Music`.
- Pubblicazione OneDrive limitata a `imagecloud:AudioWorker/SoundEffects/final/<PROJECT_ID>` e `imagecloud:AudioWorker/Music/final/<PROJECT_ID>`. La pubblicazione copia WAV e manifest JSON affiancato, verifica entrambe le dimensioni e non cancella file remoti.
- MCP registrato come `audio-worker` in `C:\Users\Shadow\.codex\config.toml`. Backup precedente: `C:\Users\Shadow\.codex\config.toml.backup-audio-worker-20261004-222343`. `codex mcp get audio-worker` conferma `enabled: true` e trasporto stdio.

### Tool disponibili in Codex

- `system_status`: runtime/modelli, destinazioni e uso GPU.
- `generate_audio`: crea un candidato WAV e un manifest con categoria, prompt, loop, trigger, stop, seed, modello, hash della reference e controlli tecnici. Un loop richiede almeno 20 secondi; il prompt lo descrive come loop, ma il modello non garantisce una giunzione senza scatti.
- `inspect_audio`: formato, durata, canali, frequenza, picco, RMS, clipping, hash e metriche diagnostiche ai bordi.
- `create_loop_preview`: estrae i loop point richiesti e concatena più ripetizioni per l’ascolto. Il crossfade opzionale modifica solo la preview.
- `finalize_audio`: copia il candidato e il manifest nella cartella locale corretta, rifiutando sovrascritture e mismatch di progetto/categoria.
- `publish_audio`: carica soltanto un file già finalizzato nella cartella OneDrive della categoria corretta e controlla la dimensione remota.

### Verifiche eseguite

- Il server MCP si avvia via stdio e dichiara i sei tool previsti.
- `system_status` ha rilevato i due modelli TFLite, i codec, `rclone` con remote `imagecloud:` e GPU NVIDIA RTX A4500 (20 GB; circa 598 MiB occupati nella verifica).
- Generazione end-to-end di un effetto singolo di 4 secondi riuscita con Small SFX: WAV stereo PCM 16-bit, 44,1 kHz, 176.400 frame; nessun campione non finito o clipping. Manifest e SHA-256 creati.
- `create_loop_preview` ha creato una preview di 40 secondi da un segmento da 20 secondi ripetuto due volte, senza alterare il sorgente.
- `finalize_audio` ha copiato il candidato nella cartella locale SoundEffects e ha verificato l’hash. Il file prodotto era un artefatto temporaneo di prova; è stato rimosso dopo la verifica e non è un asset di progetto.
- `codex mcp list` / `codex mcp get audio-worker` hanno riconosciuto la configurazione.
- Sono state lette le cartelle OneDrive dedicate senza modificarle; non è stato caricato alcun file, quindi il publish resta da provare su un asset approvato. Non è stato fatto un ascolto soggettivo del campione né un benchmark comparativo cieco.

### Limiti e prossimo lavoro

- **ACE-Step XL SFT** è scaricato ma il relativo runtime d’inferenza non è installato: il Worker al momento espone solo Stable Audio 3 TFLite. ACE non compare tra i backend selezionabili e lo status lo marca come non disponibile. Il modello selezionato per musica va quindi ancora confrontato con ACE prima di considerare conclusa la valutazione della qualità.
- Il runtime TFLite usa CPU e lascia libera la GPU; il profilo Medium privilegia qualità rispetto a Small SFX. I loop devono essere ascoltati nella preview ripetuta; le metriche ai bordi sono soltanto diagnostiche.
- Il backend generativo non esegue ancora editing/inpainting da reference; accetta una reference audio per audio-to-audio.
- Il tool publish verifica dimensione remota; verifica hash remoto soltanto se il backend OneDrive espone una funzione hash confrontabile.
- Claude non è coinvolto in questa implementazione; il Worker fornisce manifest con loop, trigger e stop espliciti da passargli in seguito.
- Codex potrebbe dover ricaricare la configurazione MCP perché la configurazione è stata aggiornata durante la sessione.

Il Project File narrativo resta la fonte canonica del progetto. I manifest audio sono record operativi accanto ai candidati e agli asset, non copie della lore.

## Registro del confronto audio — 5 ottobre 2026

Il confronto dei primi cue prodotti da audio.cpp, i manifest con i controlli tecnici e le copie WAV conservate in `docs` sono raccolti in [CONFRONTO-MODELLI-AUDIO.md](CONFRONTO-MODELLI-AUDIO.md). Sono inclusi il campanello Small SFX, la musica Medium e la preview ripetuta del loop. I file restano candidati di test: il loop musicale non è approvato e nessun campione è stato finalizzato o pubblicato.
