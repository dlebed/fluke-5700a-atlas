#!/usr/bin/env python3
"""
page_grid.py — overlay a labelled measuring grid on a full-resolution page, so
a crop rectangle can be read off it instead of guessed.

This is the tool for step 2, before any asset exists. `review_markers.py --grid`
measures inside an already-cropped image; this one measures the uncropped,
upright page in order to produce the crop in the first place.

Measuring by eye beats probing for the border in code. An ink profile finds the
scan's own black page edge, the punch holes and the speckle just as readily as
it finds the drawing frame, and it cannot tell you which is which -- whereas a
person looking at a numbered grid can, in about ten seconds. A17's sheet 2 was
clipped for exactly this reason: the probe started past x=0 and found the wrong
line.

    scripts/page_grid.py .build/a14/sh1_up.png
    scripts/page_grid.py .build/a14/sh1_up.png --crop 6200x3800+150+270

With --crop it draws the proposed rectangle over the grid, which is how a
rectangle gets confirmed before being committed to extract_assets.sh. It prints
the `WxH+X+Y` string in full-resolution pixels once the corners are known:

    scripts/page_grid.py .build/a14/sh1_up.png --corners 30 270 6560 4130

The upright page it wants is a transient: extract_assets.sh writes dr_up.png and
shN_up.png into .build/<asm>/ and deletes them again at the end of the run, and
what it keeps (drawing_full.png, schN_full.png) is already cropped. So for a new
assembly, make one the same way extract_assets.sh does, from the Ch7 PDF page:

    pdfimages -f 66 -l 66 -png <Ch7.pdf> /tmp/raw
    magick /tmp/raw-000.png -rotate 90 .build/a14/sh1_up.png
"""

import argparse
import os
import subprocess
import sys

FONTS = ["/System/Library/Fonts/Supplemental/Arial.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
STEP = 100          # grid spacing in output pixels


def font():
    for f in FONTS:
        if os.path.exists(f):
            return f
    sys.exit("no usable font found; magick needs one to label the grid")


def size_of(path):
    out = subprocess.run(["magick", "identify", "-format", "%w %h", path],
                         capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(out.stderr.strip() or "cannot read %s" % path)
    w, h = out.stdout.split()
    return int(w), int(h)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image", help="full-resolution upright page, e.g. .build/a14/sh1_up.png")
    ap.add_argument("--width", type=int, default=1200, help="output width (default 1200)")
    ap.add_argument("--crop", help="draw a proposed WxH+X+Y rectangle over the grid")
    ap.add_argument("--corners", nargs=4, type=int, metavar=("X0", "Y0", "X1", "Y1"),
                    help="print the crop string for these grid coordinates and draw it")
    ap.add_argument("-o", "--out", help="output path (default alongside the input)")
    args = ap.parse_args()

    if not os.path.exists(args.image):
        sys.exit("no %s" % args.image)
    W, H = size_of(args.image)
    scale = W / float(args.width)
    ow, oh = args.width, int(round(H / scale))

    lines, labels = [], []
    for x in range(0, ow + 1, STEP):
        lines.append("line %d,0 %d,%d" % (x, x, oh))
        labels.append("text %d,20 '%d'" % (min(x + 4, ow - 40), int(round(x * scale))))
    for y in range(0, oh + 1, STEP):
        lines.append("line 0,%d %d,%d" % (y, ow, y))
        if y:
            labels.append("text 4,%d '%d'" % (y + 16, int(round(y * scale))))

    # Grid labels carry full-resolution pixel values, so what you read off the
    # picture is what goes into the crop -- no mental arithmetic, which is where
    # a measurement usually goes wrong.
    box = args.crop
    if args.corners:
        x0, y0, x1, y1 = args.corners
        box = "%dx%d+%d+%d" % (x1 - x0, y1 - y0, x0, y0)
        print(box)

    cmd = ["magick", args.image, "-resize", "%dx" % ow, "-colorspace", "sRGB",
           "-fill", "none", "-stroke", "red", "-strokewidth", "1", "-draw", " ".join(lines)]
    if box:
        try:
            wh, xy = box.split("+", 1)
            bw, bh = (int(v) for v in wh.split("x"))
            bx, by = (int(v) for v in xy.split("+"))
        except ValueError:
            sys.exit("crop must look like WxH+X+Y, got %r" % box)
        cmd += ["-stroke", "#00a0ff", "-strokewidth", "3",
                "-draw", "rectangle %d,%d %d,%d" % (bx / scale, by / scale,
                                                    (bx + bw) / scale, (by + bh) / scale)]
    cmd += ["-stroke", "none", "-fill", "blue", "-pointsize", "20", "-font", font(),
            "-draw", " ".join(labels)]

    out = args.out or os.path.splitext(args.image)[0] + "_grid.png"
    cmd.append(out)
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(result.stderr.strip()[:400])
    print("%s   %dx%d source, grid every %d px" % (out, W, H, int(round(STEP * scale))))


if __name__ == "__main__":
    main()
