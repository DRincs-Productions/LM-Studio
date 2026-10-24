# Test del flusso Audio Worker

Data: 12 ottobre 2026  
Esito: generazione, revisione, retry, finalizzazione, pubblicazione e ricerca degli asset verificati su un progetto di test isolato.

## Perimetro

Il test ha usato l’Audio Worker MCP aggiornato, `audio.cpp` Vulkan, Qwen2.5 Omni 7B via `llama-mtmd-cli` e il gate di revisione Codex. Il test non ha modificato il Project File canonico né il database di Bionic. Gli asset sono stati creati con l’ID isolato `audio-coordinator-e2e-20261012` sotto `C:\AI\assets` e pubblicati nelle cartelle di test rclone.

Il test completo della scena narrativa e dell’immagine non è stato riavviato: il Project Worker mostra il progetto canonico ancora in `handback_ready`, con la precedente scena non finalizzata. Non ho riprodotto quel job né modificato il Project File; la fase audio è stata provata da sola.

## Esiti dei cue

| Cue | Generatore | Revisione Qwen | Revisione Codex | Esito |
|---|---|---|---|---|
| Campanello reception, one-shot | Stable Audio 3 Small SFX Q8, 5 s | Categoria ed evento allineati; nessun problema segnalato; confidenza 100 | 96/100, nessun errore grave | Finalizzato e pubblicato in `SoundEffects` |
| Musica lounge, loop 30 s, primo candidato | Stable Audio 3 Medium Q8 | Il contenuto era allineato; Qwen ha giudicato pulita la preview ripetuta | 62/100, errore grave: RMS dei primi 100 ms 0,270973 contro 0,000677 degli ultimi 100 ms | Respinto. Il gate ha rifiutato la finalizzazione |
| Musica lounge, loop 30 s, retry | Stable Audio 3 Medium Q8, prompt corretto | Allineata; nessun problema; la preview grezza 3× è stata giudicata senza interruzioni; confidenza 100 | 88/100, nessun errore grave | Finalizzato e pubblicato in `Music` |

Il primo candidato musicale ha mostrato perché Codex deve confrontare le evidenze d’ascolto con le metriche: il rapporto Qwen era positivo, ma la grande differenza di livello ai bordi ha giustificato il retry. Il secondo candidato ha ridotto la differenza RMS a 0,022541 e ha superato la revisione combinata. Le metriche restano diagnostiche; non provano da sole la continuità percettiva.

## Verifiche effettuate

- `system_status` ha confermato i due generatori, il runtime locale di Qwen con projector e la destinazione rclone.
- `find_project_audio_assets` non ha trovato asset all’avvio e, dopo la pubblicazione, ha ritrovato entrambi i cue finali con categoria, manifest e SHA-256.
- Sono stati generati un effetto one-shot e una musica di 30 secondi; per il loop è stata creata e ascoltata da Qwen una preview di tre ripetizioni senza crossfade.
- Il primo loop ha ricevuto una decisione Codex sotto soglia con errore grave. Il tentativo di finalizzarlo è stato respinto dal worker.
- Il retry è stato registrato e approvato. I manifest finali includono hash audio, evidenza Qwen, valutazione Codex, categoria, flag loop e stato pubblicato.
- WAV e manifest sono stati pubblicati nelle cartelle Music e SoundEffects separate. Rclone ha verificato le dimensioni remote; gli hash SHA-256 sono stati verificati localmente.
- Il codice del server MCP e del Coordinatore supera `node --check`; il diff non presenta errori di whitespace.

## Asset del test

- [Campanello finale — WAV](docs/confronto-audio/audio-worker-e2e-2026-10-12/SFX-01-reception-bell.wav)
- [Manifest e revisione del campanello](docs/confronto-audio/audio-worker-e2e-2026-10-12/SFX-01-reception-bell.wav.json)
- [Musica finale — WAV](docs/confronto-audio/audio-worker-e2e-2026-10-12/MUSIC-01-lobby-bed.wav)
- [Manifest e revisione della musica](docs/confronto-audio/audio-worker-e2e-2026-10-12/MUSIC-01-lobby-bed.wav.json)
- [Preview grezza del loop, tre ripetizioni — WAV](docs/confronto-audio/audio-worker-e2e-2026-10-12/MUSIC-01-loop-preview-3x.wav)
- [Primo candidato musicale respinto — WAV](docs/confronto-audio/audio-worker-e2e-2026-10-12/MUSIC-01-first-candidate-rejected.wav)
- [Manifest del candidato respinto con retry Codex](docs/confronto-audio/audio-worker-e2e-2026-10-12/MUSIC-01-first-candidate-rejected.wav.json)
- I rapporti percettivi Qwen sono salvati nella stessa cartella accanto ai campioni.

## Limiti rimasti

- La pipeline audio è stata eseguita end-to-end direttamente tramite l’Audio Worker MCP; non è stato avviato un nuovo handoff del Project Worker perché la sessione canonica ha ancora un handback pendente.
- Non è stata completata una produzione combinata Writer → Disegnatore → Progettista sonoro. La scena resta da riparare e approvare prima di poter ripetere in sicurezza il test multimodale.
- Non è stato fatto un ascolto umano documentato. Le valutazioni d’ascolto riportate provengono da Qwen; Codex ha confrontato tali evidenze con il brief e le misure tecniche.
- La pubblicazione verifica dimensioni remote. L’hash remoto non viene verificato perché il backend rclone non lo garantisce; l’hash locale è registrato nel manifest.
