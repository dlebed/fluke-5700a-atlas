#!/usr/bin/env python3
"""
review_markers.py — look at placed markers on the source image.

Coordinates cannot be checked by reading numbers; they can be checked in a
second by seeing whether a box sits on the label it claims. This renders that
picture: each marker cropped from the full-resolution drawing or sheet with its
box drawn on, tiled a few at a time so a batch can be reviewed at a glance.

    review_markers.py a18 board --refs C13 R231 TP4
    review_markers.py a18 board --tier ambiguous          # the doubtful ones
    review_markers.py a18 sh1   --tier single --limit 6
    review_markers.py a18 sh1   --grid 0.395 0.402        # measure by eye
    review_markers.py a18 board --proposed new.json       # before it lands

--grid overlays a labelled pixel grid so an exact position can be read off and
typed into the overrides file. It is the fastest way to place something the
reader could not find at all.

--proposed renders geometry from a file of drawing pixels rather than from the
built coordinates, so a hand placement can be looked at before it is committed
to the overrides.

Runs from any directory: the atlas root is found by walking up from
this file. Output paths are printed; open them with the Read tool to look.
"""

import argparse
import json
import os
import subprocess
import sys

def find_root():
    """
    The atlas directory, found by walking up from wherever this file
    happens to live. Counting directory levels breaks the moment the skill is
    installed somewhere else, and a skill that only works from one path is not
    much of a skill.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    for base in [here, os.getcwd()]:
        node = base
        while node != os.path.dirname(node):
            if os.path.exists(os.path.join(node, "tools", "assemble.py")):
                return node
            candidate = os.path.join(node, "fluke-5700a-atlas")
            if os.path.exists(os.path.join(candidate, "tools", "assemble.py")):
                return candidate
            node = os.path.dirname(node)
    sys.exit("cannot find the fluke-5700a-atlas directory from %s" % here)


ROOT = find_root()
sys.path.insert(0, os.path.join(ROOT, "tools"))
import spaces      # noqa: E402  -- find_root() has to run before this resolves
FONTS = ["/System/Library/Fonts/Supplemental/Arial.ttf",
         "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]


def font():
    for f in FONTS:
        if os.path.exists(f):
            return f
    return None


def run(cmd):
    """magick fails obscurely when a font is missing; surface its own words."""
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit("%s\n%s" % (" ".join(cmd[:3]), result.stderr.strip()[:400]))
    return result


def size_of(path):
    out = run(["magick", "identify", "-format", "%w %h", path]).stdout.split()
    return int(out[0]), int(out[1])


def positions(asm, space):
    """ref -> geometry, for whichever space is being reviewed."""
    coords = json.load(open(os.path.join(ROOT, "data", "%s.coords.json" % asm)))
    out = {}
    for ref, entry in coords["placement"].items():
        if space == "board":
            if entry.get("board"):
                out[ref] = dict(entry["board"], placement=entry.get("placement"))
        else:
            for occurrence in entry.get("sch", []):
                if occurrence.get("sheet") == space:
                    out[ref] = dict(occurrence, placement=occurrence.get("placement"))
    return out


def crop_ref(src, W, H, ref, geom, work, size):
    cw, ch = size
    cx, cy = geom["x"] * W, geom["y"] * H
    bw, bh = geom.get("w", 0.01) * W, geom.get("h", 0.01) * H
    x0 = max(0, min(W - cw, int(cx - cw / 2)))
    y0 = max(0, min(H - ch, int(cy - ch / 2)))
    out = os.path.join(work, "m_%s.png" % ref.replace("/", "_"))
    # Draw the marker as the shape the data says it is. A round marker checked
    # as a rectangle looks fine right up until you see it on the board.
    px, py = cx - x0, cy - y0
    if geom.get("shape") in ("circle", "point"):
        r = (min(bw, bh) if geom.get("shape") == "point" else (bw + bh) / 2) / 2
        draw = "circle %d,%d %d,%d" % (px, py, px + r, py)
    else:
        draw = "rectangle %d,%d %d,%d" % (px - bw / 2, py - bh / 2,
                                          px + bw / 2, py + bh / 2)
    cmd = ["magick", src, "-crop", "%dx%d+%d+%d" % (cw, ch, x0, y0), "+repage",
           "-fill", "none", "-stroke", "red", "-strokewidth", "4",
           "-draw", draw,
           "-stroke", "none", "-fill", "red"]
    if font():
        label = ref + ("  " + geom["placement"] if geom.get("placement") else "")
        cmd += ["-font", font(), "-pointsize", "34", "-annotate", "+12+40", label]
    run(cmd + [out])
    return out


def montage(tiles, dest, columns=2, width=1500):
    cmd = ["magick", "montage"] + tiles + ["-tile", "%dx" % columns,
                                           "-geometry", "+6+6", "-background", "#222"]
    if font():
        cmd += ["-font", font()]
    run(cmd + [dest])
    run(["magick", dest, "-resize", "%dx" % width, dest])


def grid(src, W, H, cx, cy, work, span=900):
    """A labelled pixel grid, for reading an exact position off the image."""
    x0 = max(0, min(W - span, int(cx * W - span / 2)))
    y0 = max(0, min(H - span, int(cy * H - span / 2)))
    draws, labels = [], []
    for gx in range(0, span + 1, 100):
        draws += ["-draw", "line %d,0 %d,%d" % (gx, gx, span)]
        labels += ["-annotate", "+%d+14" % (gx + 3), str(x0 + gx)]
    for gy in range(0, span + 1, 100):
        draws += ["-draw", "line 0,%d %d,%d" % (gy, span, gy)]
        if gy:
            labels += ["-annotate", "+2+%d" % (gy - 4), str(y0 + gy)]
    dest = os.path.join(work, "grid.png")
    cmd = ["magick", src, "-crop", "%dx%d+%d+%d" % (span, span, x0, y0), "+repage",
           "-stroke", "rgba(255,0,0,0.35)", "-strokewidth", "1"] + draws + \
          ["-stroke", "none", "-fill", "red"]
    if font():
        cmd += ["-font", font(), "-pointsize", "15"] + labels
    run(cmd + [dest])
    print("grid centred on %.4f,%.4f -- divide a read pixel by %d (x) or %d (y)"
          % (cx, cy, W, H))
    return dest


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("assembly")
    ap.add_argument("space", help="board, or sh1 / sh2 / ... for a schematic sheet")
    ap.add_argument("--refs", nargs="*", help="designators to render")
    ap.add_argument("--tier", help="render every marker of this confidence tier")
    ap.add_argument("--grid", nargs=2, type=float, metavar=("X", "Y"),
                    help="overlay a pixel grid at this normalised position")
    ap.add_argument("--limit", type=int, default=8, help="markers per sheet (default 8)")
    ap.add_argument("--size", nargs=2, type=int, default=[820, 560], metavar=("W", "H"))
    ap.add_argument("--proposed", metavar="JSON",
                    help="render geometry from a proposal file of drawing pixels "
                         "({ref: {x, y, w, h, shape}}) instead of the built "
                         "coordinates, so it can be looked at before it lands")
    args = ap.parse_args()

    asm = args.assembly.lower()
    src = spaces.require(os.path.join(ROOT, ".build", asm), args.space)
    work = os.path.join(ROOT, ".build", asm, "review")
    os.makedirs(work, exist_ok=True)
    W, H = size_of(src)

    if args.grid:
        print(grid(src, W, H, args.grid[0], args.grid[1], work))
        return

    if args.proposed:
        # A proposal is written in drawing pixels, which is what the overrides
        # file takes; normalise it here so one renderer serves both.
        raw = json.load(open(args.proposed))
        placed = {ref: dict(g, x=g["x"] / float(W), y=g["y"] / float(H),
                            w=g["w"] / float(W), h=g["h"] / float(H),
                            placement="proposed")
                  for ref, g in raw.items()}
    else:
        placed = positions(asm, args.space)
    if args.tier:
        refs = sorted(r for r, g in placed.items() if g.get("placement") == args.tier)
        if not refs:
            print("nothing at tier '%s' on %s" % (args.tier, args.space))
            return
    elif args.refs:
        refs = args.refs
    else:
        sys.exit("give --refs, --tier or --grid")

    missing = [r for r in refs if r not in placed]
    if missing:
        print("not placed on %s: %s" % (args.space, " ".join(missing)))
    refs = [r for r in refs if r in placed]

    for batch in range(0, len(refs), args.limit):
        chunk = refs[batch:batch + args.limit]
        tiles = [crop_ref(src, W, H, r, placed[r], work, args.size) for r in chunk]
        dest = os.path.join(work, "%s_%s_%02d.png" % (asm, args.space, batch // args.limit + 1))
        montage(tiles, dest)
        print("%s  (%s)" % (dest, " ".join(chunk)))


if __name__ == "__main__":
    main()
