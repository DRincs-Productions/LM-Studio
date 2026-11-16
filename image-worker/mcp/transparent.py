"""Produce an alpha PNG and a checkerboard review preview for an image job."""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from rembg import new_session, remove


def main(source, output, preview, model):
    with Image.open(source) as image:
        session = new_session(model)
        cutout = remove(image.convert("RGB"), session=session)
        if cutout.mode != "RGBA" or cutout.size != image.size:
            raise ValueError("Background removal returned unexpected image metadata")
        if model == "isnet-anime":
            rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
            alpha = np.asarray(cutout.getchannel("A"), dtype=np.uint8)
            background = rgb[0, 0].astype(np.int16)
            border = np.concatenate((rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1])).astype(np.int16)
            flat_background = np.mean(np.max(np.abs(border - background), axis=1) <= 8) >= 0.85
            if flat_background:
                distance = np.max(np.abs(rgb.astype(np.int16) - background), axis=2)
                # Clear only near-exact pixels of the generated flat backdrop,
                # preserving the antialiased subject boundary.
                alpha[distance <= 8] = 0
                cutout.putalpha(Image.fromarray(alpha, mode="L"))

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


def candidate_preview(source, cutout, preview, output):
    boxes = background_candidates(source, cutout)
    if not boxes:
        print("[]")
        return
    with Image.open(preview) as image:
        width, height = image.size
        sheet = Image.new("RGB", (480, ((len(boxes) + 1) // 2) * 184), "#eeeeee")
        draw = ImageDraw.Draw(sheet)
        for index, box in enumerate(boxes):
            left, top, right, bottom = box
            bounds = (max(0, left * width // 1000 - 12),
                      max(0, top * height // 1000 - 12),
                      min(width, right * width // 1000 + 12),
                      min(height, bottom * height // 1000 + 12))
            crop = image.crop(bounds)
            scale = min(220 / crop.width, 154 / crop.height)
            crop = crop.resize((max(1, round(crop.width * scale)),
                                max(1, round(crop.height * scale))))
            x, y = (index % 2) * 240, (index // 2) * 184
            draw.text((x + 4, y + 4), str(box), fill="#222222")
            sheet.paste(crop, (x + 4, y + 22))
        with Path(output).open("xb") as file:
            sheet.save(file, format="PNG")
    print(json.dumps(boxes))


if __name__ == "__main__":
    if sys.argv[1] == "--evidence":
        candidate_preview(*sys.argv[2:])
    elif sys.argv[1] == "--inspect":
        print(json.dumps(background_candidates(*sys.argv[2:])))
    elif sys.argv[1] == "--preview":
        with Image.open(sys.argv[2]) as image:
            make_preview(image, sys.argv[3])
    else:
        main(*sys.argv[1:])
