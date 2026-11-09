# design/ — картинки Hof: мастера, выпуск, стиль

Сайт показывает только файлы `src/core/static/img` и `src/saeckel/static/img`. Здесь — то, из чего
они сделаны, и как сделать новые. В образ Docker папка не попадает (`.dockerignore`).

## Устройство

| Что | Зачем |
|---|---|
| `masters/` | Мастер-PNG: готовая, утверждённая картина под одно место показа (компьютер или телефон) — нужная композиция, цвет и размер. Из мастера файлы static делаются одной командой |
| `assets.json` | Опись: каждая картинка static и как она получается (рецепт ниже) |
| `tools/export.py` | Выпуск и проверка по описи |
| `tools/banners.py`, `leaves.py`, `fountain.py`, `crisp.py` | Кадры анимаций карты Двора из её мастера: знамёна, листва, вода; резкость кадров как у картины |
| `tools/pen.py` | Всё, что нарисовано пером, — SVG рамок, линеек, закладок, флажков |
| `references/` | Эталоны стиля: доски владельца `01…07`, комнаты — `scene-treasury-v1.png`, эмблемы и материалы — `emblem-saeckel.png` |
| `sounds/` | Исходные записи, музыка и их сведение (`mix.py`), раздел «Звуки» ниже |

## Правило

1. Картинка сайта — файл static, сделанный из мастера командой выпуска. Мастер и рецепт названы в `assets.json`.
2. Компьютер и телефон — разные мастера, если на них разная композиция: телефон не режет картину компьютера.
3. Сырые генерации, листы, правки ChatGPT и разовые скрипты в репозиторий не кладутся. Из них делается
   мастер, а сам путь — строкой в «Журнале» ниже.
4. `copy` в описи — картинка, сделанная однажды вручную (вырезка с листа, перевод бумаги в белый,
   позы кота, двери карты, кляксы, эмблемы, материалы): её файл в static и есть мастер. Чтобы
   изменить её, делают новый мастер и переводят запись на рецепт.

## Выпуск

Нужны ImageMagick 7 (`brew install imagemagick`) и Python с Pillow и NumPy:

```sh
python3 -m venv ~/.venvs/hof && ~/.venvs/hof/bin/pip install pillow numpy
~/.venvs/hof/bin/python design/tools/export.py check
~/.venvs/hof/bin/python design/tools/export.py build src/core/static/img/scene-setup.webp
```

`check` делает во временной папке каждую картинку, у которой есть рецепт, и сравнивает со static
байт в байт; заодно — что опись и static совпадают по списку. После любой замены мастера:
`build` нужных файлов, затем `check`. Тест `npm run check` следит, что каждая картинка static есть
в описи, а каждый мастер описи — в `masters/`.

| Рецепт | Как | Где |
|---|---|---|
| `1x` | мастер как есть, WebP `quality` | картины 1536 px |
| `2x` | вдвое больше: Lanczos в линейном свете, лёгкая резкость | картины для Retina |
| `width` | к ширине `width`, Lanczos в линейном свете | кадры телефона 780 и 1170 |
| `band` | панель комнаты, видны только строки `rows`, выше и ниже столбец повторяет крайний пиксель; размер панели | полосы покоев и приближённых на телефоне (M12.5) |
| `frames` | `banners.py` / `leaves.py` из мастера карты → `crisp.py` → каждый кадр вдвое → полоса, WebP 75 | знамёна, листва |
| `pen` | `pen.py` | SVG пером |
| `copy` | файл static — сам мастер | всё сделанное вручную |

## Спецификация мастеров

| Место показа | Мастер | Выпуск |
|---|---|---|
| Сцена на весь экран компьютера (вход, основание, ошибки) | 1536×1024, картина слева, справа бумага под форму | `1x` 82, `2x` 75 (основание и ошибки — 72) |
| Карта Двора | 1536×1024, до краёв | `1x` 82, `2x` 75; кадры анимаций — из неё |
| Шапки и панели комнат | кадр по главной зоне, до краёв | `1x` 82, `2x` 75 |
| Сцена на телефоне | свой кадр, до краёв; ширина 1170, если есть | `width` 780 и `1x` — вся ширина мастера (до 1170), 80 |
| Эмблемы, материалы, виньетки | по месту (таблица размеров ниже) | вручную, `copy` |

Цвет бумаги интерфейса — `#F7EFE0`; у картин бумага около (248, 239, 223). Новая генерация, у
которой поплыли цвета, приводится к прежней картине кривыми по общей части (так сведены кадры
телефона M12.6), а не на глаз.

Размеры прочего: знамя меню — по высоте 1800, лента — 144, рамка — 1024 (9 частей), вывеска — 400
по ширине, бирки ключей — 192 по высоте, виньетки — 720…840, эмблемы — крупный план 48/96, целиком
120/240, бумага — плитка 1124, пятна 750 → 1500. Генерация ChatGPT: 1536×1024, 1024×1536 или
1024×1024. Вес: фон входа @2x ~650 КБ, полосы до ~300 КБ, остальное до ~100 КБ.

## Как сделать новую картинку

1. ChatGPT, проект «Hof assets»: в инструкции проекта — блок STYLE ниже, в файлах проекта — только
   `masters/login-desktop-v2.png`, `references/scene-treasury-v1.png`, `references/emblem-saeckel.png`,
   `references/07-services.png`. Одна картинка — одно сообщение, 2–3 варианта, дальше — правки.
2. Сцены не увеличивать нейросетью (Upscayl стирает штриховку). Знак Hof и служебные значки не
   генерировать — это SVG.
3. Сведение в мастер: размер и кадр по спецификации, цвета — к эталону. Достроенная ChatGPT картина
   склеивается с прежней по шву наименьшей разницы, левая часть остаётся прежней пиксель в пиксель.
4. Позы кота и двери карты — правки ChatGPT «пиксель в пиксель» (промпты Д и Е). Правка мягче
   исходника: она подгоняется по резкости (`crisp.py <мастер> <правка> <выход>`), и из неё
   вырезается только то, что заметно изменилось (размытая разница > 26 из 255, без крапинок, +8 px,
   мягкий край 6 px).
5. Мастер — в `masters/`, запись — в `assets.json`, затем `export.py build` и `check`.

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

## Журнал: что сделано однажды

- Позы кота (`pose-*`, `map-cat`, `chambers-cat`, `empty-saeckel-sniff-*`), двери карты
  (`map-*-door`, `map-gatehouse-window`), пустая летопись — вырезаны из правок ChatGPT по пункту 4.
- Створки «Основания двора» (`setup-gate-open`) — арка из сцены входа (совпадает корреляцией),
  с M12.4 кадр кончается над низом дверей и прозрачен над головой кота.
- Вода фонтана (`fx-fountain`) — `fountain.py` M10.3; нынешняя полоса собрана до нынешнего пути
  кадров и не повторяется им байт в байт (`copy`).
- Эмблемы, знаки мешков, кнопки, печати, знамя меню, лента, рамка, вывеска, бирки, кляксы, веточки,
  рука — вырезаны с листов ChatGPT; бумага у виньеток переведена в белый (деление на цвет бумаги).
  Лента и вывеска смягчены под сцены (`*-soft`).
- Птицы в небе карты стёрты (M12.11), красные яблоки на 500 приглушены.
- Кадры телефона M12.6 (`*-mobile.png`): 403 — квадрат 896 мастера компьютера с (0, 88); 404 —
  картина, которую ChatGPT нарисовал заново до краёв, цвета приведены к 404 компьютера кривыми по
  гистограммам, квадрат 1086 с x = 181; 500 и «Основание двора» — картина компьютера пиксель в
  пиксель слева и её достройка ChatGPT справа, цвета достройки — кривыми по общей части, шов там,
  где картины различаются меньше всего; у 500 левая часть — выпущенный файл (его яблоки
  приглушены), яблоки достройки приглушены тем же преобразованием RGB, измеренным на прежних
  яблоках. Кадры 500 — квадрат 1024 с (48, 0), основания — 1000×703 с (60, 321): кот и створки
  стоят в px картины компьютера. Сырые картины ChatGPT остались вне репозитория.
- Поза кота 500 (M12.6): лапа касается бока яблока, листик виден; вырезана по пункту 4 внутри
  многоугольника вокруг кота — правка перерисовала и куст рядом; яблоко в кадре приглушено.
- Прототипы этапа дизайна (`design/preview/*.html`, `screens.css`, `canvas.py`), листы и сырые
  генерации (`design/generated/`) убраны в M12.12; они есть в истории git до этой задачи.
  Эталон экранов — холст «Hof — экраны MVP» (ARCHITECTURE.md, «Визуальный язык»).

## Звуки

Не ChatGPT: готовые записи под CC0, источники — `src/core/static/sounds/LICENSE.txt`.

```text
Сведение — design/sounds/mix.py (громкость к одному плану, полосы, петля фонтана, порывы):
  python3 mix.py ~/Downloads [ещё папки]     (ищет исходники во всех; нужен macOS afconvert)
План громкости: интерфейс −26 LUFS кратко, кот −28, мурчание −32, ветер −34, фонтан −40
интегрально, музыка −30 интегрально с вырезом −3 дБ на 2–5 кГц. Во время звука интерфейса
музыка тише на 4 дБ (fx.js).
Наборы (случайный выбор, без повтора подряд), design/sounds/*.m4a:
  door-1…6     Kenney RPG Audio: doorOpen_1, doorOpen_2, doorClose_1…4 (не длиннее 0,95 с — дверь открывается 0,75 с)
  chest-1…3    Kenney: creak1…3 (не длиннее 0,7 с; щелчок защёлки убран — короче крышки)
  coins-1…2    Kenney: handleCoins, handleCoins2
  banner-1…4   Kenney: cloth1…4
  page-1…2     Kenney: bookFlip1, bookFlip2 (Мешки ↔ Летопись; bookOpen 0,15 с был короче листа)
  wind-1…6     freesound: 146932 crashoverride6; 457318 Stek59 (2 порыва); 347557 Kinoton;
               443065 AmberdeMeillon; 178615 Montacue — по 2,4 с
  fountain-1…3 freesound 415027 roman_cgr, 169250 skyko, 193784 jhumbucker — петли 12 с;
               первый заход на двор — 1, дальше по кругу
  meow-1…9     freesound 436541, 362652, 163286, 333916, 412017, 110011; 120160 «Cat Wants Food»
               (два мяуканья, mix.py meows), 196251 «Kitten Meowing»
  purr-1       freesound 260881 Trautwein — кот в покоях
  sniff-1…3    freesound 848385 RavenWolfProds, 801809 Sadiquecat, 418161 14FPanskaZummer_Jakub — кот нюхает
               мешки; самый громкий кусок 1,2 с (два-три «фырка»), −30 LUFS кратко
Музыка (CC0), design/sounds/music/music-1…20.m4a, 80 кбит/с, ~23 МБ: один список на все экраны, по очереди
(порядок — MUSIC в mix.py: лютня и арфа вперемешку с бодрыми). Пьесы: The Bard's Tale, King's Feast, Lover and
His Lass (fs 769807), Market Day, Harvest Season, Minstrel Dance, арфа ChaliceWell (fs 574485), Fouler l'horizon
(Komiku), Exploration, Rejoicing, Guardsman's Break (fs 608915), «If my Complaints Could Passions Move»
Дж. Дауленда 1597, The Old Tower Inn, Harpsichord Flurry, Blinking Forest (fs 676787), Medieval March
(fs 646460), Serenade, Peasant Theme, Lament for a Warrior's Soul, Kevzog (fs 362288; первые 47 с тихого вступления срезаны — TRIM в mix.py).
Проверить на слух: music-18 (Peasant Theme) и music-14 (клавесин) яркие.
Послушать всё: design/sounds/listen.html.
```
