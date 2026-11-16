"""Run the local OneTrainer installation under Shadow Controller."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import time
import uuid


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def publish_checkpoint(source, checkpoints, step):
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
        json.dump(files, stream)
        stream.flush()
        os.fsync(stream.fileno())
    for path in source.rglob("*"):
        if path.is_file():
            path.chmod(path.stat().st_mode & ~stat.S_IWUSR & ~stat.S_IWGRP & ~stat.S_IWOTH)
        elif path.is_dir():
            path.chmod(path.stat().st_mode & ~stat.S_IWUSR & ~stat.S_IWGRP & ~stat.S_IWOTH)
    destination = checkpoints / f"{time.time_ns():020d}-step-{step}-{uuid.uuid4().hex}"
    temporary = checkpoints / f".publishing-{uuid.uuid4().hex}"
    shutil.copytree(source, temporary)
    source_hashes = {name: digest(source / name) for name in files}
    if any(digest(temporary / name) != value for name, value in source_hashes.items()):
        shutil.rmtree(temporary, ignore_errors=True)
        raise RuntimeError("Checkpoint copy failed integrity verification")
    temporary.rename(destination)
    for old in sorted((item for item in checkpoints.iterdir() if not item.name.startswith(".")), reverse=True)[2:]:
        shutil.rmtree(old)


def find_checkpoint(checkpoints, expected_export):
    expected = json.loads(expected_export.read_text(encoding="utf-8"))
    expected.pop("lora_model_name", None)
    for path in sorted(checkpoints.iterdir(), reverse=True):
        try:
            files = json.loads((path / "shadow-checkpoint.json").read_text(encoding="utf-8"))
            if not files or not all(digest(path / name) == value for name, value in files.items()):
                continue
            args = json.loads((path / "onetrainer_config" / "args.json").read_text(encoding="utf-8"))
            if args.pop("lora_model_name", None):
                args["lora_model_name"] = ""
            expected_args = dict(expected)
            if expected_args.pop("lora_model_name", None):
                expected_args["lora_model_name"] = ""
            if args == expected_args:
                return path
        except (OSError, ValueError):
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
        "output_model_format": "SAFETENSORS",
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
        "backup_before_save": False,
        "tensorboard": False,
        "tensorboard_always_on": False,
        "cloud": {"enabled": False},
    }, migrate=False)
    checkpoint = find_checkpoint(checkpoints, workspace / "export.json")
    backup_dir = attempt / "backup"
    backup_dir.mkdir(exist_ok=True)
    if checkpoint:
        recovery_backup = backup_dir / f"{checkpoint.name}-backup"
        recovery_backup.mkdir(exist_ok=False)
        shutil.copytree(checkpoint, recovery_backup, dirs_exist_ok=True)
        onetrainer_config = recovery_backup / "onetrainer_config"
        args = json.loads((onetrainer_config / "args.json").read_text(encoding="utf-8"))
        args.pop("__version", None)
        args.update({
            "workspace_dir": str(attempt),
            "cache_dir": str(workspace / "cache"),
            "huggingface_cache_dir": str(workspace / "hub"),
            "concept_file_name": str(onetrainer_config / "concepts.json"),
            "sample_definition_file_name": str(onetrainer_config / "samples.json"),
            "continue_last_backup": True,
            "prevent_overwrites": False,
        })
        args.pop("__version", None)
        (onetrainer_config / "args.json").write_text(json.dumps(args), encoding="utf-8")
        config.continue_last_backup = True
        config.lora_model_name = str(recovery_backup)
        print(f"Resuming from {checkpoint.name}", flush=True)
    elif any(checkpoints.iterdir()):
        raise RuntimeError("No verified recovery checkpoint remains")
    commands = TrainCommands()
    callbacks = TrainCallbacks()
    trainer = create.create_trainer(config, callbacks, commands)

    save_backup = trainer._GenericTrainer__backup
    trainer._GenericTrainer__needs_backup = lambda progress: False
    trainer._GenericTrainer__needs_save = lambda progress: False
    pause_file = attempt / "pause"
    next_checkpoint = time.monotonic() + 300
    last_checkpoint = checkpoint

    def backup(progress, print_msg=True):
        nonlocal last_checkpoint
        root = attempt / "backup"
        before = set(root.iterdir())
        save_backup(progress, print_msg)
        created = [item for item in set(root.iterdir()) - before if item.is_dir()]
        if not created:
            raise RuntimeError("OneTrainer checkpoint failed")
        for item in created:
            publish_checkpoint(item, checkpoints, progress.global_step)
        last_checkpoint = find_checkpoint(checkpoints, workspace / "export.json")
        for path in list(backup_root for backup_root in root.iterdir() if backup_root.is_dir()):
            if path.name.endswith("-backup"):
                shutil.rmtree(path)
        if pause_file.exists():
            commands.stop()

    def progress(*_):
        nonlocal next_checkpoint
        if pause_file.exists() or time.monotonic() >= next_checkpoint:
            commands.backup()
            next_checkpoint = time.monotonic() + 300

    trainer._GenericTrainer__backup = backup
    callbacks.set_on_update_train_progress(progress)
    if pause_file.exists():
        return 75
    # A pause request may arrive during model loading or dataset caching, before
    # the first optimization step. Preserve the current state before returning.
    try:
        trainer.start()
    except BaseException:
        if trainer.model is not None:
            trainer.model.evict()
        raise
    if pause_file.exists() and last_checkpoint is None:
        # Checkpoints require an optimizer state initialized by the first step.
        # If paused before then, release the loaded model and restart this attempt
        # later from its original config rather than reporting false recovery.
        commands.stop()
    trainer.train()
    if commands.get_stop_command():
        if last_checkpoint is None:
            trainer._GenericTrainer__backup(trainer.model.train_progress)
            if not find_checkpoint(checkpoints, workspace / "export.json"):
                raise RuntimeError("OneTrainer did not publish a recoverable checkpoint")
        return 75
    trainer.end()
    if not output.is_file():
        raise RuntimeError("OneTrainer completed without writing its final adapter")
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
