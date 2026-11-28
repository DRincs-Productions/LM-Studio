"""Run the local OneTrainer installation under Shadow Controller."""
import hashlib
import gc
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_adapter(candidate, evidence, trigger):
    """Generate a local probe and require explicit adapter application evidence."""
    from PIL import Image

    worker = Path(os.environ.get("SHADOW_IMAGE_WORKER_ENTRY",
                                Path.home() / ".lmstudio/image-worker/mcp/server.mjs"))
    models = Path(os.environ.get("IMAGE_WORKER_ROOT", r"C:\AI\image-worker")) / "models"
    shared = Path(os.environ.get("IMAGE_WORKER_SHARED_MODELS",
                                Path.home() / "AppData/Local/Comfy-Desktop/ComfyUI-Shared/models"))
    raw = Path(os.environ.get("SHADOW_LORA_INFERENCE_MODEL", models / "krea2_raw_fp8_scaled.safetensors"))
    evidence.mkdir()
    probe = evidence / "probe.png"
    log = evidence / "inference.log"
    with log.open("xb") as stream:
        result = subprocess.run([
            str(worker.parent.parent / "bin/sd-cli.exe"), "--diffusion-model", str(raw),
            "--llm", str(shared / "text_encoders/qwen3vl_4b_fp8_scaled.safetensors"),
            "--vae", str(shared / "vae/qwen_image_vae.safetensors"),
            "--lora-model-dir", str(candidate.parent), "--lora-apply-mode", "at_runtime",
            "-p", f"Portrait of {trigger} <lora:{candidate.stem}:1>",
            "-W", "512", "-H", "512", "--steps", "12", "--cfg-scale", "1",
            "--seed", "314159", "--backend", "cuda0", "-o", str(probe),
        ], stdout=stream, stderr=subprocess.STDOUT, timeout=300)
    matches = re.findall(r"\(\s*(\d+)\s*/\s*(\d+)\s*\)\s*LoRA tensors have been applied",
                         log.read_text(encoding="utf-8", errors="replace"), re.IGNORECASE)
    if result.returncode or not matches or any(int(applied) < 1 for applied, _ in matches):
        raise RuntimeError("Inference did not verify adapter application")
    with Image.open(probe, formats=["PNG"]) as image:
        if image.size != (512, 512):
            raise RuntimeError("Inference probe has unexpected dimensions")
        image.verify()
    return [{"applied": int(applied), "total": int(total)} for applied, total in matches]


def publish_epoch_adapters(workspace, attempt, trigger):
    versions = workspace.parent / "versions"
    versions.mkdir(exist_ok=True)
    rclone = os.environ.get("SHADOW_RCLONE_EXECUTABLE", "rclone")
    candidates = sorted((workspace / "epoch-candidates").glob("*.safetensors"))
    for candidate in candidates:
        key = f"{workspace.name}/{candidate.name}"
        sha256 = digest(candidate)
        records = sorted(versions.glob("*.json"), key=lambda path: tuple(map(int, path.stem.split("."))))
        existing = next((p for p in records if json.loads(p.read_text(encoding="utf-8"))["candidate"] == key), None)
        if existing:
            manifest = existing
            if json.loads(manifest.read_text(encoding="utf-8"))["sha256"] != sha256:
                raise RuntimeError("A versioned adapter candidate changed")
        else:
            tensors = verify_adapter(candidate, attempt / candidate.stem, trigger)
            major, minor = map(int, records[-1].stem.split(".")) if records else (0, 0)
            promote = os.environ.get("SHADOW_LORA_MAJOR_VERSION") == "1" and not any(
                json.loads(path.read_text(encoding="utf-8"))["candidate"].startswith(workspace.name + "/")
                for path in records
            )
            version = f"{major + 1}.0" if promote else f"{major}.{minor + 1}"
            manifest = versions / f"{version}.json"
            temporary = attempt / f"version-{uuid.uuid4().hex}.json"
            with temporary.open("x", encoding="utf-8") as stream:
                json.dump({"version": manifest.stem, "candidate": key, "sha256": sha256,
                           "bytes": candidate.stat().st_size, "tensors": tensors}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            temporary.rename(manifest)
        remote = f"imagecloud:LoRAWorker/final/{workspace.parent.name}/{manifest.stem}"
        for local, name in ((candidate, "model.safetensors"), (manifest, "manifest.json")):
            target = f"{remote}/{name}"
            subprocess.run([rclone, "copyto", "--immutable", str(local), target], check=True, timeout=180)
            downloaded = attempt / f"verify-{uuid.uuid4().hex}"
            subprocess.run([rclone, "copyto", target, str(downloaded)], check=True, timeout=180)
            if digest(local) != digest(downloaded):
                raise RuntimeError("Published LoRA version failed SHA-256 verification")
            downloaded.unlink()
        receipt = json.loads(manifest.read_text(encoding="utf-8"))
        receipt["remoteDirectory"] = remote
        temporary_receipt = attempt / "published-version.json"
        with temporary_receipt.open("w", encoding="utf-8") as stream:
            json.dump(receipt, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary_receipt.replace(workspace.parent / "published-version.json")


def publish_checkpoint(source, checkpoints, progress, export_sha256):
    required = ("meta.json", "optimizer/optimizer.pt", "lora/lora.safetensors")
    if not all((source / name).is_file() for name in required):
        raise RuntimeError("OneTrainer did not write a complete checkpoint")
    files = {}
    for path in source.rglob("*"):
        if path.is_file():
            with path.open("rb") as stream:
                files[path.relative_to(source).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
            with path.open("r+b") as stream:
                os.fsync(stream.fileno())
    with (source / "shadow-checkpoint.json").open("x", encoding="utf-8") as stream:
        json.dump({
            "files": files,
            "export_sha256": export_sha256,
            "epoch": progress.epoch,
            "epoch_step": progress.epoch_step,
            "global_step": progress.global_step,
        }, stream)
        stream.flush()
        os.fsync(stream.fileno())
    destination = checkpoints / f"{time.time_ns():020d}-step-{progress.global_step}-{uuid.uuid4().hex}"
    source.rename(destination)
    for old in sorted((item for item in checkpoints.iterdir() if not item.name.startswith(".")), reverse=True)[2:]:
        shutil.rmtree(old)


def find_checkpoint(checkpoints, expected_sha256, *, epoch_boundary=False):
    for path in sorted(checkpoints.iterdir(), reverse=True):
        try:
            manifest = json.loads((path / "shadow-checkpoint.json").read_text(encoding="utf-8"))
            files = manifest["files"]
            if manifest["export_sha256"] != expected_sha256:
                continue
            if epoch_boundary and not (
                manifest.get("epoch_step") == 0
                and isinstance(manifest.get("epoch"), int) and manifest["epoch"] > 0
                and isinstance(manifest.get("global_step"), int) and manifest["global_step"] > 0
            ):
                continue
            if not {"meta.json", "optimizer/optimizer.pt", "lora/lora.safetensors"} <= files.keys():
                continue
            if not files or not all(digest(path / name) == value for name, value in files.items()):
                continue
            return path
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
    return None


def train(workspace, attempt):
    sys.path.insert(0, str(Path.cwd()))
    sys.path.insert(0, str(Path.cwd() / "scripts"))
    from util.import_util import script_imports
    script_imports(allow_zluda=False)

    from modules.util import create
    from modules.util.callbacks.TrainCallbacks import TrainCallbacks
    from modules.util.commands.TrainCommands import TrainCommands
    from modules.util.config.TrainConfig import TrainConfig
    from safetensors import safe_open
    import torch

    torch.set_num_threads(max(1, min(4, (os.cpu_count() or 2) // 2)))
    torch.cuda.set_per_process_memory_fraction(0.9, 0)

    exported = json.loads((workspace / "export.json").read_text(encoding="utf-8"))
    previous = os.environ.get("SHADOW_LORA_PARENT_WORKSPACE")
    parent_checkpoint = None
    parent_progress = None
    if previous:
        parent = Path(previous)
        prior_export = parent / "export.json"
        prior = json.loads(prior_export.read_text(encoding="utf-8"))
        # A dataset revision may change concepts, but not optimizer or model settings.
        training_settings = lambda settings: {key: value for key, value in settings.items() if key != "concepts"}
        if training_settings(exported) != training_settings(prior):
            raise ValueError("Dataset continuation requires unchanged training settings")
        parent_checkpoint = find_checkpoint(parent / "checkpoints", digest(prior_export), epoch_boundary=True)
        if parent_checkpoint is None:
            raise RuntimeError("No verified parent epoch checkpoint supports dataset continuation")
        parent_progress = json.loads((parent_checkpoint / "shadow-checkpoint.json").read_text(encoding="utf-8"))
    # OneTrainer's pack export embeds concepts and samples. Keep canonical copies
    # inside the workspace because its backup writer persists these paths.
    concepts = exported.get("concepts")
    if not isinstance(concepts, list) or not concepts:
        raise ValueError("Export Training with embedded concepts")
    concepts_path = workspace / "training_concepts" / "concepts.json"
    concepts_path.parent.mkdir(parents=True, exist_ok=True)
    concepts_path.write_text(json.dumps(concepts), encoding="utf-8")
    samples = exported.get("samples")
    samples_path = workspace / "training_samples" / "samples.json"
    samples_path.parent.mkdir(parents=True, exist_ok=True)
    samples_path.write_text(json.dumps(samples or []), encoding="utf-8")
    exported["concept_file_name"] = str(concepts_path)
    exported["sample_definition_file_name"] = str(samples_path)
    config = TrainConfig.default_values()
    config.from_dict(exported)
    if parent_progress:
        config.epochs += parent_progress["epoch"]
    if config.training_method.name != "LORA":
        raise ValueError("Select LoRA training in OneTrainer")
    enabled_concepts = [concept for concept in (config.concepts or []) if concept.enabled]
    if not enabled_concepts or not all(Path(concept.path).is_dir() for concept in enabled_concepts):
        raise ValueError("Export training with accessible local dataset paths")
    if not config.base_model_name or not Path(config.base_model_name).is_absolute() or not Path(config.base_model_name).exists():
        raise ValueError("Export training with an accessible local base model")
    model_paths = config.model_names()
    for attribute in ("transformer_model", "vae_model", "text_encoder_4"):
        path = getattr(model_paths, attribute, None)
        if path and Path(path).is_absolute() and not Path(path).exists():
            raise ValueError(f"Export training with an accessible local {attribute.replace('_', ' ')}")

    checkpoints = workspace / "checkpoints"
    checkpoints.mkdir(exist_ok=True)
    output = attempt / "model.safetensors"
    # OneTrainer only writes the final LoRA after a completed optimizer step.
    # Keep this attempt-local model and publish it atomically after validation.
    config.from_dict({
        "workspace_dir": str(attempt),
        "cache_dir": str(workspace / "cache"),
        "huggingface_cache_dir": str(workspace / "hub"),
        "quantization": {"cache_dir": str(workspace / "cache" / "quantization")},
        "output_model_destination": str(output),
        "concept_file_name": str(concepts_path),
        "sample_definition_file_name": str(samples_path),
        "output_model_format": "COMFY_LORA" if config.model_type.name == "KREA_2"
        else config.output_model_format.name,
        "save_every": 1,
        "backup_after": 1,
        "backup_after_unit": "STEP",
        "save_every_unit": "STEP",
        "backup_before_save": False,
        "sample_after_unit": "NEVER",
        "sample_after": 999999999,
        "samples_to_tensorboard": False,
        "non_ema_sampling": False,
        "save_filename_prefix": "shadow-",
        "continue_last_backup": False,
        "rolling_backup": False,
        "tensorboard": False,
        "tensorboard_always_on": False,
        "cloud": {"enabled": False},
        "multi_gpu": False,
    }, migrate=False)
    checkpoint = find_checkpoint(checkpoints, digest(workspace / "export.json"))
    if os.environ.get("SHADOW_LORA_EPOCH_BACKUPS") == "1":
        # Character datasets and settings are frozen within each workspace.
        config.clear_cache_before_training = False
        if checkpoint:
            saved = json.loads((checkpoint / "shadow-checkpoint.json").read_text(encoding="utf-8"))
            if saved.get("epoch") == config.epochs and saved.get("epoch_step") == 0:
                candidate = workspace / "epoch-candidates" / (
                    f"epoch-{saved['epoch']:06d}-step-{saved['global_step']:010d}.safetensors"
                )
                if candidate.is_file():
                    if (attempt / "pause").exists():
                        return 75
                    shutil.copyfile(candidate, output)
                    return finish_export(workspace, attempt, output)
    backup_dir = attempt / "backup"
    backup_dir.mkdir(exist_ok=True)
    if checkpoint:
        config.lora_model_name = str(checkpoint)
        config.clear_cache_before_training = False
        print(f"Resuming from {checkpoint.name}", flush=True)
    elif any(checkpoints.iterdir()):
        raise RuntimeError("No verified recovery checkpoint remains")
    elif parent_checkpoint:
        config.lora_model_name = str(parent_checkpoint)
        print(f"Continuing with a fresh dataset cache from {parent_checkpoint.name}", flush=True)
    commands = TrainCommands()
    callbacks = TrainCallbacks()
    trainer = create.create_trainer(config, callbacks, commands)

    save_backup = trainer._GenericTrainer__backup
    trainer._GenericTrainer__needs_backup = lambda progress: False
    trainer._GenericTrainer__needs_save = lambda progress: False
    pause_file = attempt / "pause"
    next_checkpoint = time.monotonic() + 300 if checkpoint else 0
    epoch_backups = os.environ.get("SHADOW_LORA_EPOCH_BACKUPS") == "1"
    last_boundary = None
    finalize_revision = False


    def backup(progress, print_msg=True):

        root = attempt / "backup"
        before = set(root.iterdir())
        save_backup(progress, print_msg)
        created = [item for item in set(root.iterdir()) - before if item.is_dir()]
        if not created:
            raise RuntimeError("OneTrainer checkpoint failed")
        for item in created:
            publish_checkpoint(item, checkpoints, progress, digest(workspace / "export.json"))
        if pause_file.exists():
            commands.stop()

    def progress(train_progress, batches, total_epochs):
        nonlocal next_checkpoint, last_boundary, finalize_revision
        epoch_boundary = (
            epoch_backups and train_progress.epoch > 0 and train_progress.epoch_step == 0
            and train_progress.epoch != last_boundary
        )
        if epoch_boundary:
            snapshot = attempt / "progress.json"
            snapshot.write_text(json.dumps({
                "epoch": train_progress.epoch,
                "globalStep": train_progress.global_step,
                "batchesInEpoch": batches,
                "totalEpochs": total_epochs,
            }), encoding="utf-8")
            snapshot.replace(workspace / "progress.json")
            backup(train_progress)
            candidates = workspace / "epoch-candidates"
            candidates.mkdir(exist_ok=True)
            candidate = candidates / f"epoch-{train_progress.epoch:06d}-step-{train_progress.global_step:010d}.safetensors"
            if not candidate.exists():
                temporary = attempt / f"candidate-{uuid.uuid4().hex}.safetensors"
                trainer.model_saver.save(
                    model=trainer.model,
                    model_type=config.model_type,
                    output_model_format=config.output_model_format,
                    output_model_destination=str(temporary),
                    dtype=config.output_dtype.torch_dtype(),
                )
                with safe_open(temporary, framework="pt") as adapter:
                    if not adapter.keys():
                        raise RuntimeError("OneTrainer exported an empty epoch adapter")
                with temporary.open("r+b") as stream:
                    os.fsync(stream.fileno())
                temporary.replace(candidate)
            last_boundary = train_progress.epoch
            next_checkpoint = time.monotonic() + 300
            try:
                transition = (attempt / "epoch-transition").read_text(encoding="utf-8")
            except FileNotFoundError:
                transition = ""
            if transition in ("prepare-at-epoch", "revision-at-epoch") and not pause_file.exists():
                finalize_revision = transition == "revision-at-epoch"
                commands.stop()
            return
        if pause_file.exists() or time.monotonic() >= next_checkpoint:
            commands.backup()
            next_checkpoint = time.monotonic() + 300

    trainer._GenericTrainer__backup = backup
    callbacks.set_on_update_train_progress(progress)
    if pause_file.exists():
        return 75
    trainer.start()
    if parent_checkpoint and not checkpoint:
        loaded = trainer.model.train_progress
        if (loaded.epoch, loaded.epoch_step, loaded.global_step) != (
            parent_progress["epoch"], 0, parent_progress["global_step"]
        ) or trainer.model.optimizer is None or not trainer.model.optimizer.state:
            raise RuntimeError("OneTrainer did not restore full progress and optimizer state")
    if pause_file.exists():
        return 75
    trainer.train()
    if commands.get_stop_command() and not finalize_revision:
        return 75
    trainer.end()
    if not output.is_file() and checkpoint and epoch_backups:
        saved = json.loads((checkpoint / "shadow-checkpoint.json").read_text(encoding="utf-8"))
        if saved.get("epoch") == config.epochs and saved.get("epoch_step") == 0:
            candidate = workspace / "epoch-candidates" / (
                f"epoch-{saved['epoch']:06d}-step-{saved['global_step']:010d}.safetensors"
            )
            if candidate.is_file():
                shutil.copyfile(candidate, output)
    del save_backup, trainer, callbacks, commands
    gc.collect()
    torch.cuda.empty_cache()
    return finish_export(workspace, attempt, output)


def finish_export(workspace, attempt, output):
    from safetensors import safe_open

    if not output.is_file():
        raise RuntimeError("OneTrainer completed without writing its final adapter")
    trigger = os.environ.get("SHADOW_LORA_VERSION_TRIGGER")
    if trigger:
        publish_epoch_adapters(workspace, attempt, trigger)
    with safe_open(output, framework="pt") as model:
        if not model.keys():
            raise RuntimeError("OneTrainer produced an empty adapter")
    with output.open("r+b") as stream:
        os.fsync(stream.fileno())
    final_temp = workspace / f".model-{uuid.uuid4().hex}.safetensors"
    shutil.copyfile(output, final_temp)
    with final_temp.open("r+b") as stream:
        os.fsync(stream.fileno())
    with safe_open(final_temp, framework="pt") as model:
        if not model.keys():
            final_temp.unlink(missing_ok=True)
            raise RuntimeError("Published adapter failed validation")
    final_temp.replace(workspace / "model.safetensors")
    return 0


if __name__ == "__main__":
    # The coordinator assigns the process to its Windows Job Object before releasing it.
    if sys.stdin.buffer.read(1) != b"1":
        sys.exit(74)
    sys.exit(train(Path(sys.argv[1]), Path(sys.argv[2])))
