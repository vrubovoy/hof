"""The pictures of static from their masters (design/README.md, «Выпуск»).

    python3 design/tools/export.py check          every picture made in a temporary folder and
                                                  compared with static byte for byte
    python3 design/tools/export.py build <out>…   the pictures named (paths in static) written

design/assets.json lists every picture of src/*/static/img and how it is made:
  1x      the master as it is                      (quality)
  2x      the master twice as large: Lanczos in linear light, a light unsharp (quality)
  width   the master brought to a width: Lanczos in linear light (width, quality)
  band    the panel of a room with only the rows a phone band shows; above and below every column
          repeats its edge pixel, the file keeps the size of the panel (panel, rows, quality)
  frames  a strip of frames of the courtyard map: banners.py or leaves.py, crisp.py, every frame
          twice as large, side by side (tool, name, at)
  pen     drawn by pen.py
  copy    made by hand once; the file in static is its own master
Needs ImageMagick 7 and Python with Pillow and NumPy (design/README.md).
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

DESIGN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.dirname(DESIGN)
TOOLS = os.path.join(DESIGN, "tools")
WEBP = ["-strip", "-define", "webp:method=6"]
TWICE = ["-colorspace", "RGB", "-filter", "LanczosRadius", "-distort", "Resize", "200%",
         "-colorspace", "sRGB", "-unsharp", "0x0.9+0.7+0.02"]


def run(*args):
    subprocess.run([str(a) for a in args], check=True, stdout=subprocess.DEVNULL)


def master(entry):
    return os.path.join(DESIGN, entry["master"])


def make(entry, out, work):
    """Writes the picture of one entry to `out`."""
    recipe, q = entry["recipe"], str(entry.get("quality", ""))
    if recipe == "1x":
        run("magick", master(entry), "-alpha", "off", *WEBP, "-quality", q, out)
    elif recipe == "2x":
        run("magick", master(entry), "-alpha", "off", *TWICE, *WEBP, "-quality", q, out)
    elif recipe == "width":
        run("magick", master(entry), "-alpha", "off", "-colorspace", "RGB", "-filter", "Lanczos",
            "-resize", f"{entry['width']}x", "-colorspace", "sRGB", *WEBP, "-quality", q, out)
    elif recipe == "band":
        panel = os.path.join(ROOT, entry["panel"])
        w, h = subprocess.run(["magick", "identify", "-format", "%w %h", panel], check=True,
                              capture_output=True, text=True).stdout.split()
        top, bottom = entry["rows"]
        run("magick", panel, "-crop", f"{w}x{bottom - top}+0+{top}", "+repage",
            "-set", "option:distort:viewport", f"{w}x{h}+0-{top}", "-virtual-pixel", "Edge",
            "-filter", "Point", "-distort", "SRT", "0", "+repage", *WEBP,
            "-define", "webp:use-sharp-yuv=true", "-quality", q, out)
    elif recipe == "frames":
        frames = os.path.join(work, entry["tool"])
        if not os.path.isdir(frames):
            os.makedirs(frames)
            run(sys.executable, os.path.join(TOOLS, f"{entry['tool']}.py"), master(entry), frames)
        own = os.path.join(work, entry["name"])
        os.makedirs(own)
        names = sorted((f for f in os.listdir(frames) if f.startswith(f"{entry['name']}-f")),
                       key=lambda f: int(f.rsplit("-f", 1)[1].split(".")[0]))
        for f in names:
            shutil.copy(os.path.join(frames, f), own)
        x, y = entry["at"]
        run(sys.executable, os.path.join(TOOLS, "crisp.py"), master(entry), x, y,
            *(os.path.join(own, f) for f in names))
        twice = []
        for f in names:
            frame = os.path.join(own, f)
            big = frame.replace(".png", "@2x.png")
            run("magick", frame, "(", "+clone", "-alpha", "extract", "-filter", "Triangle",
                "-resize", "200%", ")", "(", "-clone", "0", "-alpha", "off", *TWICE, ")",
                "-delete", "0", "+swap", "-compose", "CopyOpacity", "-composite", big)
            twice.append(big)
        run("magick", *twice, "+append", *WEBP, "-quality", "75",
            "-define", "webp:alpha-quality=100", out)
    elif recipe == "pen":
        drawn = os.path.join(work, "pen")
        if not os.path.isdir(drawn):
            os.makedirs(drawn)
            run(sys.executable, os.path.join(TOOLS, "pen.py"), drawn)
        shutil.copy(os.path.join(drawn, os.path.basename(entry["out"])), out)
    else:
        raise ValueError(f"{entry['out']}: {recipe} is made by hand")


def main():
    entries = json.load(open(os.path.join(DESIGN, "assets.json"), encoding="utf-8"))["entries"]
    by_out = {e["out"]: e for e in entries}
    command, names = sys.argv[1], sys.argv[2:]
    with tempfile.TemporaryDirectory() as work:
        if command == "build":
            for name in names:
                make(by_out[name], os.path.join(ROOT, name), work)
                print("written", name)
            return
        listed = set(by_out)
        shipped = {f"{d}/{f}" for d in ("src/core/static/img", "src/saeckel/static/img")
                   for f in os.listdir(os.path.join(ROOT, d))}
        problems = [f"not in assets.json: {p}" for p in sorted(shipped - listed)]
        problems += [f"listed, not in static: {p}" for p in sorted(listed - shipped)]
        made = 0
        for e in entries:
            if e["recipe"] == "copy" or e["out"] not in shipped:
                continue
            out = os.path.join(work, "out-" + e["out"].replace("/", "_"))
            make(e, out, work)
            made += 1
            with open(out, "rb") as a, open(os.path.join(ROOT, e["out"]), "rb") as b:
                if a.read() != b.read():
                    problems.append(f"differs from its master: {e['out']}")
        copies = sum(1 for e in entries if e["recipe"] == "copy")
        print(f"{made} made from masters and compared, {copies} are their own masters")
        for p in problems:
            print(p)
        sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
