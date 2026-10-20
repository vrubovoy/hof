# Подгонка резкости кадров к картинке, поверх которой они лежат. Кадры поз из правок ChatGPT и
# кадры эффектов (вода, листва, знамёна — пиксели сдвинуты с интерполяцией) мягче исходника,
# и в анимации кот или куст «мутнеют». Шаг — нерезкое маскирование (unsharp), его сила k
# подбирается так, чтобы резкость штриховки (дисперсия лапласиана) внутри кадра совпала с той же
# областью исходника. Одна k на все кадры одного эффекта — иначе резкость мигала бы.
# Делается на кадрах 1x, до увеличения в 2x (см. asset-prompt.txt, «Обработка»).
# usage: crisp.py <исходник.png> <x> <y> <кадр.png>... — кадры RGBA 1x, (x, y) — их левый верхний
#        угол на исходнике; кадры перезаписываются, печатается k
#        crisp.py <исходник.png> <правка.png> <выход.png> — правка ChatGPT целиком (почти весь рисунок
#        тот же, поэтому мерить честно по всей картинке); кадр позы потом вырезается из выхода
import sys
import numpy as np
from PIL import Image

SIGMA = 0.9


def blur(a, s=SIGMA):
    r = int(3 * s + 0.5); t = np.arange(-r, r + 1); w = np.exp(-t * t / (2 * s * s)); w /= w.sum()
    for axis in (0, 1):
        p = np.pad(a, [(r, r) if i == axis else (0, 0) for i in range(a.ndim)], mode='edge')
        a = sum(wi * np.take(p, range(i, i + a.shape[axis]), axis=axis) for i, wi in enumerate(w))
    return a


def lapvar(g, m):
    l = g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    return float(l[m[1:-1, 1:-1]].var())


def gray(rgb):
    return rgb @ np.array([0.2126, 0.7152, 0.0722])


def sharpen(rgb, k):
    return np.clip(rgb + k * (rgb - blur(rgb)), 0, 255)


def fit(rgb, target, m):
    lo, hi = 0.0, 8.0
    for _ in range(30):                               # дисперсия растёт с k — делим отрезок пополам
        k = (lo + hi) / 2
        lo, hi = (k, hi) if lapvar(gray(sharpen(rgb, k)), m) < target else (lo, k)
    return (lo + hi) / 2


base = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
if not sys.argv[2].isdigit():
    edit = np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(np.float32)
    every = np.ones(base.shape[:2], bool)
    k = fit(edit, lapvar(gray(base), every), every)
    Image.fromarray(sharpen(edit, k).round().astype(np.uint8)).save(sys.argv[3])
    print(f'k = {k:.2f}')
    sys.exit()
x, y, paths = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4:]
frames = [np.asarray(Image.open(p).convert('RGBA')).astype(np.float32) for p in paths]
ks = []
for f in frames:
    h, w = f.shape[:2]
    inner = blur(f[..., 3], 2) > 250                  # непрозрачная середина кадра, без мягкого края
    ks.append(fit(f[..., :3], lapvar(gray(base[y:y + h, x:x + w]), inner), inner))
k = float(np.median(ks))
for f, p in zip(frames, paths):
    Image.fromarray(np.dstack([sharpen(f[..., :3], k), f[..., 3]]).round().astype(np.uint8), 'RGBA').save(p)
print(f'k = {k:.2f} (по кадрам: {", ".join(f"{v:.2f}" for v in ks)})')
