# Новые картинки Hof: стиль, промпты, правки

Картинки Hof рисует ChatGPT в проекте «Hof assets». Здесь — как просить и как довести результат до
законченного мастера (design/README.md).

## Порядок

1. Проект «Hof assets»: в инструкции проекта — блок STYLE ниже, в файлах проекта — только
   `masters/login-desktop-v2.png`, `references/scene-treasury-v1.png`, `references/emblem-saeckel.png`,
   `references/07-services.png`. Одна картинка — одно сообщение, 2–3 варианта, дальше — правки.
2. Сцены не увеличивать нейросетью (Upscayl стирает штриховку). Знак Hof и служебные значки не
   генерировать — это SVG.
3. Генерация ChatGPT — ещё не мастер: он не держит ни размер, ни цвет, ни пиксели. Готовый мастер —
   картина нужного размера и кадра, с цветами как у соседних картин (бумага около 248, 239, 223),
   с прозрачностью, где она нужна. Если ChatGPT достроил прежнюю картину, прежняя часть остаётся
   пиксель в пиксель, а новая приводится к её цветам.
4. Поза кота или дверь — правка «пиксель в пиксель» (промпты Д и Е). ChatGPT перерисовывает всю
   картину, поэтому из правки берут только то, что действительно изменилось (кота, дверь), с мягким
   краем, и сохраняют это прозрачным PNG-мастером: вне кадра — прозрачность.

## STYLE — постоянный блок

```text
STYLE — Hof
Pen-and-ink illustration in the style of the attached reference image
(login-desktop-v2.png for outdoor scenes, scene-treasury-v1.png for rooms,
emblem-saeckel.png for emblems and materials):
a blue-and-white storybook etching on warm off-white paper. Cobalt / ultramarine ink,
crisp dark navy outlines, fine blue hatching and cross-hatching for shading,
a very light blue wash.

Outdoors (courtyard, gate): warm color only as pale, desaturated washes under the
blue hatching on wood, terracotta, linen, bread, brass and the tabby cat. Stone, paving,
walls, sky and foliage stay blue ink on bare paper (foliage may have a very pale sage
tint).
Indoors (rooms): wooden furniture, brass, linen and leather may carry fuller warm
washes, as in scene-treasury-v1.png; stone walls and floors stay blue.
Never saturated colors, no colored sky, no realistic watercolor painting,
no photographic light.

World: a sunny, peaceful medieval-Mediterranean castle courtyard and its rooms —
pale stone walls, round arches, crenellations, a round stone fountain, cypresses,
olive and laurel trees, terracotta pots with plants, ivy, blue banners with a white
fleur-de-lis, iron lanterns, stone paving, wooden furniture. Calm, cozy, lived-in.
Not dark, not gothic, not fantasy, not cartoonish.

Recurring character: one small tabby cat may appear in scenes and vignettes (never in
emblems or materials) — always the same cat.

Background: plain, even warm paper (close to #F7EFE0). No stains, no vignette,
no drop shadow, no frame or border around the picture (unless the subject itself
is a frame).

Strictly: no text, no letters, no numbers, no signatures, no watermarks, no logos,
no buttons or screen interface, no people.

Consistency: match the attached reference exactly — the same blue, line weight,
hatching density, amount of warm color and level of detail.

EMBLEM VARIANT (only for emblems of services like Säckel; Hof's own emblems are a plain
object without ledge and sprigs): match emblem-saeckel.png — one object standing
on a small ledge of three flagstones with two small laurel sprigs behind it; the object
itself may have one warm wash (cloth, wood, brass); ledge and sprigs stay blue.

MATERIAL VARIANT (only for menu-banner, ribbon, frame, signboard, key-tag, hook-empty,
sprig-*): one isolated decorative object, drawn in the same ink style as
emblem-saeckel.png. Straight front view: no perspective, no tilt, perfectly level and
symmetric. Plain even paper background with a wide empty margin, no shadow, nothing else
in the picture. Parts marked "stretchable" are perfectly straight and uniform, with a
simple even texture, so they can be cut and repeated. No text, no letters, no symbols unless asked.
```

## Промпты для новой службы двора

Скопировать блок, заменить слова в [КВАДРАТНЫХ СКОБКАХ], приложить указанную картинку.

```text
А. Шапка службы — сцена до краёв (как казначейская у Säckel)
   Приложить: references/scene-treasury-v1.png

ASSET: scene-[service]
Follow STYLE — Hof. Indoor room, match the attached reference exactly.
Subject: [PLACE] inside the castle, seen from the front at eye level, calm and tidy.
Main zone (keep it in the middle band of the picture, from 40% to 80% of the height):
[OBJECTS] on a long wooden table or shelf, clearly readable as one group.
Composition: painted all the way to the edges of the image — no blank paper, no fading edges,
no frame. Full detail and depth, dense hatching, like a finished book illustration.
No people, no text or letters on anything.
Format: landscape 3:2, highest resolution.


Б. Вертикальная картина рядом с формой (как ключница у Приближённых, комната в Моих покоях)
   Приложить: references/scene-treasury-v1.png (комната) или masters/login-desktop-v2.png (на улице)

ASSET: scene-[service]-panel
Follow STYLE — Hof. Match the attached reference exactly.
Subject: [PLACE], tall view. The key objects — [OBJECTS] — stand in the middle 60% of the width,
from top to bottom; the sides may be cropped on narrow screens.
The tabby cat from the reference may sit somewhere in the scene, small, not in the center.
Composition: portrait, painted all the way to the edges, no blank paper, no frame.
Full detail, dense hatching. No people, no text or letters.
Format: portrait 2:3, highest resolution.


В. Виньетка пустого состояния (как «Мешков пока нет»)
   Приложить: masters/login-desktop-v2.png

ASSET: empty-[service]
Follow STYLE — Hof. Match the attached reference exactly.
Subject: a small still life — [EMPTY OBJECTS, e.g. empty jars on a bare shelf] — and the tabby
cat from the reference, curious, sniffing at them.
Composition: a vignette in the center, about half of the frame, lots of air around it.
All edges dissolve softly into blank paper: hatching gets sparser toward the edges.
Plain even paper background, no frame, no text.
Format: landscape 3:2, highest resolution.


Г. Эмблема службы (в меню и на карточках, как мешок Säckel)
   Приложить: references/emblem-saeckel.png

ASSET: emblem-[service]
Follow STYLE — Hof, EMBLEM VARIANT. Match the attached emblem exactly: the same ledge of three
flagstones, the same two small laurel sprigs behind, the same line weight and blue.
Object: [ONE OBJECT, e.g. a small oak barrel], standing on the ledge, front view, slightly
from above. The object may have one warm wash (wood, cloth or brass); ledge and sprigs stay blue.
Plain even paper background, wide empty margin, nothing else in the picture, no text.
Format: square 1:1, highest resolution.


Д. Дверь службы на карте открывается (кадр для наведения, как у казначейской)
   Приложить: masters/scene-courtyard-map.png

ASSET: scene-courtyard-map-[service]
Edit the attached image. Keep EVERYTHING exactly as it is — same size, same position of every
line — and change only one thing: the [WHICH DOOR, e.g. second wooden door from the left in the
middle wall] is now half open inwards, a warm dim interior visible behind it.
Nothing else moves or changes. No new objects, no text.
   После: Claude Code вырежет из правки только дверь с мягким краем (как map-treasury-door).


Е. Кот меняет позу на картинке (кадр по щелчку)
   Приложить: мастер той картины, где сидит кот

ASSET: [scene]-cat
Edit the attached image. Keep EVERYTHING exactly as it is — same size, same position of every
line — and change only the tabby cat: [NEW POSE, e.g. it stretches and yawns].
Nothing else moves or changes.
   После: Claude Code вырежет только кота с мягким краем и проверит, что остальное совпало.
```

## Правки (в том же чате, после неудачной генерации)

```text
Неровный фон:
  Repaint only the background as flat, even paper color. Keep the illustration unchanged.

Буквы на флагах, книгах или вывесках:
  Remove all letters and symbols. Keep everything else unchanged.

Край обрывается резко:
  Make the <left> edge dissolve gradually into blank paper; hatching gets sparser toward the edge.

Слишком много цвета:
  Keep the blue ink drawing; reduce warm colors to pale, desaturated washes only on wood,
  terracotta, linen, brass and the cat, exactly as subtle as in login-desktop-v2.png.

Материал нарисован в перспективе или с наклоном:
  Redraw it in a straight front view: perfectly level and symmetric, no perspective, no tilt.

Растягиваемая часть неровная:
  Make the <middle band> perfectly straight and uniform along its whole length; keep the ends unchanged.

Стиль уплыл (приложить удачный ассет):
  Match this image's style exactly: same line weight, hatching density, blue hue and warm accents.
```
