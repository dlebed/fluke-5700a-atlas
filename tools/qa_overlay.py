#!/usr/bin/env python3
"""
qa_overlay.py — draw the placed markers back onto the source image, tiled.

Checking coordinates by reading numbers is hopeless; checking them by looking
at a marker sitting on (or next to) the label it claims is easy. This renders
exactly that picture, cut into overlapping tiles at a zoom where the silkscreen
is comfortably readable, and writes an index naming which designators each tile
should contain.

The output is what a reviewer -- human or agent -- actually looks at: for each
tile, "is every box on its own label, and is any label unboxed?"

Usage: tools/qa_overlay.py <asm> <space> [--source ocr|coords] [--tiles 6x4]
"""

import argparse
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

sys.path.insert(0, HERE)
import spaces      # noqa: E402  -- needs HERE on the path first

FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


def run(cmd):
    return subprocess.run(cmd, check=True, capture_output=True, text=True)


def load_positions(asm, space, source):
    build = os.path.join(ROOT, ".build", asm)
    if source == "ocr":
        path = os.path.join(build, "ocr_%s.json" % space)
        data = json.load(open(path))
        return {ref: hit for ref, hit in data["hits"].items()}, data["width"], data["height"]

    path = os.path.join(ROOT, "data", "%s.coords.json" % asm)
    coords = json.load(open(path))
    size = run(["magick", "identify", "-format", "%w %h",
                spaces.require(build, space)]).stdout.split()
    out = {}
    for ref, entry in coords.get("placement", {}).items():
        if space == "board":
            if entry.get("board"):
                out[ref] = dict(entry["board"], verified=entry.get("verified"))
        else:
            for occurrence in entry.get("sch", []):
                if occurrence.get("sheet") == space:
                    out[ref] = dict(occurrence, verified=entry.get("schVerified"))
    return out, int(size[0]), int(size[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("asm", nargs="?", default="a18")
    ap.add_argument("space", nargs="?", default="board")
    ap.add_argument("--source", default="ocr", choices=("ocr", "coords"))
    ap.add_argument("--tiles", default="6x4")
    ap.add_argument("--scale", type=float, default=1.0,
                    help="scale applied to each tile before saving")
    args = ap.parse_args()

    build = os.path.join(ROOT, ".build", args.asm)
    src = spaces.require(build, args.space)

    positions, W, H = load_positions(args.asm, args.space, args.source)
    nx, ny = (int(v) for v in args.tiles.lower().split("x"))

    out_dir = os.path.join(build, "qa_%s_%s" % (args.space, args.source))
    os.makedirs(out_dir, exist_ok=True)
    for stale in os.listdir(out_dir):
        os.remove(os.path.join(out_dir, stale))

    # Draw every marker once onto a full-size annotated copy, then cut it up:
    # one ImageMagick invocation beats one per tile per marker.
    mvg = [os.path.join(build, "qa_%s.mvg" % args.space)]
    lines = ["push graphic-context", "font-size 34", "stroke-width 5"]
    for ref, box in sorted(positions.items()):
        cx, cy = box["x"] * W, box["y"] * H
        bw = max(box.get("w", 0.01), 0.006) * W
        bh = max(box.get("h", 0.01), 0.006) * H
        colour = "green" if box.get("verified") else "red"
        lines.append("stroke %s fill none" % colour)
        lines.append("rectangle %.1f,%.1f %.1f,%.1f"
                     % (cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2))
        # A cross at the exact centre: the box may be generous, the centre is
        # the coordinate that actually gets stored.
        lines.append("line %.1f,%.1f %.1f,%.1f" % (cx - 12, cy, cx + 12, cy))
        lines.append("line %.1f,%.1f %.1f,%.1f" % (cx, cy - 12, cx, cy + 12))
        lines.append("stroke none fill %s" % colour)
        lines.append("text %.1f,%.1f '%s'" % (cx + bw / 2 + 6, cy - bh / 2 - 6, ref))
    lines.append("pop graphic-context")
    open(mvg[0], "w").write("\n".join(lines))

    annotated = os.path.join(build, "qa_%s_annotated.png" % args.space)
    run(["magick", src, "-colorspace", "sRGB", "-font", FONT,
         "-draw", "@" + mvg[0], annotated])

    tile_w, tile_h = W / nx, H / ny
    pad_x, pad_y = tile_w * 0.05, tile_h * 0.05
    index = {}
    for ty in range(ny):
        for tx in range(nx):
            x0 = max(0, int(tx * tile_w - pad_x))
            y0 = max(0, int(ty * tile_h - pad_y))
            x1 = min(W, int((tx + 1) * tile_w + pad_x))
            y1 = min(H, int((ty + 1) * tile_h + pad_y))
            name = "r%dc%d" % (ty + 1, tx + 1)
            path = os.path.join(out_dir, name + ".png")
            cmd = ["magick", annotated, "-crop",
                   "%dx%d+%d+%d" % (x1 - x0, y1 - y0, x0, y0), "+repage"]
            if args.scale != 1.0:
                cmd += ["-resize", "%d%%" % int(args.scale * 100)]
            run(cmd + [path])
            inside = sorted([ref for ref, b in positions.items()
                             if x0 <= b["x"] * W < x1 and y0 <= b["y"] * H < y1],
                            key=natural)
            index[name] = {
                "file": os.path.relpath(path, ROOT),
                "region": {"x0": x0, "y0": y0, "x1": x1, "y1": y1},
                "imageSize": {"w": W, "h": H},
                "refs": inside,
            }

    index_path = os.path.join(out_dir, "index.json")
    json.dump({"space": args.space, "source": args.source, "width": W, "height": H,
               "tiles": index}, open(index_path, "w"), indent=1)

    print("%d markers drawn over %s" % (len(positions), os.path.basename(src)))
    print("%d tiles in %s" % (len(index), os.path.relpath(out_dir, ROOT)))
    for name in sorted(index):
        print("  %-6s %3d refs" % (name, len(index[name]["refs"])))


def natural(ref):
    m = re.match(r"^([A-Z]+)(\d+)$", ref)
    return (m.group(1), int(m.group(2))) if m else (ref, 0)


if __name__ == "__main__":
    main()
