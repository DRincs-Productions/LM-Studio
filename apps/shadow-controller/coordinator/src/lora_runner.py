"""Run the local OneTrainer installation under Shadow Controller."""
import hashlib
import json
import os
from pathlib import Path
import shutil
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
            with path.open("r+b") as stream:
                os.fsync(stream.fileno())
                files[path.relative_to(source).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
    with (source / "shadow-checkpoint.json").open("x", encoding="utf-8") as stream:
        json.dump(files, stream)
        stream.flush()
        os.fsync(stream.fileno())
    destination = checkpoints / f"{time.time_ns():020d}-step-{step}-{uuid.uuid4().hex}"
    source.rename(destination)
    for old in sorted(checkpoints.iterdir(), reverse=True)[2:]:
        shutil.rmtree(old)


def find_checkpoint(checkpoints):
    for path in sorted(checkpoints.iterdir(), reverse=True):
        try:
            files = json.loads((path / "shadow-checkpoint.json").read_text(encoding="utf-8"))
            if files and all(digest(path / name) == value for name, value in files.items()):
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
    config = TrainConfig.default_values()
    config.from_dict(exported)
    if config.training_method.name != "LORA":
        raise ValueError("Select LoRA training in OneTrainer")
    enabled_concepts = [concept for concept in (config.concepts or []) if concept.enabled]
    if not enabled_concepts or not all(Path(concept.path).is_dir() for concept in enabled_concepts):
        raise ValueError("Export training with accessible local dataset paths")
    if not config.base_model_name or not Path(config.base_model_name).is_absolute() or not Path(config.base_model_name).exists():
        raise ValueError("Export training with an accessible local base model")

    checkpoints = workspace / "checkpoints"
    checkpoints.mkdir(exist_ok=True)
    output = attempt / "model.safetensors"
    config.from_dict({
        "workspace_dir": str(attempt),
        "cache_dir": str(workspace / "cache"),
        "huggingface_cache_dir": str(workspace / "hub"),
        "quantization": {"cache_dir": str(workspace / "cache" / "quantization")},
        "output_model_destination": str(output),
        "output_model_format": "SAFETENSORS",
        "continue_last_backup": False,
        "rolling_backup": False,
        "backup_before_save": False,
        "tensorboard": False,
        "tensorboard_always_on": False,
        "cloud": {"enabled": False},
    }, migrate=False)
    checkpoint = find_checkpoint(checkpoints)
    if checkpoint:
        config.lora_model_name = str(checkpoint)
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

    def backup(progress, print_msg=True):
        root = attempt / "backup"
        before = set(root.iterdir()) if root.exists() else set()
        save_backup(progress, print_msg)
        created = set(root.iterdir()) - before if root.exists() else set()
        if len(created) != 1:
            raise RuntimeError("OneTrainer checkpoint failed")
        publish_checkpoint(created.pop(), checkpoints, progress.global_step)
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
    trainer.start()
    trainer.train()
    if commands.get_stop_command():
        return 75
    if pause_file.exists() and trainer.one_step_trained:
        backup(trainer.model.train_progress)
        return 75
    trainer.end()
    with safe_open(output, framework="pt") as model:
        if not model.keys():
            raise RuntimeError("OneTrainer produced an empty adapter")
    with output.open("r+b") as stream:
        os.fsync(stream.fileno())
    output.rename(workspace / "model.safetensors")
    return 0


if __name__ == "__main__":
    # The coordinator assigns the process to its Windows Job Object before releasing it.
    if sys.stdin.buffer.read(1) != b"1":
        sys.exit(74)
    sys.exit(train(Path(sys.argv[1]), Path(sys.argv[2])))
