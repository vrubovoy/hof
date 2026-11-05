# Frames of a gust of wind in the foliage on the courtyard map: the same pixels, the crown sways
# from the trunk (the top more), the leaves tremble. A frame «at rest» is not needed: at rest the
# layer is hidden. Pixels are taken bicubically (Catmull-Rom) so the hatching does not blur; the
# frames are then enlarged 2× the same way as the map (see asset-prompt.txt, «Обработка»).
# Only the foliage moves. It is a layer: dense ink inside a polygon that keeps out what stands next
# to the plant (the rim of the fountain, a pot, a wall, a beam, a roof, barrels, flowers), with its
# small holes filled. The strip of ground it uncovers is filled from the ground beside it; outside
# the foliage and its sway a frame is transparent, so everything around stays as on the map.
# usage: leaves.py scene-courtyard-map.png <dir> → <dir>/<name>-f0…f7.png; prints for each region
#        the place of its frames and the pixels that change between frames outside the foliage
import sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

src, outdir = sys.argv[1], sys.argv[2]
full = np.asarray(Image.open(src).convert('RGB')).astype(np.float32)
# name: frame (x0, y0, x1, y1), polygon where the leaves are, bottom of the crown (no sway at the
# trunk), sway in px, the largest hole inside the foliage that is still foliage (px)
REGIONS = {
    'olive': ((0, 620, 570, 890), [(0, 682), (60, 684), (110, 690), (140, 668), (190, 647), (240, 637), (300, 634), (360, 634),
                                   (410, 648), (450, 660), (490, 686), (530, 716), (552, 742), (545, 768), (520, 790), (480, 805),
                                   (430, 812), (395, 826), (350, 832), (340, 890), (0, 890)], 890, 2.4, 120),
    'bush-l': ((540, 592, 700, 732), [(546, 640), (575, 596), (640, 590), (692, 630), (692, 656), (672, 659), (655, 662), (630, 667),
                                      (605, 675), (588, 686), (578, 694), (566, 699), (552, 702), (544, 690)], 726, 1.6, 150),
    'bush-r': ((880, 598, 1062, 742), [(894, 652), (920, 604), (990, 597), (1052, 640), (1060, 690), (1056, 724), (1035, 724),
                                       (1010, 721), (985, 723), (975, 724), (973, 708), (970, 690), (953, 673), (930, 666),
                                       (902, 661)], 738, 1.6, 150),
    'tree': ((400, 226, 566, 430), [(410, 300), (430, 262), (450, 245), (480, 238), (500, 242), (510, 249), (512, 258), (513, 268),
                                    (518, 275), (533, 265), (534, 330),
                                    (531, 380), (518, 405), (495, 425), (462, 408), (440, 402), (431, 396), (431, 350),
                                    (412, 345)], 425, 1.8, 60),
}
ENV = [0.2, 0.6, 1.0, 0.8, 0.45, 0.05, -0.2, -0.08]   # swayed, came back, a little past; ends ≈ 0, no jerk
SPECK = 30                                             # dense ink smaller than this is not foliage


def cubic(img, x, y):
    H, W = img.shape[:2]
    xi, yi = np.floor(x).astype(int), np.floor(y).astype(int); tx, ty = x - xi, y - yi
    def w(t):
        return [(-t**3 + 2*t**2 - t) / 2, (3*t**3 - 5*t**2 + 2) / 2, (-3*t**3 + 4*t**2 + t) / 2, (t**3 - t**2) / 2]
    wx, wy = w(tx), w(ty); out = 0
    for j in range(4):
        row = 0
        for i in range(4):
            v = img[np.clip(yi + j - 1, 0, H - 1), np.clip(xi + i - 1, 0, W - 1)]
            row = row + v * (wx[i][..., None] if img.ndim == 3 else wx[i])
        out = out + row * (wy[j][..., None] if img.ndim == 3 else wy[j])
    return out


def parts(mask):
    """Each 4-connected part of `mask` as (pixels, touches the border)."""
    label = Image.fromarray(mask.astype(np.int32), 'I')
    found = []
    for y, x in zip(*np.nonzero(mask)):
        if label.getpixel((int(x), int(y))) != 1: continue
        ImageDraw.floodfill(label, (int(x), int(y)), len(found) + 2)
        found.append(None)
    labels = np.asarray(label)
    out = []
    for n in range(2, len(found) + 2):
        part = labels == n
        out.append((part, bool(part[0].any() or part[-1].any() or part[:, 0].any() or part[:, -1].any())))
    return out


def foliage(img, inside, largest_hole):
    lum = img @ np.array([0.2126, 0.7152, 0.0722])
    dense = Image.fromarray(((lum < 150) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(3))
    m = Image.fromarray(((np.asarray(dense) > 102) * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5)).filter(ImageFilter.MinFilter(5))
    m = (np.asarray(m) > 0) & inside
    for part, _ in parts(m):
        if part.sum() < SPECK: m &= ~part
    for part, border in parts(~m & inside):
        if not border and part.sum() <= largest_hole: m |= part
    return m


def fill(img, hole, rounds=8):
    """The pixels of `hole` from their known neighbours, ring by ring from its edge."""
    img = img.copy(); known = ~hole
    for _ in range(rounds):
        acc = np.zeros_like(img); cnt = np.zeros(hole.shape, np.float32)
        for shift in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            k = np.roll(known, shift, (0, 1)); acc += np.roll(img, shift, (0, 1)) * k[..., None]; cnt += k
        new = ~known & (cnt > 0)
        img[new] = acc[new] / cnt[new][:, None]; known |= new
    return img


for name, ((x0, y0, x1, y1), poly, base, amp, largest_hole) in REGIONS.items():
    img = full[y0:y1, x0:x1]; H, W = img.shape[:2]
    m = Image.new('L', (W, H), 0); ImageDraw.Draw(m).polygon([(x - x0, y - y0) for x, y in poly], 255)
    mk = np.asarray(m.filter(ImageFilter.GaussianBlur(6))).astype(np.float32) / 255
    leaves = foliage(img, np.asarray(m) > 0, largest_hole)
    leaves = np.asarray(Image.fromarray(leaves.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(3))) > 0   # no edge pixel left behind
    ground = fill(img, leaves)
    layer, cover = img * leaves[..., None], leaves.astype(np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    top = min(y for _, y in poly) - y0
    h = np.clip((base - y0 - yy) / max(1, base - y0 - top), 0, 1) ** 0.8
    drawn, most = [], 0.0
    for i, e in enumerate(ENV):
        ph = 2 * np.pi * i / len(ENV)
        dx = mk * (amp * e * h * (1 + 0.35 * np.sin(2 * np.pi * xx / 70 + yy / 40)) + 0.6 * np.sin(2 * np.pi * (xx / 17 + yy / 23) - ph))
        dy = mk * 0.5 * np.sin(2 * np.pi * (xx / 21 - yy / 19) - ph)
        sx, sy = np.clip(xx - dx, 0, W - 1), np.clip(yy - dy, 0, H - 1)
        c = np.clip(cubic(cover, sx, sy), 0, 1)
        rgb = np.clip(cubic(layer, sx, sy), 0, 255) + ground * (1 - c[..., None])
        shown = leaves | (c > 0.01)
        Image.fromarray(np.dstack([np.clip(rgb, 0, 255), shown * 255]).astype(np.uint8), 'RGBA').save(f'{outdir}/{name}-f{i}.png')
        drawn.append(np.where(shown[..., None], rgb, img))
        most = max(most, float(np.abs(dx[leaves]).max()), float(np.abs(dy[leaves]).max()))
    drawn = np.stack(drawn)
    changed = (drawn.max(0) - drawn.min(0)).max(-1) > 0.5
    # where the foliage can reach: itself, its largest sway and the reach of the bicubic kernel
    r = int(np.ceil(most)) + 2
    reach = np.asarray(Image.fromarray(leaves.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(2 * r + 1))) > 0
    outside = int((changed & ~reach).sum())
    print(f'{name} {x0} {y0} {W} {H}: between frames {outside} px change outside the foliage '
          f'and its sway, {(changed & ~leaves).sum()} px where it sways over the ground')
    if outside: sys.exit(f'{name}: what stands around the plant moves')
