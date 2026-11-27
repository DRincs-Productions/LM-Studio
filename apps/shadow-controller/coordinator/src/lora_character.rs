use super::*;
use sha2::{Digest, Sha256};
use std::io::{Seek, SeekFrom};

const MAX_IMAGE: usize = 20 * 1024 * 1024;

#[cfg(test)]
#[test]
fn onedrive_batch_replays_and_deduplicates_without_cross_owner_access() {
    let store = JobStore::open_in_memory().unwrap();
    let root = std::env::temp_dir().join(format!("character-batch-{}", Uuid::new_v4()));
    let draft = store
        .lora_request(
            &root,
            "account",
            "owner",
            "character_create",
            &json!({"name":"Character","trigger":"batch_subject","requestId":Uuid::new_v4()}),
        )
        .unwrap();
    let image = Uuid::new_v4();
    let mut batch = json!({
        "jobId":draft["jobId"],"requestId":Uuid::new_v4(),
        "files":[{"imageId":image,"sha256":"a".repeat(64),"size":12,"description":""}]
    });
    let register = |owner, message: &Value| {
        store.lora_request(&root, "account", owner, "character_batch", message)
    };
    let first = register("owner", &batch).unwrap();
    assert_eq!(first["imageIds"], json!([image]));
    assert_eq!(register("owner", &batch).unwrap(), first);
    assert!(register("other", &batch).is_err());
    batch["files"][0]["size"] = json!(13);
    assert!(matches!(
        register("owner", &batch),
        Err(StoreError::IdempotencyConflict)
    ));
    batch["requestId"] = json!(Uuid::new_v4());
    batch["files"][0]["imageId"] = json!(Uuid::new_v4());
    batch["files"][0]["size"] = json!(12);
    assert_eq!(register("owner", &batch).unwrap(), first);
    assert_eq!(pending(&store).unwrap().unwrap().1, image.to_string());
    let job_path = root.join("lora").join(draft["jobId"].as_str().unwrap());
    fs::remove_dir(job_path.join("samples")).unwrap();
    fs::remove_dir(job_path).unwrap();
    fs::remove_dir(root.join("lora")).unwrap();
    fs::remove_dir(root).unwrap();
}

#[cfg(test)]
#[test]
fn character_drafts_accept_idempotent_chunks_only_from_the_owner() {
    let store = JobStore::open_in_memory().unwrap();
    let root = std::env::temp_dir().join(format!("character-lora-{}", Uuid::new_v4()));
    let create = json!({"name":"Character","trigger":"test_subject","requestId":Uuid::new_v4()});
    let job = store
        .lora_request(&root, "account", "owner", "character_create", &create)
        .unwrap();
    let id = &job["jobId"];
    let mut message = json!({"jobId":id,"requestId":Uuid::new_v4(),"description":"Capelli corti",
        "size":3,"sha256":format!("{:x}",Sha256::digest(b"abc")),"offset":0,"chunk":"6162"});
    let upload = |owner, message: &Value| {
        store.lora_request(&root, "account", owner, "character_chunk", message)
    };
    assert!(upload("other", &message).is_err());
    for _ in 0..2 {
        assert_eq!(
            upload("owner", &message).unwrap()["image"]["state"],
            "uploading"
        );
    }
    message["offset"] = json!(2);
    message["chunk"] = json!("63");
    assert_eq!(
        upload("owner", &message).unwrap()["image"]["state"],
        "pending"
    );
    assert!(
        store
            .lora_request(
                &root,
                "account",
                "owner",
                "character_submit",
                &json!({"jobId":id})
            )
            .is_err()
    );
    store
        .lora_request(&root, "account", "owner", "character_remove", &message)
        .unwrap();
    let job_dir = root.join("lora").join(id.as_str().unwrap());
    fs::remove_dir(job_dir.join("samples")).unwrap();
    fs::remove_dir(job_dir).unwrap();
    fs::remove_dir(root.join("lora")).unwrap();
    fs::remove_dir(root).unwrap();
}

pub(super) fn request(
    connection: &rusqlite::Connection,
    data: &Path,
    uid: &str,
    client: &str,
    action: &str,
    message: &Value,
) -> Result<Value, StoreError> {
    let invalid = |reason| StoreError::InvalidRequest(reason);
    if action == "character_create" {
        let request = uuid_field(message, "requestId")?;
        let name = message["name"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.len() <= 120)
            .ok_or(invalid("Invalid character name"))?;
        let token = message["trigger"]
            .as_str()
            .filter(|s| {
                (3..=48).contains(&s.len())
                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            })
            .ok_or(invalid("Invalid trigger token"))?;
        let character_id = if let Some(value) = message.get("characterId") {
            Some(
                value
                    .as_str()
                    .filter(|id| {
                        (1..=80).contains(&id.len())
                            && id
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
                    })
                    .ok_or(invalid("Invalid character ID"))?,
            )
        } else {
            None
        };
        if let Some(character_id) = character_id {
            let existing: Option<(String, String)> = connection.query_row(
                "SELECT id,config FROM lora_jobs WHERE uid=?1 AND client_id=?2 AND file_name='character' AND json_extract(config,'$.characterId')=?3",
                params![uid,client,character_id], |row| Ok((row.get(0)?,row.get(1)?))
            ).optional()?;
            if let Some((id, config)) = existing {
                let config: Value = serde_json::from_str(&config)?;
                if config["trigger"] != token {
                    return Err(StoreError::IdempotencyConflict);
                }
                return Ok(json!({"jobId":id,"characterId":character_id}));
            }
        }
        let config = json!({"name":name,"trigger":token,"images":{},"characterId":character_id});
        let id = Uuid::new_v4().to_string();
        connection.execute("INSERT OR IGNORE INTO lora_jobs(id,uid,client_id,request_id,file_name,config,state) VALUES (?1,?2,?3,?4,'character',?5,'draft')",
            params![id,uid,client,request,config.to_string()])?;
        let (id, stored_name, stored): (String,String,String) = connection.query_row(
            "SELECT id,file_name,config FROM lora_jobs WHERE uid=?1 AND client_id=?2 AND request_id=?3",
            params![uid,client,request], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        let stored: Value = serde_json::from_str(&stored)?;
        if stored_name != "character"
            || stored["name"] != name
            || stored["trigger"] != token
            || stored["characterId"] != json!(character_id)
        {
            return Err(StoreError::IdempotencyConflict);
        }
        return Ok(json!({"jobId":id,"characterId":character_id}));
    }
    let id = uuid_field(message, "jobId")?;
    let (state, serialized): (String,String) = connection.query_row(
        "SELECT state,config FROM lora_jobs WHERE id=?1 AND uid=?2 AND client_id=?3 AND file_name='character'",
        params![id,uid,client], |r| Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(StoreError::JobNotFound)?;
    let mut config: Value = serde_json::from_str(&serialized)?;
    let continuation =
        state == "completed" && config["characterId"].is_string() && action == "character_submit";
    let accepts_followup = config["characterId"].is_string()
        && (action == "character_batch" || action == "character_remove");
    if state != "draft" && !accepts_followup && !continuation {
        if action == "character_submit" {
            return Ok(json!({"jobId":id,"state":state}));
        }
        return Err(invalid("Dataset is frozen"));
    }
    let root = data.join("lora").join(&id).join("samples");
    let io_error = |_| invalid("Cannot access character dataset");
    fs::create_dir_all(&root).map_err(io_error)?;
    if action == "character_batch" {
        let batch = uuid_field(message, "requestId")?;
        let files = message["files"]
            .as_array()
            .filter(|files| (1..=20).contains(&files.len()))
            .ok_or(invalid("Provide 1 to 20 character references"))?;
        if let Some(prior) = config
            .get("batches")
            .and_then(|batches| batches.get(&batch))
        {
            if prior["files"] != message["files"] {
                return Err(StoreError::IdempotencyConflict);
            }
            return Ok(json!({"jobId":id,"imageIds":prior["imageIds"]}));
        }
        let images = config["images"].as_object_mut().unwrap();
        let mut accepted = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for file in files {
            let sample = uuid_field(file, "imageId")?;
            if !seen.insert(sample.clone()) {
                return Err(invalid("Image IDs must be distinct"));
            }
            let hash = file["sha256"]
                .as_str()
                .filter(|hash| {
                    hash.len() == 64
                        && hash
                            .bytes()
                            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                })
                .ok_or(invalid("Invalid image hash"))?;
            let size = file["size"]
                .as_u64()
                .filter(|size| (1..=MAX_IMAGE as u64).contains(size))
                .ok_or(invalid("Image exceeds the upload limit"))?;
            let description = file["description"]
                .as_str()
                .filter(|text| text.len() <= 4000)
                .ok_or(invalid("Invalid image description"))?;
            if let Some(prior) = images.get(&sample) {
                if prior["sha256"] != hash
                    || prior["size"] != size
                    || prior["description"] != description
                    || prior["batch"] != batch
                {
                    return Err(StoreError::IdempotencyConflict);
                }
                accepted.push(sample);
                continue;
            }
            if let Some((existing, _)) = images.iter().find(|(_, image)| {
                image["sha256"] == hash
                    && image["state"] != "failed"
                    && image["state"] != "uploading"
            }) {
                accepted.push(existing.clone());
                continue;
            }
            if images.len() >= 100 {
                return Err(invalid("Dataset exceeds 100 images"));
            }
            images.insert(
                sample.clone(),
                json!({
                    "state":"pending","description":description,"sha256":hash,"size":size,
                    "batch":batch,"updated":unix_now()
                }),
            );
            accepted.push(sample);
        }
        if config.get("batches").is_none() {
            config["batches"] = json!({});
        }
        config["batches"][&batch] = json!({"files":files,"imageIds":accepted});
        connection.execute(
            "UPDATE lora_jobs SET config=?2 WHERE id=?1",
            params![id, config.to_string()],
        )?;
        return Ok(json!({"jobId":id,"imageIds":accepted}));
    }
    if action == "character_submit" {
        let images = config["images"].as_object().unwrap();
        if continuation
            && config["activeImages"]
                .as_array()
                .is_some_and(|active| active.len() == images.len())
        {
            return Ok(json!({"jobId":id,"state":state}));
        }
        if images.is_empty() || images.values().any(|s| s["state"] != "ready") {
            return Err(invalid("Every image must be prepared before submission"));
        }
        let template = fs::read_to_string(data.join("krea2-character-template.json"))
            .map_err(|_| invalid("Missing krea2-character-template.json"))?;
        let mut training: Value = serde_json::from_str(&template)?;
        let model = training["base_model_name"].as_str().map(Path::new);
        if training["model_type"] != "KREA_2"
            || training["training_method"] != "LORA"
            || !model.is_some_and(|p| p.is_absolute() && p.is_dir())
        {
            return Err(invalid(
                "Template requires a local Krea 2 Diffusers base and LoRA mode",
            ));
        }
        let model = model.unwrap();
        let required = [
            "model_index.json",
            "scheduler/scheduler_config.json",
            "tokenizer/tokenizer.json",
            "text_encoder/config.json",
            "transformer/config.json",
            "vae/config.json",
        ];
        if required.iter().any(|file| !model.join(file).is_file()) {
            return Err(invalid("The local Krea 2 Diffusers download is incomplete"));
        }
        for (component, stem) in [
            ("text_encoder", "model"),
            ("transformer", "diffusion_pytorch_model"),
            ("vae", "diffusion_pytorch_model"),
        ] {
            let directory = model.join(component);
            if directory.join(format!("{stem}.safetensors")).is_file() {
                continue;
            }
            let incomplete = || invalid("The local Krea 2 Diffusers weights are incomplete");
            let index = fs::read(directory.join(format!("{stem}.safetensors.index.json")))
                .map_err(|_| incomplete())?;
            let index: Value = serde_json::from_slice(&index)?;
            let weights = index["weight_map"]
                .as_object()
                .filter(|map| !map.is_empty())
                .ok_or_else(incomplete)?;
            if weights.values().any(|entry| {
                !entry.as_str().is_some_and(|file| {
                    !file.contains(['/', '\\', ':'])
                        && file.ends_with(".safetensors")
                        && directory.join(file).is_file()
                })
            }) {
                return Err(incomplete());
            }
        }
        let dataset = root
            .canonicalize()
            .map_err(io_error)?
            .join(format!("dataset-{}", Uuid::new_v4()));
        fs::create_dir_all(&dataset).map_err(io_error)?;
        for sample in images.keys() {
            for suffix in [".png", "-masklabel.png", ".txt"] {
                let name = format!("{sample}{suffix}");
                fs::copy(root.join(sample).join(&name), dataset.join(&name)).map_err(io_error)?;
            }
        }
        training["concepts"] = json!([{"enabled":true,"name":config["name"],"path":dataset,"seed":42,
            "include_subdirectories":false,"text":{"prompt_source":"sample"}}]);
        training["masked_training"] = json!(true);
        training["unmasked_probability"] = json!(0);
        training["unmasked_weight"] = json!(0);
        training["masked_prior_preservation_weight"] = json!(0);
        let active_images = json!(images.keys().collect::<Vec<_>>());
        if config["characterId"].is_string() {
            let previous = config["revision"].as_u64().unwrap_or(0);
            config["revision"] = json!(previous + 1);
            if continuation {
                config["parentRevision"] = json!(previous);
            }
        }
        config["training"] = training;
        config["activeImages"] = active_images;
        connection.execute(
            "UPDATE lora_jobs SET state='waiting',attached_at=?2,paused=0,config=?3 WHERE id=?1",
            params![id, timestamp(), config.to_string()],
        )?;
        return Ok(json!({"jobId":id,"state":"waiting"}));
    }
    let sample = uuid_field(message, "requestId")?;
    let dir = root.join(&sample);
    if action == "character_remove"
        && state != "draft"
        && config["activeImages"]
            .as_array()
            .is_none_or(|active| active.iter().any(|id| id == &sample))
    {
        return Err(invalid("An active training reference cannot be removed"));
    }
    let images = config["images"].as_object_mut().unwrap();
    if action == "character_remove" {
        if images
            .get(&sample)
            .is_some_and(|s| s["state"] == "preparing")
        {
            return Err(invalid("Image preparation is in progress"));
        }
        if dir.exists() {
            fs::remove_dir_all(&dir).map_err(io_error)?;
        }
        images.remove(&sample);
    } else if action == "character_chunk" {
        let description = message["description"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 4000)
            .ok_or(invalid("Provide a character description up to 4000 bytes"))?;
        let sha = message["sha256"]
            .as_str()
            .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or(invalid("Invalid image hash"))?;
        let size = message["size"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= MAX_IMAGE as u64)
            .ok_or(invalid("Image exceeds the upload limit"))?;
        let offset = message["offset"]
            .as_u64()
            .filter(|n| *n <= size)
            .ok_or(invalid("Invalid chunk offset"))?;
        let chunk = message["chunk"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 48000
                    && s.len() % 2 == 0
                    && s.bytes().all(|b| b.is_ascii_hexdigit())
            })
            .ok_or(invalid("Invalid image chunk"))?;
        let bytes = (0..chunk.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&chunk[i..i + 2], 16).unwrap())
            .collect::<Vec<_>>();
        if offset + bytes.len() as u64 > size {
            return Err(invalid("Chunk exceeds image size"));
        }
        if images.len() >= 100 && !images.contains_key(&sample) {
            return Err(invalid("Dataset exceeds 100 images"));
        }
        let entry = images.entry(sample.clone()).or_insert_with(
            || json!({"state":"uploading","description":description,"sha256":sha,"size":size}),
        );
        if entry["description"] != description || entry["sha256"] != sha || entry["size"] != size {
            return Err(StoreError::IdempotencyConflict);
        }
        if entry["state"] == "uploading" {
            entry["updated"] = json!(unix_now());

            fs::create_dir_all(&dir).map_err(io_error)?;
            let source = dir.join("source");
            let length = fs::metadata(&source).map(|m| m.len()).unwrap_or(0);
            if offset > length {
                return Err(invalid("Missing preceding image chunk"));
            }
            if offset < length {
                let mut file = File::open(&source).map_err(io_error)?;
                file.seek(SeekFrom::Start(offset)).map_err(io_error)?;
                let mut prior = vec![0; bytes.len()];
                if file.read_exact(&mut prior).is_err() || prior != bytes {
                    return Err(StoreError::IdempotencyConflict);
                }
            } else {
                let mut file = fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&source)
                    .map_err(io_error)?;
                if let Err(error) = file.write_all(&bytes) {
                    let _ = file.set_len(length);
                    return Err(io_error(error));
                }
                file.sync_all().map_err(io_error)?;
            }
            if fs::metadata(&source).map_err(io_error)?.len() == size {
                let input = fs::read(source).map_err(io_error)?;
                let entry = images.get_mut(&sample).unwrap();
                entry["state"] = if format!("{:x}", Sha256::digest(input)) == sha {
                    json!("pending")
                } else {
                    json!("failed")
                };
                if entry["state"] == "failed" {
                    entry["error"] = json!("Image hash mismatch");
                }
            }
        }
    } else {
        return Err(invalid("Unknown character action"));
    }
    connection.execute(
        "UPDATE lora_jobs SET config=?2 WHERE id=?1",
        params![id, config.to_string()],
    )?;
    Ok(json!({"jobId":id,"imageId":sample,"image":config["images"][&sample]}))
}
pub(super) fn pending(
    store: &JobStore,
) -> Result<Option<(String, String, String, Value)>, StoreError> {
    let connection = store
        .connection
        .lock()
        .map_err(|_| StoreError::LockPoisoned)?;
    let mut query = connection.prepare(
        "SELECT j.id,i.key,j.config FROM lora_jobs j,json_each(j.config,'$.images') i
         WHERE j.file_name='character' AND json_extract(i.value,'$.state')='pending' ORDER BY j.rowid LIMIT 1")?;
    let row = query
        .query_row([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .optional()?;
    row.map(|(id, sample, config)| {
        let config: Value = serde_json::from_str(&config)?;
        Ok((
            id,
            sample.clone(),
            config["trigger"].as_str().unwrap().to_owned(),
            config["images"][&sample].clone(),
        ))
    })
    .transpose()
}

pub(super) fn activate_ready_followup(store: &JobStore, data: &Path) -> Result<(), StoreError> {
    let connection = store
        .connection
        .lock()
        .map_err(|_| StoreError::LockPoisoned)?;
    let candidate = connection.query_row(
        "SELECT id,uid,client_id FROM lora_jobs
         WHERE file_name='character' AND state='completed' AND attached_at IS NOT NULL AND paused=0
           AND json_type(config,'$.characterId')='text'
           AND json_array_length(config,'$.activeImages') < (SELECT count(*) FROM json_each(config,'$.images'))
           AND NOT EXISTS (SELECT 1 FROM json_each(config,'$.images') WHERE json_extract(value,'$.state') != 'ready')
           AND coalesce(detail,'') NOT LIKE 'Dataset continuation blocked:%'
         ORDER BY rowid LIMIT 1",
        [], |row| Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?))
    ).optional()?;
    if let Some((id, uid, client)) = candidate {
        if let Err(error) = request(
            &connection,
            data,
            &uid,
            &client,
            "character_submit",
            &json!({"jobId":id}),
        ) {
            connection.execute(
                "UPDATE lora_jobs SET detail=?2 WHERE id=?1",
                params![id, format!("Dataset continuation blocked: {error}")],
            )?;
        }
    }
    Ok(())
}

pub(super) fn preparation_state(
    store: &JobStore,
    id: &str,
    sample: &str,
    state: &str,
    detail: Option<&str>,
) -> Result<bool, StoreError> {
    let connection = store
        .connection
        .lock()
        .map_err(|_| StoreError::LockPoisoned)?;
    let path = format!("$.images.\"{sample}\"");
    let changed = connection.execute(
        "UPDATE lora_jobs SET config=json_set(config,?2||'.state',?3,?2||'.caption',?4,?2||'.error',?5)
         WHERE id=?1 AND file_name='character' AND json_type(config,?2)='object'",
        params![id,path,state,detail.filter(|_|state=="ready"),detail.filter(|_|state=="failed")])?;
    Ok(changed != 0)
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

pub(super) fn expire_uploads(store: &JobStore, data: &Path) -> Result<(), StoreError> {
    let connection = store
        .connection
        .lock()
        .map_err(|_| StoreError::LockPoisoned)?;
    let mut query = connection.prepare(
        "SELECT j.id,i.key FROM lora_jobs j,json_each(j.config,'$.images') i
         WHERE j.state='draft' AND json_extract(i.value,'$.state')='uploading'
         AND json_extract(i.value,'$.updated')<=?1",
    )?;
    let expired = query
        .query_map([unix_now().saturating_sub(86400)], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (id, sample) in expired {
        if Uuid::parse_str(&id).is_err() || Uuid::parse_str(&sample).is_err() {
            continue;
        }
        let dir = data.join("lora").join(&id).join("samples").join(&sample);
        match fs::remove_file(dir.join("source")) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => continue,
        }
        let _ = fs::remove_dir(dir);
        connection.execute(
            "UPDATE lora_jobs SET config=json_remove(config,?2) WHERE id=?1",
            params![id, format!("$.images.\"{sample}\"")],
        )?;
    }
    Ok(())
}
