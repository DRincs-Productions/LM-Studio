# Catalogo LoRA per immagini

Questa pagina è il riferimento operativo per Codex e gli agenti che preparano richieste d’immagine. Le LoRA sono facoltative: non vanno applicate a ogni generazione. Se una LoRA corrisponde a un requisito esplicito della scena, Codex può selezionarla tramite `generate_image.loras`, specificando l’ID registrato e il peso entro il suo intervallo. Se il requisito non c’è, omettere `loras`.

SNOFS è stato rimosso e non è più previsto per l’uso. Le vecchie prove di compatibilità con `sd-cli` sono solo storico e non vanno ripetute.

## LoRA registrate

### `flaccid_erect_krea2_loraholic`

- File: `C:\AI\image-worker\loras\flaccid_erect_krea2_loraholic.safetensors`
- Fonte: [Flaccid / Erection Slider - Krea2](https://civitai.red/models/2832299/flaccid-erection-slider-krea2)
- Tipo: slider per l’aspetto flaccido/eretto del pene.
- Uso condizionale: selezionarla per una richiesta adulta che descrive esplicitamente un pene eretto e ne specifica orientamento o angolazione. Non selezionarla per scene vestite, anatomia flaccida o scene senza questo requisito.
- Intervallo consigliato dall’autore: da `-6.0` a `6.0`. L’autore indica `-10.0` e `10.0` come estremi non consigliati.
- Profilo consentito dal registro: RedCraft v3.0, stile standard, contenuto adulto. Non viene applicata automaticamente e non è selezionata per Krea2 Anime.
- Formato locale rilevato: SafeTensors BF16, 512 tensori.
- Compatibilità: il checkpoint di esempio dell’autore è Moody Krea 2 Mix V4. Nel test isolato del 25 ottobre 2026, `sd-cli` ha applicato `512 / 512` tensori su RedCraft v3.0 sia a peso `+3` sia a `-3`; il percorso tecnico funziona, anche se il checkpoint installato non è quello usato negli esempi dell’autore.
- Stato: installata e tecnicamente applicabile; non ancora pronta per la produzione perché manca una convalida visiva affidabile dell’effetto e del peso. Il registro resta `pending_quality_validation`, quindi il Worker la rifiuta nelle richieste di produzione.

La pagina del modello specifica l’intervallo, ma non assegna chiaramente i segni ai due estremi. Il confronto isolato `designer_lora_20261025093323_ee11c97f74` ha confrontato lo stesso prompt e seed con RedCraft senza LoRA e con pesi `+3` e `-3`. `+3` ha ottenuto 78/100, senza errore grave; la revisione chiedeva un angolo più chiaramente rivolto in alto a sinistra. `-3` ha ricevuto `REVIEW_FAILED` perché la revisione non poteva valutare l’immagine esplicita. Entrambi i candidati LoRA hanno applicato tutti i 512 tensori. Questo dimostra l’applicazione tecnica, ma non basta per stabilire in modo affidabile quale segno usare o promuovere l’adapter in produzione. L’immagine di controllo ha ricevuto 0/100 per lo stesso limite di revisione. Tutti i PNG, manifest e log MCP sono conservati in `production-tests/components/designer_lora_20261025093323_ee11c97f74`.

Il checkpoint Moody Krea 2 Mix V4 citato dall’autore non è installato. Possibilità per un seguito: usare un revisore che possa valutare in modo appropriato immagini anatomiche adulte, oppure installare e testare il checkpoint indicato dall’autore; poi confrontare pesi positivi moderati entro l’intervallo `-6..6`. Fino ad allora, lasciare lo stato diverso da `ready`.

## Registrazione di altre LoRA

Quando viene aggiunta una LoRA:

1. aggiungere qui modello base, file, fonte, scopo, condizioni d’uso, intervallo di peso, profili compatibili e stato di convalida;
2. aggiungere la stessa voce a `image-worker/mcp/image-loras.json`, che è il registro letto dal MCP;
3. lasciare la voce esclusa dai default, salvo esplicita decisione dell’utente;
4. usare un test Designer isolato e nuovo per verificare che il runtime applichi i tensori e che il risultato risponda allo scopo dichiarato; trattare `0 / N` come fallimento, non come generazione riuscita;
5. aggiornare lo stato solo dopo aver conservato manifest, log, output e revisione del test.

Il registro MCP restringe ogni LoRA a un profilo, un tipo di contenuto e uno stile. Non accetta percorsi arbitrari inviati nel prompt.
