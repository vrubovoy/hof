# The open gate of the founding page (setup-gate-open.webp, over scene-setup at 424,440, 2×): the
# doorway of the sign-in scene with its gate open, laid over the doorway of the founding scene. Only
# the doors change. The frame ends above the bottom of the doors, so the floor stays of the
# founding scene, and it is transparent exactly over the head of the founding cat with its light
# outline, so the cat stays and no piece of the closed door shows beside it.
# The doorway itself is the alpha of the frame as it was cut in M10: below the row REF its sides
# are straight, so that row is carried down where the cat was cut out before. Running it again
# gives the same frame.
# usage: gate.py <static img dir>  (reads login-desktop-v2@2x.webp, rewrites setup-gate-open.webp)
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

img = sys.argv[1]
X, Y = 424, 440                  # the frame on the 1x scenes
REF = 700                        # a row of the doorway above the cat (1x)
DOORS_END = 772                  # the first row of the dark line under the doors (1x)
# the head of the founding cat with its light outline (1x, measured on scene-setup.png)
CAT = [(588.5, 772), (589, 765), (589.5, 758), (590.5, 751), (592.5, 746), (595, 742.5), (598, 743.5), (601.5, 748),
       (604, 750.5), (614, 750.5), (618, 747), (621.5, 743.5), (624.5, 744), (627, 749), (628, 756), (628.5, 763), (628, 772)]

frame = Image.open(f'{img}/setup-gate-open.webp').convert('RGBA')
W, H = frame.size
alpha = np.asarray(frame)[..., 3].astype(np.float32)
ref = 2 * (REF - Y)
alpha[ref:] = alpha[ref]
alpha[2 * (DOORS_END - Y):] = 0
cut = Image.new('L', (W, H), 0)
ImageDraw.Draw(cut).polygon([(2 * (x - X), 2 * (y - Y)) for x, y in CAT], 255)
alpha *= 1 - np.asarray(cut.filter(ImageFilter.GaussianBlur(0.8))).astype(np.float32) / 255
doors = np.asarray(Image.open(f'{img}/login-desktop-v2@2x.webp').convert('RGB'))[2 * Y:2 * Y + H, 2 * X:2 * X + W]
Image.fromarray(np.dstack([doors, alpha.round().astype(np.uint8)]), 'RGBA').save(
    f'{img}/setup-gate-open.webp', method=6, quality=82, alpha_quality=100)
print('setup-gate-open.webp', W, H)
