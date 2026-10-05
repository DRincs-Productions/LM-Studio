# Confronto dei modelli Audio Worker

Aggiornato: 5 ottobre 2026  
Test: Audio Worker `audio.cpp` v0.9.0 Vulkan, NVIDIA RTX A4500 20 GB. La generazione è stata eseguita localmente; i file sono candidati tecnici del test Grand Hotel, non asset finali del progetto.

## Sintesi

Sono stati generati due cue con modelli Stable Audio 3 quantizzati Q8: un effetto singolo con Small SFX e una base musicale con Medium. I WAV sono validi dal punto di vista del formato, contengono campioni finiti e non presentano clipping. Non sono però un confronto diretto a parità di prompt: i modelli svolgono compiti diversi. La qualità timbrica non è stata valutata con ascolto umano; i risultati qui sotto distinguono quindi i dati misurati dai giudizi non ancora verificati.

| Modello | File modello | Dimensione | Ruolo nel test | Risultato |
|---|---|---:|---|---|
| Stable Audio 3 Small SFX Q8 | `stable-audio-3-small-sfx-q8_0.gguf` | 1.683.570.688 byte (1,68 GB / 1,57 GiB) | Singolo rintocco del campanello della reception | WAV stereo PCM 16-bit, 44,1 kHz, 4 s. Finito, nessun clipping; il prompt e il manifest classificano correttamente il cue come effetto non in loop. Prova tecnica riuscita. |
| Stable Audio 3 Medium Q8 | `stable-audio-3-medium-q8_0.gguf` | 3.582.595.584 byte (3,58 GB / 3,34 GiB) | Musica lounge/cabaret discreta per la hall | WAV stereo PCM 16-bit, 44,1 kHz, 30 s. Finito, nessun clipping. Il candidato è stato richiesto come loop, ma la giunta non è approvata: RMS dei primi 100 ms 0,1808135, ultimi 100 ms 0,0000538; differenza RMS 0,1807597. |

## Valutazione per uso

- **Effetti puntuali — Small SFX:** candidato adatto per generare un effetto dedicato. Questo test conferma generazione, manifest e controlli tecnici, ma un ascolto è ancora necessario per giudicare se il rintocco suona naturale e corrisponde bene alla scena.
- **Musica — Medium:** candidato più capace per un letto musicale articolato, ma il campione non supera la verifica del loop. La coda quasi silenziosa rispetto all'inizio indica che il file, così com'è, può produrre una pausa udibile quando riparte. Non va pubblicato o inserito nel gioco come loop approvato.
- **Confronto complessivo:** i due modelli non sono intercambiabili in base a questa prova. Small SFX è stato usato per l'effetto; Medium per la musica. Una valutazione di preferenza o qualità relativa richiede brief comparabili, ascolto e più campioni per categoria.

## Campioni e tracciabilità

I WAV, le preview e i manifest copiati qui sono gli stessi file prodotti dal Worker. Le copie dei manifest conservano i metadati originali e il percorso d'origine in `C:\Users\Shadow\.lmstudio\audio\worker\work\jobs\9b1b33e8-f40c-464a-bf7c-07fbcba71282\grand-hotel-check-in`.

### Stable Audio 3 Small SFX

- [Campanello reception — WAV, 4 s](confronto-audio/grand-hotel-audio-cpp/SFX-01-reception-bell.wav)
- [Manifest e metriche](confronto-audio/grand-hotel-audio-cpp/SFX-01-reception-bell.manifest.json)
- SHA-256: `e63ce5c20db30bd6cc29e04e782d2fa956515e1af317a5c873ead7978473d5d7`

### Stable Audio 3 Medium

- [Lounge della hall — WAV, 30 s](confronto-audio/grand-hotel-audio-cpp/MUSIC-01-grand-hotel-lobby.wav)
- [Manifest e metriche](confronto-audio/grand-hotel-audio-cpp/MUSIC-01-grand-hotel-lobby.manifest.json)
- [Preview con quattro ripetizioni — WAV, 120 s](confronto-audio/grand-hotel-audio-cpp/MUSIC-01-loop-preview-4x.wav)
- SHA-256 del sorgente: `19c0a4ea19bd8382229e3ba3984ffa048822f63fc206d7b67068b80a32b1ac60`
- SHA-256 della preview: `91d7bae4a4a4b72b354cb81da29c39e426d1ae62466d585227f7d729ab39c3ca`

## Limiti e decisioni

La preview contiene quattro ripetizioni del segmento da 30 secondi. Le metriche misurano soltanto proprietà del segnale e non certificano che la giunta sia impercettibile; inoltre non è stato fatto un ascolto umano documentato. Perciò il loop resta **da correggere e ascoltare**, non approvato. Nessun candidato è stato finalizzato o pubblicato su OneDrive; non sono stati creati asset definitivi. Le prove non hanno modificato il Project File canonico.

Conclusione provvisoria: mantenere **Small SFX per effetti** e **Medium come candidato musicale**, subordinando l'accettazione musicale alla correzione della coda, all'ascolto della preview ripetuta e a un nuovo controllo del loop.
