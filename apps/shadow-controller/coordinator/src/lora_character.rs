use super::*;
use sha2::{Digest, Sha256};
use std::io::{Seek, SeekFrom};

const MAX_IMAGE: usize = 20 * 1024 * 1024;

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
        let config = json!({"name":name,"trigger":token,"images":{}});
        let id = Uuid::new_v4().to_string();
        connection.execute("INSERT OR IGNORE INTO lora_jobs(id,uid,client_id,request_id,file_name,config,state) VALUES (?1,?2,?3,?4,'character',?5,'draft')",
            params![id,uid,client,request,config.to_string()])?;
        let (id, stored_name, stored): (String,String,String) = connection.query_row(
            "SELECT id,file_name,config FROM lora_jobs WHERE uid=?1 AND client_id=?2 AND request_id=?3",
            params![uid,client,request], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
        let stored: Value = serde_json::from_str(&stored)?;
        if stored_name != "character" || stored["name"] != name || stored["trigger"] != token {
            return Err(StoreError::IdempotencyConflict);
        }
        return Ok(json!({"jobId":id}));
    }
    let id = uuid_field(message, "jobId")?;
    let (state, serialized): (String,String) = connection.query_row(
        "SELECT state,config FROM lora_jobs WHERE id=?1 AND uid=?2 AND client_id=?3 AND file_name='character'",
        params![id,uid,client], |r| Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(StoreError::JobNotFound)?;
    let mut config: Value = serde_json::from_str(&serialized)?;
    if state != "draft" {
        if action == "character_submit" {
            return Ok(json!({"jobId":id,"state":state}));
        }
        return Err(invalid("Dataset is frozen"));
    }
    let root = data.join("lora").join(&id).join("samples");
    let io_error = |_| invalid("Cannot access character dataset");
    fs::create_dir_all(&root).map_err(io_error)?;
    if action == "character_submit" {
        let images = config["images"].as_object().unwrap();
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
        config["training"] = training;
        connection.execute(
            "UPDATE lora_jobs SET state='waiting',attached_at=?2,paused=0,config=?3 WHERE id=?1",
            params![id, timestamp(), config.to_string()],
        )?;
        return Ok(json!({"jobId":id,"state":"waiting"}));
    }
    let sample = uuid_field(message, "requestId")?;
    let dir = root.join(&sample);
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
) -> Result<Option<(String, String, String, String)>, StoreError> {
    let connection = store
        .connection
        .lock()
        .map_err(|_| StoreError::LockPoisoned)?;
    let mut query = connection.prepare(
        "SELECT j.id,i.key,j.config FROM lora_jobs j,json_each(j.config,'$.images') i
         WHERE j.state='draft' AND json_extract(i.value,'$.state')='pending' ORDER BY j.rowid LIMIT 1")?;
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
            config["images"][&sample]["description"]
                .as_str()
                .unwrap()
                .to_owned(),
        ))
    })
    .transpose()
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
         WHERE id=?1 AND state='draft' AND json_type(config,?2)='object'",
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
