#!/usr/bin/env python3
"""
text_only.py — is the silkscreen readable at all, or is it fused to the artwork?

When the reader's yield on a drawing is poor, there are two possible causes and
they call for opposite responses: either the OCR settings are wrong, which is
worth tuning, or the labels physically touch the component outlines, which no
setting fixes. This tells them apart in one step.

It keeps only connected components small enough to be a character and throws
away everything larger. On a drawing whose labels stand clear of the artwork,
the result is the text on a blank field. On a drawing whose labels touch it, the
letters disappear along with the graphics they are joined to -- and that is the
answer: place by hand and stop sweeping parameters.

    text_only.py .build/a17/drawing_full.png out.png --crop 380x350+300+1180

--max sets the largest blob dimension kept (default 60 px, about twice the
height of a designator character on a 400 dpi drawing).
"""

import argparse
import os
import subprocess
import sys
from collections import deque


def load(path, crop, threshold):
    cmd = ["magick", path]
    if crop:
        cmd += ["-crop", crop, "+repage"]
    cmd += ["-colorspace", "Gray", "-depth", "8", "-threshold", threshold, "gray:-"]
    out = subprocess.run(cmd, capture_output=True)
    if out.returncode != 0:
        sys.exit(out.stderr.decode()[:400])
    size = ["magick", path]
    if crop:
        size += ["-crop", crop, "+repage"]
    size += ["-format", "%w %h", "info:"]
    w, h = subprocess.run(size, capture_output=True, text=True).stdout.split()
    return out.stdout, int(w), int(h)


def small_blobs(px, w, h, maxdim):
    """Flood-fill every dark region; keep the ones a character could fit in."""
    seen = bytearray(w * h)
    keep = bytearray(w * h)
    kept = dropped = 0
    for start in range(w * h):
        if seen[start] or px[start] >= 128:
            continue
        q = deque([start])
        seen[start] = 1
        comp = [start]
        x0 = x1 = start % w
        y0 = y1 = start // w
        while q:
            p = q.popleft()
            x, y = p % w, p // w
            x0, x1 = min(x0, x), max(x1, x)
            y0, y1 = min(y0, y), max(y1, y)
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1),
                           (1, 1), (1, -1), (-1, 1), (-1, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h:
                    n = ny * w + nx
                    if not seen[n] and px[n] < 128:
                        seen[n] = 1
                        q.append(n)
                        comp.append(n)
        if (x1 - x0) <= maxdim and (y1 - y0) <= maxdim:
            kept += 1
            for p in comp:
                keep[p] = 1
        else:
            dropped += 1
    return keep, kept, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source")
    ap.add_argument("dest")
    ap.add_argument("--crop", help="ImageMagick geometry, e.g. 380x350+300+1180")
    ap.add_argument("--max", type=int, default=60, help="largest blob kept (default 60)")
    ap.add_argument("--threshold", default="62%")
    args = ap.parse_args()

    if not os.path.exists(args.source):
        sys.exit("no such image: %s" % args.source)
    px, w, h = load(args.source, args.crop, args.threshold)
    if w * h > 4_000_000:
        sys.exit("%dx%d is too large to flood-fill in reasonable time -- pass --crop"
                 % (w, h))
    keep, kept, dropped = small_blobs(px, w, h, args.max)
    raw = bytes(0 if keep[i] else 255 for i in range(w * h))
    subprocess.run(["magick", "-size", "%dx%d" % (w, h), "-depth", "8", "gray:-", args.dest],
                   input=raw, check=True)
    print("%s  %dx%d  kept %d character-sized blobs, dropped %d larger ones"
          % (args.dest, w, h, kept, dropped))
    print("Open it: if the designators are there on a blank field, the reader can be "
          "tuned. If letters are missing with the graphics, they touch it -- place by hand.")


if __name__ == "__main__":
    main()
