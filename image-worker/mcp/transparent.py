"""Produce an alpha PNG and a checkerboard review preview for an image job."""

import sys
from pathlib import Path

from PIL import Image
from rembg import new_session, remove


def main(source, output, preview, model):
    with Image.open(source) as image:
        cutout = remove(image.convert("RGB"), session=new_session(model))
        if cutout.mode != "RGBA" or cutout.size != image.size:
            raise ValueError("Background removal returned unexpected image metadata")

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

    with Path(output).open("xb") as file:
        cutout.save(file, format="PNG")
    with Path(preview).open("xb") as file:
        checker.convert("RGB").save(file, format="PNG")


if __name__ == "__main__":
    main(*sys.argv[1:])
