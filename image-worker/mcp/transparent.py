"""Produce an alpha PNG and a checkerboard review preview for an image job."""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage
from rembg import new_session, remove


def main(source, output, preview, model):
    with Image.open(source) as image:
        cutout = remove(image.convert("RGB"), session=new_session(model))
        if cutout.mode != "RGBA" or cutout.size != image.size:
            raise ValueError("Background removal returned unexpected image metadata")

    with Path(output).open("xb") as file:
        cutout.save(file, format="PNG")
    make_preview(cutout, preview)


def make_preview(cutout, preview):
    if cutout.mode != "RGBA":
        raise ValueError("The cutout must be RGBA")
    alpha_min, alpha_max = cutout.getchannel("A").getextrema()
    if alpha_min != 0 or alpha_max != 255:
        raise ValueError("The cutout needs transparent and opaque pixels")

    width, height = cutout.size
    tile = Image.new("RGBA", (32, 32), "#dedede")
    tile.paste("#aaaaaa", (0, 0, 16, 16))
    tile.paste("#aaaaaa", (16, 16, 32, 32))
    checker = Image.new("RGBA", cutout.size)
    for y in range(0, height, 32):
        for x in range(0, width, 32):
            checker.paste(tile, (x, y))
    checker.alpha_composite(cutout)

    with Path(preview).open("xb") as file:
        checker.convert("RGB").save(file, format="PNG")


def background_candidates(source, cutout):
    with Image.open(source) as image:
        rgb = np.asarray(image.convert("RGB"), dtype=np.int16)
    with Image.open(cutout) as image:
        alpha = np.asarray(image.getchannel("A"))
    border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]))
    color = np.median(border, axis=0)
    if np.mean(np.max(np.abs(border - color), axis=1) <= 24) < 0.6:
        return []
    same_color = np.max(np.abs(rgb - color), axis=2) <= 16
    labels, _ = ndimage.label(same_color & (alpha >= 128))
    counts = np.bincount(labels.ravel())
    height, width = alpha.shape
    regions = []
    objects = ndimage.find_objects(labels)
    for label in np.argsort(counts[1:])[::-1][:8] + 1:
        if counts[label] < 16:
            break
        y, x = objects[label - 1]
        regions.append([round(x.start * 1000 / width), round(y.start * 1000 / height),
                        round(x.stop * 1000 / width), round(y.stop * 1000 / height)])
    return regions


if __name__ == "__main__":
    if sys.argv[1] == "--inspect":
        print(json.dumps(background_candidates(*sys.argv[2:])))
    elif sys.argv[1] == "--preview":
        with Image.open(sys.argv[2]) as image:
            make_preview(image, sys.argv[3])
    else:
        main(*sys.argv[1:])
