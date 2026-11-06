"""Takes the two drawn birds out of the sky of the courtyard map.

The living flock (fx-birds) flies over the courtyard with «Анимации»; the two birds drawn into the
picture stood still beside it. Each bird is covered by the plain sky 45 px above it, pixel by pixel:
the map is a PNG with a palette, so only indices are copied — the palette and every pixel outside
the two boxes stay as they are. A pixel of a bird is one bluer than the paper, grown by 3 px for its
soft edge. A second run finds no bird and changes nothing.

    python3 sky.py generated/scene-courtyard-map.png
"""

import sys

import numpy as np
from PIL import Image

# The boxes of the birds in the map 1536×1024 (x0, y0, x1, y1), with a margin.
BIRDS = [(480, 110, 525, 140), (548, 82, 600, 112)]
# Where the sky is taken from: the same columns this many pixels higher.
UP = 45
# A pixel bluer than the paper by more than this is ink (the paper: blue under red by 20–30).
INK = 0
GROW = 3


def main(path: str) -> None:
    image = Image.open(path)
    assert image.mode == "P", "the map is expected with a palette"
    index = np.array(image)
    rgb = np.array(image.convert("RGB")).astype(int)
    changed = 0
    for x0, y0, x1, y1 in BIRDS:
        box = rgb[y0:y1, x0:x1]
        ink = (box[..., 2] - box[..., 0]) > INK
        grown = ink.copy()
        for _ in range(GROW):
            g = grown.copy()
            g[1:, :] |= grown[:-1, :]
            g[:-1, :] |= grown[1:, :]
            g[:, 1:] |= grown[:, :-1]
            g[:, :-1] |= grown[:, 1:]
            grown = g
        sky = rgb[y0 - UP : y1 - UP, x0:x1]
        assert not ((sky[..., 2] - sky[..., 0]) > INK).any(), "the sky above a bird has ink in it"
        target = index[y0:y1, x0:x1]
        source = index[y0 - UP : y1 - UP, x0:x1]
        changed += int((target[grown] != source[grown]).sum())
        target[grown] = source[grown]
    out = Image.frombytes("P", image.size, index.tobytes())
    out.putpalette(image.getpalette())
    out.save(path, optimize=False)
    print(f"{path}: {changed} pixels of the sky put over the birds")


if __name__ == "__main__":
    main(sys.argv[1])
