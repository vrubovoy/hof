"""The WebP files of the site from the finished masters, by the table design/export.txt.

    python3 design/export.py build core/scene-setup.webp …   write these files of the site
    python3 design/export.py build all                         write every file of the table
    python3 design/export.py check                             make every file in a temporary
                                                               folder, compare with the site

Only a technical export: the picture is finished in the master. Twice as large is Lanczos in
linear light with a light unsharp; a transparent master keeps its edge with a Triangle filter and
its transparency at full quality; a sheet of frames is enlarged frame by frame, so that no frame
takes pixels of its neighbour. Needs ImageMagick 7 (`magick`).
"""

import os
import subprocess
import sys
import tempfile

DESIGN = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(DESIGN)
SITE = {"core": "src/core/static/img", "saeckel": "src/saeckel/static/img"}
WEBP = ["-strip", "-define", "webp:method=6"]
TWICE = ["-colorspace", "RGB", "-filter", "LanczosRadius", "-distort", "Resize", "200%",
         "-colorspace", "sRGB", "-unsharp", "0x0.9+0.7+0.02"]


def magick(*args):
    return subprocess.run(["magick", *map(str, args)], check=True, capture_output=True,
                          text=True).stdout


def table():
    rows = []
    with open(os.path.join(DESIGN, "export.txt"), encoding="utf-8") as f:
        for line in f:
            if line.strip() and not line.startswith("#"):
                master, file, size, quality = line.split()
                rows.append((master, file, size, quality))
    return rows


def site_path(file):
    module, name = file.split("/", 1)
    return os.path.join(ROOT, SITE[module], name)


def export(master, size, quality, out, work):
    src = os.path.join(DESIGN, "masters", master)
    clear = magick("identify", "-format", "%[opaque]", src) == "True"
    if clear:
        if size == "1x":
            magick(src, "-alpha", "off", *WEBP, "-quality", quality, out)
        elif size == "2x":
            magick(src, "-alpha", "off", *TWICE, *WEBP, "-quality", quality, out)
        else:
            magick(src, "-alpha", "off", "-colorspace", "RGB", "-filter", "Lanczos",
                   "-resize", f"{size}x", "-colorspace", "sRGB", *WEBP, "-quality", quality, out)
        return
    alpha = ["-define", "webp:alpha-quality=100", "-quality", quality]
    if size == "1x":
        magick(src, *WEBP, *alpha, out)
        return
    count = int(size.split("/")[1]) if "/" in size else 1
    width = int(magick("identify", "-format", "%w", src)) // count
    frames = []
    for i in range(count):
        frame = os.path.join(work, f"{os.path.basename(out)}-{i}.png")
        magick(src, "-crop", f"{width}x+{i * width}+0", "+repage",
               "(", "+clone", "-alpha", "extract", "-filter", "Triangle", "-resize", "200%", ")",
               "(", "-clone", "0", "-alpha", "off", *TWICE, ")",
               "-delete", "0", "+swap", "-compose", "CopyOpacity", "-composite", f"PNG32:{frame}")
        frames.append(frame)
    magick(*frames, "+append", *WEBP, *alpha, out)


def main():
    rows = table()
    command, names = sys.argv[1], sys.argv[2:]
    with tempfile.TemporaryDirectory() as work:
        if command == "build":
            chosen = [r for r in rows if names == ["all"] or r[1] in names]
            for master, file, size, quality in chosen:
                export(master, size, quality, site_path(file), work)
                print("written", file)
            missing = set(names) - {r[1] for r in rows} - {"all"}
            if missing:
                sys.exit(f"not in export.txt: {', '.join(sorted(missing))}")
            return
        differ = []
        for master, file, size, quality in rows:
            out = os.path.join(work, file.replace("/", "_"))
            export(master, size, quality, out, work)
            with open(out, "rb") as a, open(site_path(file), "rb") as b:
                if a.read() != b.read():
                    differ.append(file)
        print(f"{len(rows)} files made from the masters, {len(rows) - len(differ)} the same "
              "as on the site byte for byte")
        for file in differ:
            print("differs:", file)
        sys.exit(1 if differ else 0)


if __name__ == "__main__":
    main()
