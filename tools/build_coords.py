#!/usr/bin/env python3
"""
build_coords.py — turn the OCR pass plus hand corrections into data/<asm>.coords.json.

Each placement carries how it was arrived at, and the app shows that: a marker
the reader placed and several passes agreed on is not the same claim as one a
single pass produced, and neither is the same as one a person put there.

  verified   placed or confirmed by hand
  agreed     several independent OCR passes landed on the same spot
  single     one pass found it, nothing corroborates it
  ambiguous  passes disagreed; the most-voted position was taken

Usage: tools/build_coords.py [assembly-id]
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

sys.path.insert(0, HERE)
import spaces      # noqa: E402  -- needs HERE on the path first

# Marker footprint for a test point in the top row: wide enough to span the
# rotated label and the pad bar to its right, tall enough to cover the text.
ROW_TP_W, ROW_TP_H = 105, 118
DEFAULT_PAD = 1.35      # OCR boxes hug the glyphs; a little margin reads better

# Outlines a marker may be drawn with. A shape is only meaningful on a hand
# placed entry: a read designator's box is the lettering, not the part, and an
# ellipse inscribed in a rotated label is a thin oval beside the component
# rather than a ring around it. So a shape has to arrive with a body box, and
# only the overrides carry those.
SHAPES = ("rect", "circle", "point")


def load(path, default=None):
    if not os.path.exists(path):
        return default
    return json.load(open(path, encoding="utf-8"))


class _Pairs(list):
    """A JSON object kept as its key/value pairs, duplicates and all."""


def duplicate_keys(path):
    """
    Every key repeated inside one JSON object, as "a.b.c" paths in file order.

    JSON parsers take the last value for a repeated key and say nothing about
    it. In a hand-edited overrides file that is silent data loss rather than a
    curiosity: paste four entries under "board" when one of those designators
    is already there and the whole object is replaced rather than merged, so
    three of the four vanish. That happened on A18, and the only symptom was
    that the markers did not appear.

    object_pairs_hook is the one point where the duplicate still exists -- but
    it fires innermost-first with no idea where it is in the file, so it is
    used only to *preserve* the pairs, and the tree is walked afterwards to
    attach a path to each one.
    """
    tree = json.load(open(path, encoding="utf-8"), object_pairs_hook=_Pairs)
    found = []

    def walk(node, trail):
        if isinstance(node, _Pairs):
            seen = set()
            for key, value in node:
                where = trail + [key]
                if key in seen:
                    found.append(".".join(where))
                seen.add(key)
                walk(value, where)
        elif isinstance(node, list):
            for i, value in enumerate(node):
                walk(value, trail + ["[%d]" % i])

    walk(tree, [])
    return found


def build(asm):
    build_dir = os.path.join(ROOT, ".build", asm)
    ocr = load(os.path.join(build_dir, "ocr_board.json"))
    if not ocr:
        sys.exit("no OCR pass for %s -- run tools/ocr_designators.py first" % asm)
    over_path = os.path.join(ROOT, "data", "%s.coords.overrides.json" % asm)
    if os.path.exists(over_path):
        repeated = duplicate_keys(over_path)
        if repeated:
            sys.exit("data/%s.coords.overrides.json repeats %d key%s, and JSON "
                     "keeps only the last of each:\n    %s\nMerge them by hand -- "
                     "the earlier entries are being discarded."
                     % (asm, len(repeated), "" if len(repeated) == 1 else "s",
                        "\n    ".join(repeated)))
    over = load(over_path, {}) or {}

    W, H = ocr["width"], ocr["height"]
    size = over.get("imageSize", {})
    if size and (size.get("w") != W or size.get("h") != H):
        sys.exit("overrides were measured against %sx%s but the drawing is %dx%d"
                 % (size.get("w"), size.get("h"), W, H))

    dropped = set(over.get("drop", []))
    not_on_drawing = set(over.get("notOnDrawing", []))
    manual = over.get("board", {})

    placement = {}
    counts = {"verified": 0, "agreed": 0, "single": 0, "ambiguous": 0, "collision": 0}

    for ref, hit in ocr["hits"].items():
        if ref in dropped or ref in manual:
            continue
        placement[ref] = {
            "board": {
                "x": hit["x"], "y": hit["y"],
                "w": round(hit["w"] * DEFAULT_PAD, 5),
                "h": round(hit["h"] * DEFAULT_PAD, 5),
                "shape": "rect",
            },
            "placement": hit["confidence"],
        }
        counts[hit["confidence"]] = counts.get(hit["confidence"], 0) + 1

    shaped = 0
    for ref, box in manual.items():
        w = box.get("w", ROW_TP_W if box.get("row") else 110)
        h = box.get("h", ROW_TP_H if box.get("row") else 115)
        shape = box.get("shape", "rect")
        if shape not in SHAPES:
            sys.exit("%s declares shape '%s'; known shapes are %s"
                     % (ref, shape, ", ".join(SHAPES)))
        entry = {
            "board": {
                "x": round(box["x"] / W, 5), "y": round(box["y"] / H, 5),
                "w": round(w / W, 5), "h": round(h / H, 5),
                "shape": shape,
            },
            "verified": True,
            "placement": "verified",
        }
        if box.get("note"):
            entry["placementNote"] = box["note"]
        placement[ref] = entry
        counts["verified"] += 1
        if shape != "rect":
            shaped += 1

    # Schematic sheets go through the same reader. A part is normally drawn on
    # exactly one sheet, so each hit becomes one occurrence; a part found on
    # both sheets legitimately gets two.
    sheet_drop = over.get("dropSchematic", {})
    rule = over.get("schematicSheetRule") or {}
    sheet_counts = {}
    wrong_sheet = 0

    def expected_sheet(ref):
        """Which sheet this designator can be on, or None if unconstrained."""
        if ref in (rule.get("exceptions") or {}):
            return rule["exceptions"][ref]
        threshold = rule.get("threshold")
        if threshold is None:
            return None
        digits = re.sub(r"\D", "", ref)
        if not digits:
            return None
        return rule["atOrAbove"] if int(digits) >= threshold else rule["below"]

    legend_skips = []
    legend_only = set()
    manual_sch = 0

    for sheet in spaces.sheet_spaces(build_dir):
        sheet_ocr = load(os.path.join(build_dir, "ocr_%s.json" % sheet))
        if not sheet_ocr:
            continue
        dropped_here = set(sheet_drop.get(sheet, []))
        legend = legend_box(sheet_ocr["hits"])
        placed_here = 0
        for ref, hit in sheet_ocr["hits"].items():
            if ref in dropped_here or hit["confidence"] in ("collision",):
                continue
            if ref.startswith("TP"):
                hit, note = on_the_net(hit, legend)
                if note:
                    legend_skips.append("%s/%s" % (sheet, ref))
                    legend_only.add(ref)
            want = expected_sheet(ref)
            if want and want != sheet:
                wrong_sheet += 1
                continue
            entry = placement.setdefault(ref, {})
            entry.setdefault("sch", []).append({
                "sheet": sheet,
                "x": hit["x"], "y": hit["y"],
                "w": round(hit["w"] * DEFAULT_PAD, 5),
                "h": round(hit["h"] * DEFAULT_PAD, 5),
                "placement": hit["confidence"],
            })
            placed_here += 1
        # Hand placements win over anything read, exactly as on the board. A
        # test point is written twice on a sheet and the reader cannot always
        # tell which is which -- TP9's label scans as "TPS", which is TP5 --
        # so the ones that matter are placed by eye and recorded here.
        manual_here = (over.get("schematic") or {}).get(sheet, {})
        sw, sh = sheet_ocr["width"], sheet_ocr["height"]
        # Two sheets of one figure are not necessarily the same size: A17's were
        # scanned about 3% apart and are cropped separately, so the declaration
        # may be one {w,h} for both sheets or one per sheet id.
        declared = over.get("sheetImageSize", {})
        declared = declared.get(sheet, declared) if declared else {}
        if manual_here and declared and (declared.get("w") != sw or declared.get("h") != sh):
            sys.exit("schematic overrides for %s were measured against %sx%s but it is %dx%d"
                     % (sheet, declared.get("w"), declared.get("h"), sw, sh))
        for ref, box in manual_here.items():
            entry = placement.setdefault(ref, {})
            occurrence = {
                "sheet": sheet,
                "x": round(box["x"] / sw, 5), "y": round(box["y"] / sh, 5),
                "w": round(box.get("w", 95) / sw, 5),
                "h": round(box.get("h", 36) / sh, 5),
                "placement": "verified",
            }
            if box.get("note"):
                occurrence["placementNote"] = box["note"]
            others = [s for s in entry.get("sch", []) if s.get("sheet") != sheet]
            entry["sch"] = others + [occurrence]
            entry["schVerified"] = True
            manual_sch += 1
            if ref in legend_only:
                legend_only.discard(ref)
                placed_here += 1

        sheet_counts[sheet] = placed_here

    coords = {
        "assembly": asm.upper(),
        "generatedBy": "tools/build_coords.py",
        "notOnDrawing": sorted(not_on_drawing, key=sort_key),
        "placement": placement,
        "layers": {},
        "sheets": over.get("sheets", {}),
    }

    # Layer alignment: solve a homography from whatever landmark pairs the
    # overrides give, so the file records the correspondences a person can
    # check rather than nine opaque matrix entries.
    for layer_id, spec in (over.get("layers") or {}).items():
        pairs = spec.get("landmarks") or []
        entry = {"landmarks": pairs}
        if spec.get("approximate"):
            entry["approximate"] = True
        matrix = solve_homography(pairs)
        if matrix:
            entry["transform"] = {"H": matrix}
        else:
            print("  WARNING: %s needs at least 4 usable landmarks to align" % layer_id)
        coords["layers"][layer_id] = entry

    existing = load(os.path.join(ROOT, "data", "%s.coords.json" % asm), {}) or {}
    if existing.get("layers") and not coords["layers"]:
        coords["layers"] = existing["layers"]
    if not coords["sheets"] and existing.get("sheets"):
        coords["sheets"] = existing["sheets"]

    path = os.path.join(ROOT, "data", "%s.coords.json" % asm)
    json.dump(coords, open(path, "w"), indent=1)

    total = len(placement)
    print("wrote data/%s.coords.json" % asm)
    print("  board: placed %d, plus %d parts with no silkscreen on the drawing"
          % (sum(1 for e in placement.values() if e.get("board")), len(not_on_drawing)))
    for tier in ("verified", "agreed", "ambiguous", "single", "collision"):
        if counts.get(tier):
            print("    %-10s %3d" % (tier, counts[tier]))
    if shaped:
        print("    %-10s %3d  (drawn round rather than as a box)"
              % ("circle", shaped))
    for sheet, n in sorted(sheet_counts.items()):
        print("  %s: placed %d" % (sheet, n))
    if wrong_sheet:
        print("  dropped %d reads that put a part on the wrong sheet" % wrong_sheet)
    if manual_sch:
        print("  %d schematic positions placed by hand" % manual_sch)
    legend_skips = [s for s in legend_skips if s.split("/")[1] in legend_only]
    if legend_skips:
        # Not a failure, but not the answer either: these point at the table
        # that names the signal rather than the net you would probe.
        print("  %d test points found only in the legend table, not on a net:"
              % len(legend_skips))
        print("    " + " ".join(sorted(legend_skips)))


def legend_box(hits):
    """
    Where the sheet's test point legend sits, found from the reads themselves.

    Every test point is written twice on a schematic: once in the table that
    says what its signal is called, and once beside the symbol on the net. The
    table gives itself away -- a stack of TP labels sharing an x to within a
    hair, marching evenly down the page -- so it can be located without a
    hand-measured rectangle per sheet, which would need remeasuring for every
    new assembly.

    Returns (x0, y0, x1, y1) in normalised sheet space, or None.
    """
    points = []
    for ref, hit in hits.items():
        if not ref.startswith("TP"):
            continue
        points.append((hit["x"], hit["y"]))
        for alt in hit.get("alternates", []):
            points.append((alt["x"], alt["y"]))
    if not points:
        return None

    columns = {}
    for x, y in points:
        columns.setdefault(round(x, 2), []).append((x, y))
    column = max(columns.values(), key=len)
    if len(column) < 5:            # a handful in a line is not a table
        return None

    xs = [p[0] for p in column]
    ys = [p[1] for p in column]
    pad = 0.02
    return (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)


def on_the_net(hit, legend):
    """
    Prefer the reading beside the symbol over the one in the legend table.

    Someone looking up a test point on the schematic wants the net they are
    about to put a probe on, not the row of the table that spells out its
    name -- the table tells you nothing about where the circuit is.
    """
    if not legend:
        return hit, False

    def inside(p):
        return legend[0] <= p["x"] <= legend[2] and legend[1] <= p["y"] <= legend[3]

    if not inside(hit):
        return hit, False

    # Best-voted candidate that is not in the table.
    outside = [a for a in hit.get("alternates", []) if not inside(a)]
    if not outside:
        return hit, True           # only ever seen in the table
    pick = max(outside, key=lambda a: (a.get("votes", 0), a.get("conf", 0)))
    out = dict(hit)
    out.update({"x": pick["x"], "y": pick["y"],
                "w": pick.get("w", hit["w"]), "h": pick.get("h", hit["h"]),
                "conf": pick.get("conf", hit.get("conf")),
                "votes": pick.get("votes", 1)})
    # It was read somewhere else as well, so it is worth a second look however
    # many passes agreed on the table row.
    out["confidence"] = "agreed" if pick.get("votes", 0) >= 3 else "single"
    return out, False


def sort_key(ref):
    return (re.sub(r"\d", "", ref), int(re.sub(r"\D", "", ref) or 0))


def solve_homography(pairs):
    """
    Least-squares 3x3 homography mapping src to dst. Mirrors Geom.solveHomography
    in js/geom.js so the build and Author Mode agree on what a set of landmarks
    means. Needs four pairs; more are averaged.
    """
    if len(pairs) < 4:
        return None
    ata = [[0.0] * 9 for _ in range(8)]
    for pair in pairs:
        x, y = pair["src"]
        u, v = pair["dst"]
        for row in ([x, y, 1, 0, 0, 0, -u * x, -u * y, u],
                    [0, 0, 0, x, y, 1, -v * x, -v * y, v]):
            for r in range(8):
                for c in range(9):
                    ata[r][c] += row[r] * row[c]

    # Gaussian elimination with partial pivoting.
    n = 8
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(ata[r][col]))
        if abs(ata[pivot][col]) < 1e-12:
            return None
        ata[col], ata[pivot] = ata[pivot], ata[col]
        for r in range(n):
            if r == col:
                continue
            factor = ata[r][col] / ata[col][col]
            for c in range(col, n + 1):
                ata[r][c] -= factor * ata[col][c]
    h = [ata[i][n] / ata[i][i] for i in range(n)]
    return [round(v, 9) for v in h] + [1.0]


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "a18")
