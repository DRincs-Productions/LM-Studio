# Catalogo LoRA per immagini

Questa pagina è il riferimento operativo per Codex e gli agenti che preparano richieste d’immagine. Le LoRA sono facoltative: non vanno applicate a ogni generazione. Se una LoRA corrisponde a un requisito esplicito della scena, Codex può selezionarla tramite `generate_image.loras`, specificando l’ID registrato e il peso entro il suo intervallo. Se il requisito non c’è, omettere `loras`.

SNOFS è un’eccezione già installata. È un adapter LoKR incompatibile con il percorso `sd-cli` verificato e non fa parte di questo catalogo né della selezione facoltativa standard.

## LoRA registrate

### `flaccid_erect_krea2_loraholic`

- File: `C:\AI\image-worker\loras\flaccid_erect_krea2_loraholic.safetensors`
- Fonte: [Flaccid / Erection Slider - Krea2](https://civitai.red/models/2832299/flaccid-erection-slider-krea2)
- Tipo: slider per l’aspetto flaccido/eretto del pene.
- Uso condizionale: selezionarla per una richiesta adulta che descrive esplicitamente un pene eretto e ne specifica orientamento o angolazione. Non selezionarla per scene vestite, anatomia flaccida o scene senza questo requisito.
- Intervallo consigliato dall’autore: da `-6.0` a `6.0`. L’autore indica `-10.0` e `10.0` come estremi non consigliati.
- Profilo consentito dal registro: RedCraft v3.0, stile standard, contenuto adulto. Non viene applicata automaticamente e non è selezionata per Krea2 Anime.
- Formato locale rilevato: SafeTensors BF16, 512 tensori.
- Compatibilità: il checkpoint di esempio dell’autore è Moody Krea 2 Mix V4. In un test con RedCraft v3.0, `sd-cli` ha caricato il file ma ha dichiarato `0 / 512 LoRA tensors have been applied`; quindi questa combinazione non modifica il modello e non va usata in produzione.
- Stato: installata; bloccata nel Worker finché non esiste una prova che applichi tensori. La modalità di test può abilitarla solo nel processo MCP isolato.

La pagina del modello specifica l’intervallo, ma non assegna chiaramente i segni ai due estremi. Non assumere che un peso negativo significhi flaccido o che uno positivo significhi eretto finché un confronto controllato non lo conferma. Codex deve mantenere il prompt esplicito sull’orientamento richiesto e usare un peso entro l’intervallo autorizzato. Il tentativo isolato del 25 ottobre 2026 (run `designer_lora_20261025085231_f7c272db16`) è stato interrotto dopo che Codex ha rifiutato la revisione dell’immagine esplicita; il PNG di controllo, i log e la diagnostica `0 / 512` sono conservati in `production-tests/components/<RUN_ID>`. Non sono stati completati i candidati con LoRA né valutata la direzione del peso.

## Registrazione di altre LoRA

Quando viene aggiunta una LoRA:

1. aggiungere qui modello base, file, fonte, scopo, condizioni d’uso, intervallo di peso, profili compatibili e stato di convalida;
2. aggiungere la stessa voce a `image-worker/mcp/image-loras.json`, che è il registro letto dal MCP;
3. lasciare la voce esclusa dai default, salvo esplicita decisione dell’utente;
4. usare un test Designer isolato e nuovo per verificare che il runtime applichi i tensori e che il risultato risponda allo scopo dichiarato; trattare `0 / N` come fallimento, non come generazione riuscita;
5. aggiornare lo stato solo dopo aver conservato manifest, log, output e revisione del test.

Il registro MCP restringe ogni LoRA a un profilo, un tipo di contenuto e uno stile. Non accetta percorsi arbitrari inviati nel prompt.
