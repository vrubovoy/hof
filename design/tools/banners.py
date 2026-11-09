# Frames of the banners on the courtyard map, swaying gently: the same pixels, the cloth under the
# pole bends in a wave running down; at the pole it stays, towards the tail it swings more.
# Only the cloth moves. It is a layer cut by the outer outline of the cloth and moved together
# with that outline; the strip of wall it uncovers is filled from the wall beside it. Outside the
# cloth and its swing a frame is transparent, so the wall, the arch and the sky stay as on the map.
# usage: banners.py scene-courtyard-map.png <dir> → <dir>/<name>-f0…f7.png; prints for each banner
#        the place of its frames and the pixels that change between frames outside the cloth
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

src, outdir = sys.argv[1], sys.argv[2]
full = np.asarray(Image.open(src).convert('RGB')).astype(np.float32)
# name: x0, x1 of the cloth, y under the pole, y of the tip, swing in px; the outer outline of the
# cloth (pixel edges, measured on the map: the top, the sides, where the tail begins, the tip)
BANNERS = {
    'banner-gate-l': (60, 112, 388, 508, 1.6, [(62.0, 384), (110.7, 384), (111.7, 472.7), (87.0, 508.6), (62.1, 475.1)]),
    'banner-gate-r': (318, 366, 388, 505, 1.6, [(322.1, 384), (364.0, 384), (364.0, 470.5), (344.0, 502.8), (320.0, 468.7)]),
    'banner-tower': (1452, 1520, 312, 500, 1.9, [(1455.9, 308), (1519.4, 308), (1519.8, 456.8), (1489.2, 500.5), (1456.1, 453.7)]),
}
PAD = 10
N = 8


def fill(img, hole, rounds=6):
    """The pixels of `hole` from their known neighbours, ring by ring from its edge. A pixel at the
    edge of the frame has no neighbour beyond it."""
    img = img.copy(); known = ~hole
    H, W = hole.shape
    for _ in range(rounds):
        acc = np.zeros_like(img); cnt = np.zeros(hole.shape, np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            # each pixel takes its neighbour at (y - dy, x - dx), where there is one
            to = (slice(max(dy, 0), H + min(dy, 0)), slice(max(dx, 0), W + min(dx, 0)))
            fro = (slice(max(-dy, 0), H + min(-dy, 0)), slice(max(-dx, 0), W + min(-dx, 0)))
            k = known[fro]; acc[to] += img[fro] * k[..., None]; cnt[to] += k
        new = ~known & (cnt > 0)
        img[new] = acc[new] / cnt[new][:, None]; known |= new
    return img


def shift_x(img, x, yy):
    """Each pixel from x of its row, linearly between the two nearest."""
    W = img.shape[1]
    x = np.clip(x, 0, W - 1.001); xi = np.floor(x).astype(int); fx = x - xi
    if img.ndim == 3: fx = fx[..., None]
    return img[yy, xi] * (1 - fx) + img[yy, np.minimum(xi + 1, W - 1)] * fx


for name, (x0, x1, ytop, ytip, amp, outline) in BANNERS.items():
    bx0, by0, bx1, by1 = x0 - PAD, ytop - 4, x1 + PAD, ytip + PAD
    img = full[by0:by1, bx0:bx1]; H, W = img.shape[:2]
    # the cloth: whole pixels whose centre is inside the outline, and one pixel more all round, so no
    # pixel of the outline stays behind on the wall
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).polygon([(x - bx0 - 0.5, y - by0 - 0.5) for x, y in outline], 255)
    cloth = np.asarray(m.filter(ImageFilter.MaxFilter(3))) > 0
    wall = fill(img, cloth)
    yy, xx = np.mgrid[0:H, 0:W]
    # swing: 0 at the pole, full towards the tail
    k = np.clip((yy - 4) / (ytip - ytop), 0, 1) ** 1.2
    layer, cover = img * cloth[..., None], cloth.astype(np.float32)
    drawn = []
    for i in range(N):
        ph = 2 * np.pi * i / N
        x = xx - amp * k * np.sin(2 * np.pi * yy / 70 - ph)
        c = shift_x(cover, x, yy)
        rgb = shift_x(layer, x, yy) + wall * (1 - c[..., None])
        shown = cloth | (c > 0)
        Image.fromarray(np.dstack([np.clip(rgb, 0, 255), shown * 255]).astype(np.uint8), 'RGBA').save(f'{outdir}/{name}-f{i}.png')
        drawn.append(np.where(shown[..., None], rgb, img))
    drawn = np.stack(drawn)
    changed = (drawn.max(0) - drawn.min(0)).max(-1) > 0.5
    # where the cloth can reach: itself and its swing to either side
    reach = cloth.copy()
    for s in range(1, int(np.ceil(amp)) + 1):
        reach[:, s:] |= cloth[:, :-s]; reach[:, :-s] |= cloth[:, s:]
    outside = int((changed & ~reach).sum())
    print(f'{name} {bx0} {by0} {W} {H}: between frames {outside} px change outside the cloth '
          f'and its swing, {(changed & reach & ~cloth).sum()} px where it swings over the wall')
    if outside: sys.exit(f'{name}: the wall moves')
