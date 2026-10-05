import json
import math
import os
import sys
import hashlib
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(r"C:\Users\Shadow\.lmstudio\audio\worker").resolve()
ASSETS = Path(r"C:\AI\assets").resolve()
WORK = ROOT / "work"


def checked_audio(path_text: str) -> Path:
    p = Path(path_text).resolve(strict=True)
    allowed = [ROOT, ASSETS]
    if p.suffix.lower() not in {".wav", ".flac", ".ogg"}:
        raise ValueError("Only WAV, FLAC, and OGG inputs are accepted.")
    if not any(p == root or root in p.parents for root in allowed):
        raise ValueError("Audio path must be inside the Audio Worker staging folder or C:\\AI\\assets.")
    if not p.is_file():
        raise ValueError("Input path is not a file.")
    return p


def inspect(path_text: str) -> dict:
    p = checked_audio(path_text)
    info = sf.info(str(p))
    data, sr = sf.read(str(p), dtype="float32", always_2d=True)
    finite = bool(np.isfinite(data).all())
    clean = np.nan_to_num(data, nan=0.0, posinf=0.0, neginf=0.0)
    peak = float(np.max(np.abs(clean))) if clean.size else 0.0
    rms = float(np.sqrt(np.mean(np.square(clean, dtype=np.float64)))) if clean.size else 0.0
    frame = max(1, min(int(sr * 0.1), len(clean) // 2))
    boundary = None
    if len(clean) >= frame * 2:
        first = clean[:frame].astype(np.float64)
        last = clean[-frame:].astype(np.float64)
        boundary = {
            "first_100ms_rms": round(float(np.sqrt(np.mean(first * first))), 7),
            "last_100ms_rms": round(float(np.sqrt(np.mean(last * last))), 7),
            "boundary_sample_jump": round(float(np.sqrt(np.mean(np.square(clean[0] - clean[-1])))), 7),
            "first_last_100ms_rms_delta": round(float(abs(np.sqrt(np.mean(first * first)) - np.sqrt(np.mean(last * last)))), 7),
        }
    digest = hashlib.sha256(p.read_bytes()).hexdigest()
    return {
        "path": str(p), "format": info.format, "subtype": info.subtype,
        "sample_rate": sr, "channels": info.channels, "frames": info.frames,
        "duration_seconds": round(info.duration, 4), "finite_samples": finite,
        "peak": round(peak, 7), "rms": round(rms, 7),
        "clipped_sample_fraction": round(float(np.mean(np.abs(clean) >= 0.999)), 8),
        "boundary_metrics_diagnostic_only": boundary,
        "sha256": digest,
        "note": "Boundary metrics do not establish a perceptually seamless loop; audition repeated playback.",
    }


def preview_loop(path_text: str, start: float, end: float, repeats: int, crossfade: float, out_text: str) -> dict:
    src = checked_audio(path_text)
    data, sr = sf.read(str(src), dtype="float32", always_2d=True)
    if start < 0 or end <= start or end > len(data) / sr:
        raise ValueError("Loop range must be inside the source duration and end must exceed start.")
    if repeats < 2 or repeats > 20:
        raise ValueError("repeats must be between 2 and 20.")
    if crossfade < 0 or crossfade > min(5.0, (end - start) / 2):
        raise ValueError("crossfade must be 0 to 5 seconds and no longer than half the loop range.")
    a, b = int(round(start * sr)), int(round(end * sr))
    segment = data[a:b].copy()
    nfade = int(round(crossfade * sr))
    if nfade:
        # Smooth the junction within a preview copy only; original is never modified.
        tail = segment[-nfade:].copy()
        head = segment[:nfade].copy()
        ramp = np.linspace(0.0, 1.0, nfade, endpoint=False, dtype=np.float32)[:, None]
        seam = tail * (1.0 - ramp) + head * ramp
        segment = np.concatenate([segment[:-nfade], seam], axis=0)
    result = np.tile(segment, (repeats, 1))
    out = Path(out_text).resolve()
    if not (ROOT == out or ROOT in out.parents):
        raise ValueError("Preview output must remain inside the Audio Worker staging folder.")
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out), result, sr, subtype="PCM_24")
    return {"preview": str(out), "source": str(src), "loop_start_seconds": start,
            "loop_end_seconds": end, "repeats": repeats, "crossfade_seconds": crossfade,
            "duration_seconds": round(len(result) / sr, 4),
            "note": "Listen to the repeated preview. The original asset was not altered."}


def main():
    req = json.load(sys.stdin)
    op = req.get("operation")
    if op == "inspect":
        result = inspect(req["path"])
    elif op == "loop_preview":
        result = preview_loop(req["path"], float(req["start_seconds"]), float(req["end_seconds"]),
                              int(req["repeats"]), float(req.get("crossfade_seconds", 0)), req["output_path"])
    else:
        raise ValueError(f"Unknown operation: {op}")
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(2)
